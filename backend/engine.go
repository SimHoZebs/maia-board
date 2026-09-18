package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	workerStartWait = 300 * time.Second
	workerMoveWait  = 120 * time.Second
	maxMultiPV      = 5
	workerLineLimit = 64 * 1024
)

var (
	ErrWorkerBusy       = errors.New("engine worker is busy")
	ErrProtocol         = errors.New("engine protocol error")
	ErrPositionMismatch = errors.New("position mismatch")
	ErrInvalidPosition  = errors.New("invalid position")
	ErrNoLegalMoves     = errors.New("position has no legal moves")
	// ErrJoined reports that a deterministic duplicate joined the owner's
	// inference at the scheduler. The caller must re-read the cache: the
	// owner stores its result before releasing the slot.
	ErrJoined = errors.New("duplicate request joined")
)

// Bounded waits for synchronous admission. Batch work waits without a
// deadline on a detached context instead; vars (not consts) so tests shrink
// them without touching production budgets.
var (
	syncWaitPlay  = 30 * time.Second
	syncWaitFocus = 10 * time.Second
)

func syncWait(prio Priority) time.Duration {
	if prio == PriorityPlay {
		return syncWaitPlay
	}
	return syncWaitFocus
}

type EngineRequest struct {
	FEN         string   `json:"fen"`
	Moves       []string `json:"moves"`
	InitialFEN  string   `json:"initial_fen"`
	SelfElo     int      `json:"self_elo"`
	OppoElo     int      `json:"oppo_elo"`
	Temperature float64  `json:"temperature"`
}
type Candidate struct {
	Move   string     `json:"move"`
	Policy float64    `json:"policy"`
	WDL    [3]float64 `json:"wdl"`
}
type EngineResult struct {
	Move       string      `json:"move"`
	Candidates []Candidate `json:"candidates"`
	WDL        [3]float64  `json:"wdl"`
}
type workerState string

const (
	stateUnloaded workerState = "unloaded"
	stateStarting workerState = "starting"
	stateReady    workerState = "ready"
	stateBusy     workerState = "busy"
	stateFailed   workerState = "failed"
)

type WorkerStatus struct {
	State     workerState `json:"state"`
	LastError string      `json:"last_error,omitempty"`
}
type predictor interface {
	predict(waitCtx, execCtx context.Context, prio Priority, submitSeq uint64, request EngineRequest) (EngineResult, func(), error)
	snapshot() WorkerStatus
}
type workerProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}
type workerOperation struct {
	key       string
	grant     *Grant
	done      chan struct{}
	abandoned atomic.Bool
	result    EngineResult
	err       error
}

// One operation owns the process and slot independently of its HTTP waiters.
// Scheduler dedup joins deterministic duplicates before they reach the
// worker; sampled requests never join.
type Worker struct {
	name                string
	command             []string
	startWait, moveWait time.Duration
	sched               *Scheduler
	mu                  sync.Mutex
	stateMu             sync.RWMutex
	proc                *workerProcess
	state               workerState
	last                string
	busy                bool
}

func NewWorker(name string, command []string) *Worker {
	return &Worker{name: name, command: append([]string(nil), command...), startWait: workerStartWait, moveWait: workerMoveWait, sched: NewScheduler(), state: stateUnloaded}
}
func (w *Worker) snapshot() WorkerStatus {
	w.stateMu.RLock()
	defer w.stateMu.RUnlock()
	state := w.state
	if w.busy {
		state = stateBusy
	}
	return WorkerStatus{State: state, LastError: sanitizeError(w.last)}
}
func (w *Worker) setBusy(busy bool) {
	w.stateMu.Lock()
	w.busy = busy
	w.stateMu.Unlock()
}

