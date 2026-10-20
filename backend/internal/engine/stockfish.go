package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/chess"
	"maia-board/backend/internal/evalcache"
	"maia-board/backend/internal/ipc"
	"maia-board/backend/internal/sched"
)

const SearchPolicy = "sf19-n100k-ms750-mpv2-t4-h128-v3"

// EvaluationRequest is a Stockfish search request. Cache identity is derived
// by the server from (fen, initial_fen, moves, settings).
type EvaluationRequest struct {
	FEN        string             `json:"fen"`
	Moves      []string           `json:"moves"`
	InitialFEN string             `json:"initial_fen,omitempty"`
	Settings   *StockfishSettings `json:"settings,omitempty"`
}

// EvaluationScore is a position score from the side-to-move perspective:
// centipawns, or mate distance with the winning side.
type EvaluationScore struct {
	Type        string `json:"type"`
	Value       int    `json:"value"`
	WinningSide string `json:"winning_side,omitempty"`
}

// EvaluationLine is one ranked candidate line with its score.
type EvaluationLine struct {
	Move  string          `json:"move"`
	Score EvaluationScore `json:"score"`
	Depth int             `json:"depth"`
	// Optional rank-1 PV (up to 5 UCI, first == Move) rooted at the evaluated
	// position. Rows stored before the PV feature have no PV; the server
	// treats those as a cache miss (see lookupSFCandidateFrom) so one live
	// re-search refreshes them. Frontend rows without a PV stay silent.
	PV []string `json:"pv,omitempty"`
}

// EvaluationResponse is a complete Stockfish search result.
type EvaluationResponse struct {
	Engine         string             `json:"engine"`
	SearchPolicy   string             `json:"search_policy"`
	Depth          int                `json:"depth"`
	Terminal       *string            `json:"terminal"`
	BestMove       *string            `json:"best_move"`
	Score          EvaluationScore    `json:"score"`
	Lines          []EvaluationLine   `json:"lines"`
	ActualSettings *StockfishSettings `json:"actual_settings,omitempty"`
	// WaitMs is admission queue wait in ms. Internal only (never
	// serialized to clients or the cache); -1 means admission was
	// never reached (cache hit or pre-admission error).
	WaitMs int64 `json:"-"`
}

// Evaluator owns the priority schedulers, one warm helper per slot, and
// the trusted process configuration. Two slots (interactive + batch) so
// Focus never queues behind a Batch search; lane semantics live in
// spec/GLOSSARY.md.
type Evaluator struct {
	command []string
	// sched is the interactive scheduler (Play>Focus>Batch ordering).
	sched *sched.Scheduler
	// batchSched is the batch scheduler. Nil in some tests;
	// schedulerFor falls back to whichever scheduler exists.
	batchSched *sched.Scheduler
	timeout    time.Duration
	// workers holds one warm helper per scheduler, created on demand so
	// test-constructed Evaluators without workers keep working.
	mu      sync.Mutex
	workers map[*sched.Scheduler]*stockfishWorker
}

// stockfishWorker owns one persistent helper process. The slot's scheduler
// grant serializes exchanges (one running ticket per scheduler), so no extra
// locking is needed around the process itself; mu only guards lazy process
// creation.
type stockfishWorker struct {
	command []string
	mu      sync.Mutex
	proc    *stockfishProcess
}

type stockfishProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}

func NewEvaluator(python, helper, binary string) *Evaluator {
	return &Evaluator{command: []string{python, helper, "--binary", binary, "--serve"}, sched: sched.NewScheduler(), batchSched: sched.NewScheduler(), timeout: 8 * time.Second}
}

// NewEvaluatorForTest builds an Evaluator around an explicit helper command
// (usually the test binary re-executed as a stub helper) with no default
// timeout budget. It is a test seam; production uses NewEvaluator.
func NewEvaluatorForTest(command []string, timeout time.Duration) *Evaluator {
	return &Evaluator{command: command, sched: sched.NewScheduler(), batchSched: sched.NewScheduler(), timeout: timeout}
}

