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

// EvaluationRequest is a Stockfish search request. CacheHash/CacheKey are
// accepted for older clients; cache identity is derived by the server.
type EvaluationRequest struct {
	FEN        string             `json:"fen"`
	Moves      []string           `json:"moves"`
	InitialFEN string             `json:"initial_fen,omitempty"`
	PosHash    string             `json:"pos_hash,omitempty"`
	Settings   *StockfishSettings `json:"settings,omitempty"`
	CacheHash  string             `json:"cache_hash,omitempty"`
	CacheKey   string             `json:"cache_key,omitempty"`
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
	// position. Old rows omit it and remain valid; they yield no material note.
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
}

// Evaluator owns the priority schedulers, one warm helper per scheduler, and
// the trusted process configuration. Each slot's helper is a persistent
// `python helper --serve` process holding a warm interpreter and a warm
// engine: repeat requests skip interpreter startup, python-chess import, and
// UCI spawn, paying only the search budget. The schedulers still order
// admission to protect the CPU; the per-slot grant serializes that slot's
// helper exchange, so interactive Focus work never shares a process with a
// Batch search.
//
// Per-request overhead left (see stockfish_timing spawn_ms vs search_ms):
// spawn_ms is ~0 on a warm engine and only nonzero after a restart. Fork
// isolation is gone, but cancellation is unchanged (SIGKILL of the process
// group on timeout, helper restarts on next use) and output validation still
// rejects garbage per request. The engine's 128 MiB hash persists across
// requests within a slot; that only affects speed, never validity.
//
// GOMAXPROCS-aware concurrency: two admission slots instead of one. The
// interactive scheduler serves Play>Focus>Batch for sync traffic (/evaluate
// uses Focus); the batch scheduler serves Batch reviews. Focus therefore never
// queues behind a Batch entry's in-flight ~750ms search. Worst case is 2
// concurrent searches x 4 Stockfish threads = 8 busy threads, sized for
// typical 4-8 CPU hosts. Dedup-by-key is per-scheduler: a Focus duplicate of
// an in-flight Batch position recomputes instead of joining; correctness is
// unaffected (last write wins, cache identity is deterministic).
type Evaluator struct {
	command []string
	// sched is the interactive slot (Play>Focus>Batch ordering).
	sched *sched.Scheduler
	// batchSched is the batch slot (Batch reviews). Nil in some tests;
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
func (e *Evaluator) workerFor(slot *sched.Scheduler) *stockfishWorker {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.workers == nil {
		e.workers = make(map[*sched.Scheduler]*stockfishWorker)
	}
	worker, ok := e.workers[slot]
	if !ok {
		worker = &stockfishWorker{command: append([]string(nil), e.command...)}
		e.workers[slot] = worker
	}
	return worker
}

// exchange serves one lookup on the warm helper, starting it on demand. Any
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
// helper cannot grow the server's memory without limit (the old fork path
// capped collection at the same bound).
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

// schedulerFor picks the admission slot by priority: Batch reviews use the
// batch slot, everything else (Play/Focus sync) uses the interactive slot so
// Focus never waits for a Batch search. Test-constructed Evaluators with a nil
// slot fall back to the existing one.
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
	grant, err := Admit(waitCtx, prio, sched, key, submitSeq)
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
		// Answered at the deadline: don't trust or serve it, matching the
		// old fork path (which killed the group here instead).
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
	// Single strict decode path (validate-on-write owns poisoning defense;
	// read validates shape once here, then semantic ranges below). This
	// collapses the former evaluationDocument+strictDocument double decode.
	decoded, err := evalcache.DecodeStrict[EvaluationResponse](output, EvalRequired, DocAllowNull)
	if err != nil || !ValidEvaluationValue(decoded, request.Settings) {
		return fail(errors.New("invalid worker response"))
	}
	result = decoded
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