// predict admits through the priority scheduler, then runs one inference.
// waitCtx bounds queue waiting (and dequeues on disconnect); execCtx bounds
// waiting for the operation itself. submitSeq orders batch-lane tickets
// (rotation groups); sync callers pass 0, the sentinel excluded from the
// scan. The returned release must be
// called exactly once after the caller persists the result (nil when there is
// nothing to persist: acquire failure, join, or caller abandonment).
func (w *Worker) predict(waitCtx, execCtx context.Context, prio Priority, submitSeq uint64, request EngineRequest) (EngineResult, func(), error) {
	if err := waitCtx.Err(); err != nil {
		return EngineResult{}, nil, err
	}
	request.Moves = append([]string{}, request.Moves...)
	data, err := json.Marshal(request)
	if err != nil || len(data) > workerLineLimit {
		return EngineResult{}, nil, ErrInvalidPosition
	}
	key := ""
	if request.Temperature == 0 {
		key, _ = maiaIdentity(request, w.name).coordinates()
	}
	// Sync lanes bound their queue wait; batch work waits until granted or
	// cancelled, since it runs detached without a client deadline.
	wait := waitCtx
	cancel := context.CancelFunc(func() {})
	if prio != PriorityBatch {
		wait, cancel = context.WithTimeout(waitCtx, syncWait(prio))
	}
	grant, joined, err := w.sched.Acquire(wait, prio, key, submitSeq)
	cancel()
	if err != nil {
		switch {
		case errors.Is(err, ErrSchedulerBusy):
			return EngineResult{}, nil, ErrWorkerBusy
		case errors.Is(err, ErrSuperseded):
			return EngineResult{}, nil, err
		case waitCtx.Err() != nil:
			return EngineResult{}, nil, waitCtx.Err()
		default:
			return EngineResult{}, nil, ErrWorkerBusy
		}
	}
	if joined {
		return EngineResult{}, nil, ErrJoined
	}
	w.setBusy(true)
	release := func() {
		w.sched.Release(grant)
		w.setBusy(false)
	}
	op := &workerOperation{key: key, grant: grant, done: make(chan struct{})}
	go func() {
		w.mu.Lock()
		op.result, op.err = w.predictLocked(context.Background(), request)
		w.mu.Unlock()
		// done's close publishes result/err to the waiter; abandoned is
		// atomic because the waiter may set it concurrently on disconnect.
		if op.abandoned.Load() {
			w.sched.Release(op.grant)
			w.setBusy(false)
		}
		close(op.done)
	}()
	completed := func() (EngineResult, func(), error) {
		result := op.result
		result.Candidates = append([]Candidate(nil), result.Candidates...)
		if op.err != nil {
			return EngineResult{}, release, op.err
		}
		return result, release, nil
	}
	select {
	case <-execCtx.Done():
		// Completion and cancellation race: a closed op wins so a ready
		// result is never discarded.
		select {
		case <-op.done:
			return completed()
		default:
			op.abandoned.Store(true)
			return EngineResult{}, nil, execCtx.Err()
		}
	case <-op.done:
		return completed()
	}
}
func (w *Worker) predictLocked(parent context.Context, request EngineRequest) (EngineResult, error) {
	if w.proc == nil {
		w.setState(stateStarting)
		ctx, cancel := context.WithTimeout(parent, w.startWait)
		err := w.startLocked(ctx)
		cancel()
		if err != nil {
			w.failLocked(err)
			return EngineResult{}, err
		}
	}
	ctx, cancel := context.WithTimeout(parent, w.moveWait)
	defer cancel()
	data, err := json.Marshal(request)
	if err == nil {
		err = w.sendLocked(ctx, string(data))
	}
	if err != nil {
		w.failLocked(err)
		return EngineResult{}, err
	}
	line, err := w.readLineLocked(ctx)
	if err != nil {
		w.failLocked(err)
		return EngineResult{}, err
	}
	var reply struct {
		Result     *EngineResult `json:"result,omitempty"`
		Error      *apiError     `json:"error,omitempty"`
		LegalCount int           `json:"legal_count"`
	}
	decoder := json.NewDecoder(strings.NewReader(line))
	decoder.DisallowUnknownFields()
	// Decode already rejects invalid JSON; no separate json.Valid re-decode.
	if err := decoder.Decode(&reply); err != nil || (reply.Result == nil) == (reply.Error == nil) {
		w.failLocked(ErrProtocol)
		return EngineResult{}, ErrProtocol
	}
	if reply.Error != nil {
		switch reply.Error.Code {
		case "position_mismatch":
			return EngineResult{}, ErrPositionMismatch
		case "invalid_position", "invalid_fen":
			return EngineResult{}, ErrInvalidPosition
		case "game_over":
			return EngineResult{}, ErrNoLegalMoves
		default:
			err := fmt.Errorf("%w: %s", ErrProtocol, sanitizeError(reply.Error.Message))
			w.failLocked(err)
			return EngineResult{}, err
		}
	}
	var document any
	if json.Unmarshal([]byte(line), &document) != nil {
		w.failLocked(ErrProtocol)
		return EngineResult{}, ErrProtocol
	}
	// Validate the raw result subtree through the single strict path before
	// trusting the outer-typed copy: encoding/json pads/truncates wdl arrays
	// and silences nulls, so lengths and nulls are checked on raw JSON.
	raw, ok := document.(map[string]any)
	if !ok {
		w.failLocked(ErrProtocol)
		return EngineResult{}, ErrProtocol
	}
	typed, ok := decodeStrictValue[EngineResult](raw["result"], engineResultRequired, nil)
	if !ok || !validEngineResult(typed, reply.LegalCount, request.Temperature == 0) {
		w.failLocked(ErrProtocol)
		return EngineResult{}, ErrProtocol
	}
	return typed, nil
}
func validEngineResult(result EngineResult, legalCount int, deterministic bool) bool {
	if legalCount < 1 || legalCount > 218 || len(result.Candidates) != min(legalCount, maxMultiPV) || !validWDL(result.WDL) {
		return false
	}
	value := moveResponse{Move: result.Move, WDL: result.WDL, ModelUsed: "79m"}
	for _, c := range result.Candidates {
		if !validWDL(c.WDL) {
			return false
		}
		value.TopMoves = append(value.TopMoves, topMove{Move: c.Move, Prob: c.Policy, WDL: c.WDL})
	}
	return result.WDL == result.Candidates[0].WDL && validMoveValue(value, "79m", deterministic)
}
func (w *Worker) startLocked(ctx context.Context) error {
	if len(w.command) == 0 {
		return fmt.Errorf("%w: empty command", ErrProtocol)
	}
	cmd := exec.Command(w.command[0], w.command[1:]...)
	cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = newWorkerDiagnostics(w.name)
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return err
	}
	w.proc = &workerProcess{cmd: cmd, stdin: stdin, stdout: bufio.NewReaderSize(stdout, workerLineLimit)}
	line, err := w.readLineLocked(ctx)
	if err != nil {
		return err
	}
	var ready struct {
		Ready bool `json:"ready"`
	}
	if json.Unmarshal([]byte(line), &ready) != nil || !ready.Ready {
		return fmt.Errorf("%w: missing ready marker", ErrProtocol)
	}
	w.setState(stateReady)
	w.setLast("")
	return nil
}
func (w *Worker) sendLocked(ctx context.Context, line string) error {
	if len(line) > workerLineLimit {
		return ErrProtocol
	}
	proc := w.proc
	done := make(chan error, 1)
	go func() { _, err := io.WriteString(proc.stdin, line+"\n"); done <- err }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return fmt.Errorf("%w: write timeout", ErrProtocol)
	}
}
func (w *Worker) readLineLocked(ctx context.Context) (string, error) {
	proc := w.proc
	type response struct {
		line string
		err  error
	}
	done := make(chan response, 1)
	go func() { line, err := proc.stdout.ReadSlice('\n'); done <- response{string(line), err} }()
	select {
	case r := <-done:
		if r.err != nil {
			return "", fmt.Errorf("%w: read: %v", ErrProtocol, r.err)
		}
		return r.line, nil
	case <-ctx.Done():
		return "", fmt.Errorf("%w: read timeout", ErrProtocol)
	}
}
func (w *Worker) failLocked(err error) {
	w.setLast(err.Error())
	w.setState(stateFailed)
	w.stopProcessLocked()
}
func (w *Worker) setState(state workerState) { w.stateMu.Lock(); w.state = state; w.stateMu.Unlock() }
func (w *Worker) setLast(last string) {
	w.stateMu.Lock()
	w.last = sanitizeError(last)
	w.stateMu.Unlock()
}
func (w *Worker) stopProcessLocked() {
	if w.proc == nil {
		return
	}
	proc := w.proc
	w.proc = nil
	_ = proc.stdin.Close()
	if proc.cmd.Process != nil {
		_ = syscall.Kill(-proc.cmd.Process.Pid, syscall.SIGKILL)
	}
	_ = proc.cmd.Wait()
	cleanupEvaluationGroup(proc.cmd.Process.Pid)
}
func (w *Worker) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopProcessLocked()
	w.setState(stateUnloaded)
}
func sanitizeError(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if len(value) > 160 {
		return value[:160]
	}
	return value
}

