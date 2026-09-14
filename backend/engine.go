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
	"syscall"
	"time"
)

const (
	workerAcquireWait = 100 * time.Millisecond
	workerStartWait   = 300 * time.Second
	workerMoveWait    = 120 * time.Second
	maxMultiPV        = 5
	workerLineLimit   = 64 * 1024
)

var (
	ErrWorkerBusy       = errors.New("engine worker is busy")
	ErrProtocol         = errors.New("engine protocol error")
	ErrPositionMismatch = errors.New("position mismatch")
	ErrInvalidPosition  = errors.New("invalid position")
	ErrNoLegalMoves     = errors.New("position has no legal moves")
)

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
	predict(context.Context, EngineRequest) (EngineResult, error)
	snapshot() WorkerStatus
}
type workerProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}
type workerOperation struct {
	key    string
	done   chan struct{}
	result EngineResult
	err    error
}

// One operation owns the process and slot independently of its HTTP waiters.
// A deterministic duplicate joins that operation; sampled requests never join.
type Worker struct {
	name                string
	command             []string
	startWait, moveWait time.Duration
	slot                chan struct{}
	mu                  sync.Mutex
	stateMu             sync.RWMutex
	proc                *workerProcess
	state               workerState
	last                string
	busy                bool
	opMu                sync.Mutex
	operation           *workerOperation
}

func NewWorker(name string, command []string) *Worker {
	return &Worker{name: name, command: append([]string(nil), command...), startWait: workerStartWait, moveWait: workerMoveWait, slot: make(chan struct{}, 1), state: stateUnloaded}
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
func (w *Worker) acquire(ctx context.Context) error {
	timer := time.NewTimer(workerAcquireWait)
	defer timer.Stop()
	select {
	case w.slot <- struct{}{}:
		w.stateMu.Lock()
		w.busy = true
		w.stateMu.Unlock()
		return nil
	case <-timer.C:
		return ErrWorkerBusy
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (w *Worker) release() {
	w.stateMu.Lock()
	w.busy = false
	w.stateMu.Unlock()
	<-w.slot
}
func (w *Worker) predict(ctx context.Context, request EngineRequest) (EngineResult, error) {
	if err := ctx.Err(); err != nil {
		return EngineResult{}, err
	}
	request.Moves = append([]string{}, request.Moves...)
	data, err := json.Marshal(request)
	if err != nil || len(data) > workerLineLimit {
		return EngineResult{}, ErrInvalidPosition
	}
	key := string(data)
	if request.Temperature == 0 {
		_, key = maiaIdentity(request, w.name).coordinates()
	}
	w.opMu.Lock()
	op := w.operation
	if op != nil && request.Temperature == 0 && op.key == key {
		w.opMu.Unlock()
		return awaitOperation(ctx, op)
	}
	w.opMu.Unlock()
	if err := w.acquire(ctx); err != nil {
		return EngineResult{}, err
	}
	op = &workerOperation{key: key, done: make(chan struct{})}
	w.opMu.Lock()
	w.operation = op
	w.opMu.Unlock()
	go func() {
		w.mu.Lock()
		op.result, op.err = w.predictLocked(context.Background(), request)
		w.mu.Unlock()
		w.opMu.Lock()
		w.operation = nil
		w.release()
		close(op.done)
		w.opMu.Unlock()
	}()
	return awaitOperation(ctx, op)
}
func awaitOperation(ctx context.Context, op *workerOperation) (EngineResult, error) {
	select {
	case <-ctx.Done():
		return EngineResult{}, ctx.Err()
	case <-op.done:
		result := op.result
		result.Candidates = append([]Candidate(nil), result.Candidates...)
		return result, op.err
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
	if err := decoder.Decode(&reply); err != nil || !json.Valid([]byte(line)) || (reply.Result == nil) == (reply.Error == nil) {
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
		value.TopMoves = append(value.TopMoves, topMove{Move: c.Move, Prob: c.Policy})
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
func (p *EnginePool) predict(ctx context.Context, model string, request EngineRequest) (EngineResult, string, bool, error) {
	if model == "5m" {
		result, err := p.small.predict(ctx, request)
		return result, "5m", false, err
	}
	result, err := p.large.predict(ctx, request)
	if err == nil {
		return result, "79m", false, nil
	}
	if errors.Is(err, ErrWorkerBusy) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrPositionMismatch) || errors.Is(err, ErrInvalidPosition) || errors.Is(err, ErrNoLegalMoves) {
		return EngineResult{}, "", false, err
	}
	result, fallbackErr := p.small.predict(ctx, request)
	if fallbackErr != nil {
		return EngineResult{}, "", false, fmt.Errorf("engine fallback failed: %w", errors.Join(err, fallbackErr))
	}
	return result, "5m", true, nil
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
