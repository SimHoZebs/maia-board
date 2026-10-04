package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/evalcache"
	"maia-board/backend/internal/ipc"
	"maia-board/backend/internal/sched"
)

const (
	workerStartWait = 300 * time.Second
	workerMoveWait  = 120 * time.Second
	maxMultiPV      = 5
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
// deadline on a detached context instead. Vars (not consts) so tests shrink
// them without touching production budgets; cross-package admission tests
// use these directly.
var (
	syncWaitPlay  = 30 * time.Second
	SyncWaitFocus = 10 * time.Second
)

func syncWait(prio sched.Priority) time.Duration {
	if prio == sched.PriorityPlay {
		return syncWaitPlay
	}
	return SyncWaitFocus
}

type MaiaRequest struct {
	FEN          string   `json:"fen"`
	Moves        []string `json:"moves"`
	InitialFEN   string   `json:"initial_fen"`
	SelfElo      int      `json:"self_elo"`
	OppoElo      int      `json:"oppo_elo"`
	ValueSelfElo *int     `json:"value_self_elo,omitempty"`
	ValueOppoElo *int     `json:"value_oppo_elo,omitempty"`
	Temperature  float64  `json:"temperature"`
}
type MaiaCandidate struct {
	Move   string     `json:"move"`
	Policy float64    `json:"policy"`
	WDL    [3]float64 `json:"wdl"`
}
type MaiaResult struct {
	Move       string          `json:"move"`
	Candidates []MaiaCandidate `json:"candidates"`
	WDL        [3]float64      `json:"wdl"`
	// WaitMs is admission queue wait in ms. Internal only (never
	// serialized to clients or the cache); -1 means admission was
	// never reached (cache hit or pre-admission error).
	WaitMs int64 `json:"-"`
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

// Predictor admits and runs one inference. Worker and Pool implement it;
// tests stub it. Predict's release must be called exactly once after the
// caller persists the result (nil when there is nothing to persist).
type Predictor interface {
	Predict(waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64, request MaiaRequest) (MaiaResult, func(), error)
	WorkerStatus() WorkerStatus
}
type workerProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}
type maiaInflight struct {
	key       string
	grant     *sched.Grant
	done      chan struct{}
	abandoned atomic.Bool
	result    MaiaResult
	err       error
}

// One operation owns the process and slot independently of its HTTP waiters.
// Scheduler dedup joins deterministic duplicates before they reach the
// worker; sampled requests never join.
type Worker struct {
	name                string
	command             []string
	startWait, moveWait time.Duration
	sched               *sched.Scheduler
	mu                  sync.Mutex
	stateMu             sync.RWMutex
	proc                *workerProcess
	state               workerState
	last                string
	busy                bool
	// idleTimeout unloads the GPU model after this long without a completed
	// inference. Zero disables eviction. lastActive is the last admission
	// or completion time; the reaper in main.go sweeps idle workers.
	idleMu      sync.Mutex
	idleTimeout time.Duration
	lastActive  time.Time
}

func NewWorker(name string, command []string) *Worker {
	return &Worker{name: name, command: append([]string(nil), command...), startWait: workerStartWait, moveWait: workerMoveWait, sched: sched.NewScheduler(), state: stateUnloaded, lastActive: time.Now()}
}

// SetIdleTimeout configures GPU unload after d of inactivity. Zero or
// negative disables eviction.
func (w *Worker) SetIdleTimeout(d time.Duration) {
	w.idleMu.Lock()
	defer w.idleMu.Unlock()
	w.idleTimeout = d
	if w.lastActive.IsZero() {
		w.lastActive = time.Now()
	}
}

func (w *Worker) markUsed() {
	w.idleMu.Lock()
	w.lastActive = time.Now()
	w.idleMu.Unlock()
}

// tryUnloadIdle stops a warm but unused worker process, freeing its GPU
// memory. It returns true when it evicted. It never interrupts a running or
// queued operation: scheduler idleness plus a TryLock on the operation mutex
// gate the unload, with a lastActive re-check after the lock to avoid
// evicting a request that arrived concurrently.
func (w *Worker) tryUnloadIdle(now time.Time) bool {
	return w.tryUnloadIdleWithIdle(now, w.sched.Idle)
}

// tryUnloadIdleWithIdle shares the eviction logic between standalone workers
// (idle = own scheduler) and pool replicas (idle = pool scheduler).
func (w *Worker) tryUnloadIdleWithIdle(now time.Time, idle func() bool) bool {
	w.idleMu.Lock()
	timeout := w.idleTimeout
	last := w.lastActive
	w.idleMu.Unlock()
	if timeout <= 0 {
		return false
	}
	if now.Sub(last) < timeout {
		return false
	}
	if !idle() {
		return false
	}
	if !w.mu.TryLock() {
		return false
	}
	defer w.mu.Unlock()
	if !idle() {
		return false
	}
	if w.proc == nil {
		return false
	}
	w.idleMu.Lock()
	last = w.lastActive
	w.idleMu.Unlock()
	if now.Sub(last) < timeout {
		return false
	}
	w.stateMu.RLock()
	busy := w.busy
	w.stateMu.RUnlock()
	if busy {
		return false
	}
	timeoutStr := timeout.String()
	w.stopProcessLocked()
	w.setState(stateUnloaded)
	log.Printf("worker=%s idle timeout (%s) reached, unloaded model from GPU", w.name, timeoutStr)
	return true
}
func (w *Worker) WorkerStatus() WorkerStatus {
	w.stateMu.RLock()
	defer w.stateMu.RUnlock()
	state := w.state
	if w.busy {
		state = stateBusy
	}
	return WorkerStatus{State: state, LastError: SanitizeError(w.last)}
}
func (w *Worker) setBusy(busy bool) {
	w.stateMu.Lock()
	w.busy = busy
	w.stateMu.Unlock()
}

// Predict admits through the priority scheduler, then runs one inference.
// waitCtx bounds queue waiting (and dequeues on disconnect); execCtx bounds
// waiting for the operation itself. submitSeq orders batch-lane tickets
// (rotation groups); sync callers pass 0, the sentinel excluded from the
// scan. The returned release must be
// called exactly once after the caller persists the result (nil when there is
// nothing to persist: acquire failure, join, or caller abandonment).
func (w *Worker) Predict(waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64, request MaiaRequest) (MaiaResult, func(), error) {
	if err := waitCtx.Err(); err != nil {
		return MaiaResult{}, nil, err
	}
	request.Moves = append([]string{}, request.Moves...)
	data, err := json.Marshal(request)
	if err != nil || len(data) > ipc.LineLimit {
		return MaiaResult{}, nil, ErrInvalidPosition
	}
	key := ""
	if request.Temperature == 0 {
		key, _ = MaiaIdentity(request, w.name).Coordinates()
	}
	// Sync lanes bound their queue wait; batch work waits until granted or
	// cancelled, since it runs detached without a client deadline.
	admitStart := time.Now()
	grant, err := Admit(waitCtx, prio, w.sched, key, submitSeq)
	waitMs := time.Since(admitStart).Milliseconds()
	if err != nil {
		return MaiaResult{}, nil, err
	}
	w.markUsed()
	w.setBusy(true)
	release := func() {
		w.sched.Release(grant)
		w.setBusy(false)
	}
	op := &maiaInflight{key: key, grant: grant, done: make(chan struct{})}
	go func() {
		w.mu.Lock()
		op.result, op.err = w.predictLocked(context.Background(), request)
		w.mu.Unlock()
		w.markUsed()
		// done's close publishes result/err to the waiter; abandoned is
		// atomic because the waiter may set it concurrently on disconnect.
		if op.abandoned.Load() {
			w.sched.Release(op.grant)
			w.setBusy(false)
		}
		close(op.done)
	}()
	completed := func() (MaiaResult, func(), error) {
		result := op.result
		result.Candidates = append([]MaiaCandidate(nil), result.Candidates...)
		result.WaitMs = waitMs
		if op.err != nil {
			return MaiaResult{WaitMs: waitMs}, release, op.err
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
			return MaiaResult{}, nil, execCtx.Err()
		}
	case <-op.done:
		return completed()
	}
}
func (w *Worker) predictLocked(parent context.Context, request MaiaRequest) (MaiaResult, error) {
	if w.proc == nil {
		w.setState(stateStarting)
		ctx, cancel := context.WithTimeout(parent, w.startWait)
		err := w.startLocked(ctx)
		cancel()
		if err != nil {
			w.failLocked(err)
			return MaiaResult{}, err
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
		return MaiaResult{}, err
	}
	line, err := w.readLineLocked(ctx)
	if err != nil {
		w.failLocked(err)
		return MaiaResult{}, err
	}
	var reply struct {
		Result     json.RawMessage `json:"result,omitempty"`
		Error      *apierror.Error `json:"error,omitempty"`
		LegalCount int             `json:"legal_count"`
	}
	decoder := json.NewDecoder(strings.NewReader(line))
	decoder.DisallowUnknownFields()
	// Decode already rejects invalid JSON; no separate json.Valid re-decode.
	if err := decoder.Decode(&reply); err != nil || (len(reply.Result) == 0) == (reply.Error == nil) {
		w.failLocked(ErrProtocol)
		return MaiaResult{}, ErrProtocol
	}
	if reply.Error != nil {
		switch reply.Error.Code {
		case "position_mismatch":
			return MaiaResult{}, ErrPositionMismatch
		case "invalid_position", "invalid_fen":
			return MaiaResult{}, ErrInvalidPosition
		case "game_over":
			return MaiaResult{}, ErrNoLegalMoves
		default:
			err := fmt.Errorf("%w: %s", ErrProtocol, SanitizeError(reply.Error.Message))
			w.failLocked(err)
			return MaiaResult{}, err
		}
	}
	// Validate the raw result bytes through the single strict path before
	// trusting the typed copy: encoding/json pads/truncates wdl arrays and
	// silences nulls, so lengths and nulls are checked on raw JSON with no
	// re-marshal.
	typed, ok := evalcache.DecodeStrictValue[MaiaResult](reply.Result, EngineResultRequired, nil)
	if !ok || !validEngineResult(typed, reply.LegalCount, request.Temperature == 0) {
		w.failLocked(ErrProtocol)
		return MaiaResult{}, ErrProtocol
	}
	return typed, nil
}
func validEngineResult(result MaiaResult, legalCount int, deterministic bool) bool {
	if legalCount < 1 || legalCount > 218 || len(result.Candidates) != min(legalCount, maxMultiPV) || !evalcache.ValidWDL(result.WDL) {
		return false
	}
	value := MoveResponse{Move: result.Move, WDL: result.WDL, ModelUsed: "79m"}
	for _, c := range result.Candidates {
		if !evalcache.ValidWDL(c.WDL) {
			return false
		}
		value.TopMoves = append(value.TopMoves, TopMove{Move: c.Move, Prob: c.Policy, WDL: c.WDL})
	}
	return result.WDL == result.Candidates[0].WDL && ValidMoveValue(value, "79m", deterministic)
}
func (w *Worker) startLocked(ctx context.Context) error {
	if len(w.command) == 0 {
		return fmt.Errorf("%w: empty command", ErrProtocol)
	}
	cmd := exec.Command(w.command[0], w.command[1:]...)
	cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = ipc.NewWorkerDiagnostics(w.name)
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
	w.proc = &workerProcess{cmd: cmd, stdin: stdin, stdout: bufio.NewReaderSize(stdout, ipc.LineLimit)}
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
	if len(line) > ipc.LineLimit {
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
	w.last = SanitizeError(last)
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

// Close stops the worker process. The server's cross-package helper-process
// tests use it for cleanup (internal/server/main_test.go persistentWorker);
// the server process itself exits without closing idle workers.
func (w *Worker) Close() { w.close() }

// Idle reports whether no operation is running or queued on this worker.
func (w *Worker) Idle() bool { return w.sched.Idle() }

// SetWaitsForTest shrinks the startup/inference deadlines. Test seam for the
// cross-package helper-process tests; production uses the constructor
// defaults.
func (w *Worker) SetWaitsForTest(startWait, moveWait time.Duration) {
	w.startWait, w.moveWait = startWait, moveWait
}

// SanitizeError collapses a worker diagnostic to one short line so logs
// and status payloads never carry raw helper output.
func SanitizeError(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if len(value) > 160 {
		return value[:160]
	}
	return value
}

// Pool is one inference responsibility carried out by N interchangeable
// model processes. Replicas share a single multi-slot scheduler (one
// priority queue, dedup map, and batch rotation cursor), so Play > Focus >
// Batch ordering, same-key joins, and latest-wins semantics hold across
// replicas exactly as they did for the historical single worker. The pool
// implements Predictor, so EnginePool and all existing tests keep working:
// production passes pools, tests keep passing fakes.
//
// Identity (cache/dedup keys) derives from the pool's model, never the
// per-replica process name: replicas are fungible, and two replicas must
// never treat the same deterministic work as different keys.
type Pool struct {
	model   string
	workers []*Worker
	sched   *sched.Scheduler
	free    chan *Worker
}

// NewPool builds a responsibility pool of count identical model processes
// from one base command. Count below 1 clamps to 1. A single replica keeps
// the historical process name (the model); multiple replicas take
// model-0, model-1, ... for diagnostics.
func NewPool(model string, baseCommand []string, count int) *Pool {
	if count < 1 {
		count = 1
	}
	workers := make([]*Worker, 0, count)
	for i := 0; i < count; i++ {
		name := model
		if count > 1 {
			name = fmt.Sprintf("%s-%d", model, i)
		}
		workers = append(workers, NewWorker(name, append([]string(nil), baseCommand...)))
	}
	return &Pool{model: model, workers: workers, sched: sched.NewSchedulerWithCapacity(count), free: func() chan *Worker {
		free := make(chan *Worker, count)
		for _, w := range workers {
			free <- w
		}
		return free
	}()}
}

// Size reports the replica count.
func (p *Pool) Size() int { return len(p.workers) }

// PoolSize is the drain-parallelism seam: generic code sums it without
// importing pool internals; fakes without it count as 1.
func (p *Pool) PoolSize() int { return len(p.workers) }

// Model reports the pool's model identity (cache/dedup key scope).
func (p *Pool) Model() string { return p.model }

// SetIdleTimeout configures GPU unload on every replica. Zero disables.
func (p *Pool) SetIdleTimeout(d time.Duration) {
	for _, w := range p.workers {
		w.SetIdleTimeout(d)
	}
}

// SetWaitsForTest shrinks startup/inference deadlines on every replica.
func (p *Pool) SetWaitsForTest(startWait, moveWait time.Duration) {
	for _, w := range p.workers {
		w.SetWaitsForTest(startWait, moveWait)
	}
}

// Close stops every replica process.
func (p *Pool) Close() {
	for _, w := range p.workers {
		w.Close()
	}
}

// Idle reports whether no operation is running or queued on the pool.
func (p *Pool) Idle() bool { return p.sched.Idle() }

// WorkerStatus aggregates replicas: failed only when every replica failed;
// otherwise the best available state wins (ready > busy > starting >
// unloaded), so one healthy replica keeps the model serving. LastError
// carries the first non-empty replica diagnostic.
func (p *Pool) WorkerStatus() WorkerStatus {
	best := WorkerStatus{State: stateFailed}
	rank := map[workerState]int{stateFailed: 0, stateUnloaded: 1, stateStarting: 2, stateBusy: 3, stateReady: 4}
	for _, w := range p.workers {
		status := w.WorkerStatus()
		if rank[status.State] > rank[best.State] {
			best.State = status.State
		}
		if best.LastError == "" && status.LastError != "" {
			best.LastError = status.LastError
		}
	}
	return best
}

// SweepIdle unloads replicas idle past their timeout. It never interrupts
// running or queued work: a busy pool scheduler skips the sweep, and each
// replica re-checks pool idleness under its operation lock.
func (p *Pool) SweepIdle(now time.Time) {
	if !p.sched.Idle() {
		return
	}
	for _, w := range p.workers {
		w.tryUnloadIdleWithIdle(now, p.sched.Idle)
	}
}

// Predict admits through the shared scheduler, checks out a free replica,
// then runs one inference. The release contract mirrors Worker.Predict: it
// must be called exactly once after the caller persists the result (nil
// when there is nothing to persist). A cancelled waiter leaves its replica
// checked out until the reply drains, preserving warm processes and slots.
func (p *Pool) Predict(waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64, request MaiaRequest) (MaiaResult, func(), error) {
	if err := waitCtx.Err(); err != nil {
		return MaiaResult{}, nil, err
	}
	request.Moves = append([]string{}, request.Moves...)
	data, err := json.Marshal(request)
	if err != nil || len(data) > ipc.LineLimit {
		return MaiaResult{}, nil, ErrInvalidPosition
	}
	key := ""
	if request.Temperature == 0 {
		key, _ = MaiaIdentity(request, p.model).Coordinates()
	}
	admitStart := time.Now()
	grant, err := Admit(waitCtx, prio, p.sched, key, submitSeq)
	waitMs := time.Since(admitStart).Milliseconds()
	if err != nil {
		return MaiaResult{}, nil, err
	}
	var w *Worker
	select {
	case w = <-p.free:
	case <-execCtx.Done():
		p.sched.Release(grant)
		return MaiaResult{}, nil, execCtx.Err()
	}
	w.markUsed()
	w.setBusy(true)
	var once sync.Once
	release := func() {
		once.Do(func() {
			p.sched.Release(grant)
			w.setBusy(false)
			p.free <- w
		})
	}
	op := &maiaInflight{key: key, grant: grant, done: make(chan struct{})}
	go func() {
		w.mu.Lock()
		op.result, op.err = w.predictLocked(context.Background(), request)
		w.mu.Unlock()
		w.markUsed()
		if op.abandoned.Load() {
			release()
		}
		close(op.done)
	}()
	completed := func() (MaiaResult, func(), error) {
		result := op.result
		result.Candidates = append([]MaiaCandidate(nil), result.Candidates...)
		result.WaitMs = waitMs
		if op.err != nil {
			return MaiaResult{WaitMs: waitMs}, release, op.err
		}
		return result, release, nil
	}
	select {
	case <-execCtx.Done():
		select {
		case <-op.done:
			return completed()
		default:
			op.abandoned.Store(true)
			return MaiaResult{}, nil, execCtx.Err()
		}
	case <-op.done:
		return completed()
	}
}

// EnginePool is the Maia inference responsibility: a primary pool with an
// optional fallback pool (nil disables fallback for single-model servers).
// Callers name a preferred model ("79m" or "5m"); explicit 5m enters at the
// fallback directly, while 79m tries the primary first and degrades to the
// fallback on hard operation failures (never for admission, validation, or
// cancellation signals). Stockfish has no fallback; its responsibility
// stays a bare pool elsewhere.
type EnginePool struct{ large, small Predictor }

// Supports reports whether model may run on this pool: 79m always, 5m only
// when a fallback pool exists.
func (p *EnginePool) Supports(model string) bool {
	if model == "5m" {
		return p != nil && p.small != nil
	}
	return true
}

func NewEnginePool(large, small Predictor) *EnginePool {
	return &EnginePool{large: large, small: small}
}
func (p *EnginePool) Predict(waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64, model string, request MaiaRequest) (MaiaResult, func(), string, bool, error) {
	if model == "5m" {
		if p.small == nil {
			return MaiaResult{}, nil, "", false, errors.New("model 5m is not enabled on this server")
		}
		result, release, err := p.small.Predict(waitCtx, execCtx, prio, submitSeq, request)
		return result, release, "5m", false, err
	}
	result, release, err := p.large.Predict(waitCtx, execCtx, prio, submitSeq, request)
	if err == nil {
		return result, release, "79m", false, nil
	}
	firstWait := result.WaitMs
	// The worker returns a release with operation errors (nothing was
	// stored); free it here since the caller only releases on success.
	// Joins and admission failures carry no grant.
	if release != nil {
		release()
	}
	if errors.Is(err, ErrWorkerBusy) || errors.Is(err, ErrJoined) || errors.Is(err, sched.ErrSuperseded) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrPositionMismatch) || errors.Is(err, ErrInvalidPosition) || errors.Is(err, ErrNoLegalMoves) {
		return MaiaResult{}, nil, "", false, err
	}
	if p.small == nil {
		return MaiaResult{}, nil, "", false, err
	}
	result, release, fallbackErr := p.small.Predict(waitCtx, execCtx, prio, submitSeq, request)
	if fallbackErr != nil {
		if release != nil {
			release()
		}
		return MaiaResult{}, nil, "", false, fmt.Errorf("engine fallback failed: %w", errors.Join(err, fallbackErr))
	}
	result.WaitMs += firstWait
	return result, release, "5m", true, nil
}

func (p *EnginePool) Health() (string, map[string]WorkerStatus, int) {
	large := p.large.WorkerStatus()
	models := map[string]WorkerStatus{"79m": large}
	if p.small != nil {
		small := p.small.WorkerStatus()
		models["5m"] = small
		status, code := "ok", 200
		if large.State == stateFailed && small.State == stateFailed {
			status, code = "unavailable", 503
		} else if large.State == stateFailed || small.State == stateFailed {
			status = "degraded"
		}
		return status, models, code
	}
	if large.State == stateFailed {
		return "unavailable", models, 503
	}
	return "ok", models, 200
}

// SweepIdle unloads workers idle since before now minus their timeout,
// freeing GPU memory. It is a no-op for predictors without idle support
// (test fakes) and for timeouts <= 0. A nil fallback pool is skipped.
func (p *EnginePool) SweepIdle(now time.Time) {
	for _, pr := range []Predictor{p.large, p.small} {
		if pr == nil {
			continue
		}
		if s, ok := pr.(interface{ SweepIdle(time.Time) }); ok {
			s.SweepIdle(now)
			continue
		}
		if w, ok := pr.(interface{ tryUnloadIdle(time.Time) bool }); ok {
			w.tryUnloadIdle(now)
		}
	}
}

// MaiaParallelism reports how many maia batch entries may run concurrently:
// the summed replica counts of pool predictors, with non-pool predictors
// (test fakes, standalone workers) counting as 1 and a disabled fallback
// contributing 0. The batch drain spawns this many maia-lane workers so
// extra replicas actually serve whole-line reviews instead of idling
// behind a single drain loop.
func (p *EnginePool) MaiaParallelism() int {
	total := 0
	for _, pr := range []Predictor{p.large, p.small} {
		if pr == nil {
			continue
		}
		if s, ok := pr.(interface{ PoolSize() int }); ok {
			total += s.PoolSize()
		} else {
			total++
		}
	}
	if total < 1 {
		return 1
	}
	return total
}