type EnginePool struct{ large, small predictor }

func NewEnginePool(large, small predictor) *EnginePool {
	return &EnginePool{large: large, small: small}
}
func (p *EnginePool) predict(waitCtx, execCtx context.Context, prio Priority, submitSeq uint64, model string, request EngineRequest) (EngineResult, func(), string, bool, error) {
	if model == "5m" {
		result, release, err := p.small.predict(waitCtx, execCtx, prio, submitSeq, request)
		return result, release, "5m", false, err
	}
	result, release, err := p.large.predict(waitCtx, execCtx, prio, submitSeq, request)
	if err == nil {
		return result, release, "79m", false, nil
	}
	// The worker returns a release with operation errors (nothing was
	// stored); free it here since the caller only releases on success.
	// Joins and admission failures carry no grant.
	if release != nil {
		release()
	}
	if errors.Is(err, ErrWorkerBusy) || errors.Is(err, ErrJoined) || errors.Is(err, ErrSuperseded) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrPositionMismatch) || errors.Is(err, ErrInvalidPosition) || errors.Is(err, ErrNoLegalMoves) {
		return EngineResult{}, nil, "", false, err
	}
	result, release, fallbackErr := p.small.predict(waitCtx, execCtx, prio, submitSeq, request)
	if fallbackErr != nil {
		if release != nil {
			release()
		}
		return EngineResult{}, nil, "", false, fmt.Errorf("engine fallback failed: %w", errors.Join(err, fallbackErr))
	}
	return result, release, "5m", true, nil
}

func (p *EnginePool) health() (string, map[string]WorkerStatus, int) {
	large, small := p.large.snapshot(), p.small.snapshot()
	status, code := "ok", 200
	if large.State == stateFailed && small.State == stateFailed {
		status, code = "unavailable", 503
	} else if large.State == stateFailed || small.State == stateFailed {
		status = "degraded"
	}
	return status, map[string]WorkerStatus{"79m": large, "5m": small}, code
}