// workerFor returns the warm helper for one scheduler, starting from
// nothing on first use. One worker per scheduler keeps the interactive and
// batch slots on separate processes, matching the separate admission slots.
func (e *Evaluator) workerFor(scheduler *sched.Scheduler) *stockfishWorker {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.workers == nil {
		e.workers = make(map[*sched.Scheduler]*stockfishWorker)
	}
	worker, ok := e.workers[scheduler]
	if !ok {
		worker = &stockfishWorker{command: append([]string(nil), e.command...)}
		e.workers[scheduler] = worker
	}
	return worker
}

// exchange serves one search on the warm helper, starting it on demand. Any
// protocol or timeout failure kills the process group and drops it — the
// next exchange restarts clean (losing warmth only on the failure path).
func (w *stockfishWorker) exchange(ctx context.Context, input []byte) ([]byte, error) {
	if len(input) > ipc.LineLimit {
		return nil, errors.New("stockfish request exceeds limit")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.ensureLocked(ctx); err != nil {
		return nil, err
	}
	proc := w.proc
	writeDone := make(chan error, 1)
	go func() {
		_, err := proc.stdin.Write(append(append([]byte(nil), input...), '\n'))
		writeDone <- err
	}()
	select {
	case err := <-writeDone:
		if err != nil {
			w.failLocked()
			return nil, err
		}
	case <-ctx.Done():
		w.failLocked()
		return nil, ctx.Err()
	}
	line, err := w.readLineLocked(ctx)
	if err != nil {
		w.failLocked()
		return nil, err
	}
	return line, nil
}

func (w *stockfishWorker) ensureLocked(ctx context.Context) error {
	if w.proc != nil {
		return nil
	}
	if len(w.command) == 0 {
		return errors.New("stockfish helper has no command")
	}
	cmd := exec.Command(w.command[0], w.command[1:]...)
	cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = ipc.NewWorkerDiagnostics("stockfish")
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
	proc := &stockfishProcess{cmd: cmd, stdin: stdin, stdout: bufio.NewReaderSize(stdout, ipc.LineLimit)}
	w.proc = proc
	line, err := w.readLineLocked(ctx)
	if err != nil {
		w.failLocked()
		return err
	}
	var ready struct {
		Ready bool `json:"ready"`
	}
	if json.Unmarshal(line, &ready) != nil || !ready.Ready {
		w.failLocked()
		return errors.New("stockfish helper missing ready marker")
	}
	return nil
}

// readLineLocked reads one newline-terminated reply, bounded so a rogue
// helper cannot grow the server's memory without limit.
func (w *stockfishWorker) readLineLocked(ctx context.Context) ([]byte, error) {
	proc := w.proc
	type response struct {
		line []byte
		err  error
	}
	done := make(chan response, 1)
	go func() {
		var line []byte
		for {
			fragment, err := proc.stdout.ReadSlice('\n')
			line = append(line, fragment...)
			if len(line) > ipc.LineLimit {
				done <- response{nil, errors.New("stockfish worker output exceeds limit")}
				return
			}
			if err == bufio.ErrBufferFull {
				continue
			}
			done <- response{append([]byte(nil), line...), err}
			return
		}
	}()
	select {
	case r := <-done:
		return r.line, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (w *stockfishWorker) failLocked() {
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
}

// failLockedWithMu kills and drops the helper for callers that don't hold
// w.mu (the grant holder after a successful-but-late exchange).
func (w *stockfishWorker) failLockedWithMu() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.failLocked()
}

// schedulerFor picks the scheduler by priority: Batch work uses the batch
// scheduler, everything else (Play/Focus sync) uses the interactive
// scheduler so Focus never waits for a Batch search. Test-constructed
// Evaluators with a nil scheduler fall back to the existing one.
func (e *Evaluator) schedulerFor(prio sched.Priority) *sched.Scheduler {
	if prio == sched.PriorityBatch {
		if e.batchSched != nil {
			return e.batchSched
		}
		return e.sched
	}
	if e.sched != nil {
		return e.sched
	}
	return e.batchSched
}

// Idle reports whether both admission slots are empty.
func (e *Evaluator) Idle() bool {
	if e.sched != nil && !e.sched.Idle() {
		return false
	}
	if e.batchSched != nil && !e.batchSched.Idle() {
		return false
	}
	return true
}

// ValidateEvaluationRequest normalizes FENs and rejects over-long histories,
// misshapen moves, and inconsistent triples. Non-empty histories need full
// chess replay, which only the worker performs (position_mismatch); a worker
// failure never writes a row.
func ValidateEvaluationRequest(r *EvaluationRequest) *apierror.RequestError {
	if err := r.Settings.Validate(); err != nil {
		return err
	}
	if len(r.Moves) > 256 {
		return &apierror.RequestError{Code: "history_too_long", Message: "moves may contain at most 256 plies"}
	}
	for _, move := range r.Moves {
		if !chess.UCIMovePattern.MatchString(move) {
			return &apierror.RequestError{Code: "invalid_position", Message: "moves must contain UCI moves"}
		}
	}
	for _, fen := range []*string{&r.FEN, &r.InitialFEN} {
		if fen == &r.InitialFEN && *fen == "" {
			continue
		}
		normalized, _, err := chess.NormalizeFEN(*fen)
		if err != nil {
			return &apierror.RequestError{Code: "invalid_fen", Message: "fen and initial_fen must be valid six-field FENs"}
		}
		*fen = normalized
	}
	// Inconsistent triples are rejected at validation and never filed:
	// with an empty history the reconstruction root must equal the board.
	if r.InitialFEN != "" && len(r.Moves) == 0 && r.InitialFEN != r.FEN {
		return &apierror.RequestError{Code: "position_mismatch", Message: "moves do not produce fen"}
	}
	return nil
}

// Run admits through the priority scheduler, then runs one search on the
// slot's warm helper. waitCtx bounds queue waiting; execCtx bounds the
// search itself. The returned release must be called exactly once.
func (e *Evaluator) Run(waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64, request EvaluationRequest) (*EvaluationResponse, func(), error) {
	key, _ := SFIdentity(request).Coordinates()
	sched := e.schedulerFor(prio)
	admitStart := time.Now()
	grant, err := Admit(waitCtx, prio, sched, key, submitSeq)
	waitMs := time.Since(admitStart).Milliseconds()
	if err != nil {
		return nil, nil, err
	}
	release := func() { sched.Release(grant) }
	fail := func(err error) (*EvaluationResponse, func(), error) {
		release()
		return nil, nil, err
	}
	timeout := e.timeout
	if request.Settings != nil {
		timeout += time.Duration(request.Settings.TimeMS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(execCtx, timeout)
	defer cancel()
	input, err := json.Marshal(request)
	if err != nil {
		return fail(err)
	}
	// One warm helper per slot: the grant above serializes this slot's
	// exchanges, so the helper serves them one at a time.
	output, err := e.workerFor(sched).exchange(ctx, input)
	if err != nil {
		return fail(err)
	}
	if err := ctx.Err(); err != nil {
		// Answered at the deadline: don't trust or serve it.
		e.workerFor(sched).failLockedWithMu()
		return fail(err)
	}
	var workerError apierror.Error
	if err := json.Unmarshal(output, &workerError); err != nil {
		return fail(err)
	}
	if workerError.Code != "" {
		switch workerError.Code {
		case "invalid_fen", "invalid_position":
			return fail(&apierror.RequestError{Code: workerError.Code, Message: "position or move history is invalid"})
		case "position_mismatch":
			return fail(&apierror.RequestError{Code: workerError.Code, Message: "moves do not produce fen"})
		default:
			return fail(errors.New("worker unavailable"))
		}
	}
	var result EvaluationResponse
	// Single strict decode path: read validates shape here, then semantic
	// ranges below.
	decoded, err := evalcache.DecodeStrict[EvaluationResponse](output, EvalRequired, DocAllowNull)
	if err != nil || !ValidEvaluationValue(decoded, request.Settings) {
		return fail(errors.New("invalid worker response"))
	}
	result = decoded
	result.WaitMs = waitMs
	return &result, release, nil
}

func cleanupEvaluationGroup(pid int) {
	if pid <= 0 {
		return
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	// When the server is container PID 1, it adopts orphaned engine processes.
	// Reap only this request's group; never race another worker's cmd.Wait.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		n, err := syscall.Wait4(-pid, nil, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.ECHILD) {
			return
		}
		if err != nil && !errors.Is(err, syscall.EINTR) {
			return
		}
		if n == 0 {
			time.Sleep(5 * time.Millisecond)
		}
	}
}
