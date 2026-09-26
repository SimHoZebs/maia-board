package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

const SearchPolicy = "sf19-n100k-ms750-mpv2-t4-h128-v3"

type evaluationRequest struct {
	FEN        string             `json:"fen"`
	Moves      []string           `json:"moves"`
	InitialFEN string             `json:"initial_fen,omitempty"`
	PosHash    string             `json:"pos_hash,omitempty"`
	Settings   *stockfishSettings `json:"settings,omitempty"`
	// Accepted for older clients; cache identity is derived by the server.
	CacheHash string `json:"cache_hash,omitempty"`
	CacheKey  string `json:"cache_key,omitempty"`
}

type evaluationScore struct {
	Type        string `json:"type"`
	Value       int    `json:"value"`
	WinningSide string `json:"winning_side,omitempty"`
}

type evaluationLine struct {
	Move  string          `json:"move"`
	Score evaluationScore `json:"score"`
	Depth int             `json:"depth"`
	// Optional rank-1 PV (up to 5 UCI, first == Move) rooted at the evaluated
	// position. Old rows omit it and remain valid; they yield no material note.
	PV []string `json:"pv,omitempty"`
}

type evaluationResponse struct {
	Engine         string             `json:"engine"`
	SearchPolicy   string             `json:"search_policy"`
	Depth          int                `json:"depth"`
	Terminal       *string            `json:"terminal"`
	BestMove       *string            `json:"best_move"`
	Score          evaluationScore    `json:"score"`
	Lines          []evaluationLine   `json:"lines"`
	ActualSettings *stockfishSettings `json:"actual_settings,omitempty"`
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
	sched *Scheduler
	// batchSched is the batch slot (Batch reviews). Nil in some tests;
	// schedulerFor falls back to whichever scheduler exists.
	batchSched *Scheduler
	timeout    time.Duration
	// workers holds one warm helper per scheduler, created on demand so
	// test-constructed Evaluators without workers keep working.
	mu      sync.Mutex
	workers map[*Scheduler]*stockfishWorker
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
	return &Evaluator{command: []string{python, helper, "--binary", binary, "--serve"}, sched: NewScheduler(), batchSched: NewScheduler(), timeout: 8 * time.Second}
}

// workerFor returns the warm helper for one scheduler, starting from
// nothing on first use. One worker per scheduler keeps the interactive and
// batch slots on separate processes, matching the separate admission slots.
func (e *Evaluator) workerFor(sched *Scheduler) *stockfishWorker {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.workers == nil {
		e.workers = make(map[*Scheduler]*stockfishWorker)
	}
	worker, ok := e.workers[sched]
	if !ok {
		worker = &stockfishWorker{command: append([]string(nil), e.command...)}
		e.workers[sched] = worker
	}
	return worker
}

// exchange serves one lookup on the warm helper, starting it on demand. Any
// protocol or timeout failure kills the process group and drops it — the
// next exchange restarts clean (losing warmth only on the failure path).
func (w *stockfishWorker) exchange(ctx context.Context, input []byte) ([]byte, error) {
	if len(input) > workerLineLimit {
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
	cmd.Stderr = newWorkerDiagnostics("stockfish")
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
	proc := &stockfishProcess{cmd: cmd, stdin: stdin, stdout: bufio.NewReaderSize(stdout, workerLineLimit)}
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
			if len(line) > workerLineLimit {
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
func (e *Evaluator) schedulerFor(prio Priority) *Scheduler {
	if prio == PriorityBatch {
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

func (s *server) evaluate(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	w = rec
	var request evaluationRequest
	var result *evaluationResponse
	var hit bool
	// Perf spans mirroring serveMove: validate_us covers request
	// validation, exec_ms covers cache→admission→search→store.
	validateMicros, execMillis := int64(-1), int64(-1)
	defer func() {
		policy := SearchPolicy
		if request.Settings != nil {
			policy = request.Settings.policy()
		}
		depth, lines := -1, -1
		if result != nil {
			depth, lines = result.Depth, len(result.Lines)
		}
		log.Printf("evaluate status=%d plies=%d policy=%s duration_ms=%d validate_us=%d exec_ms=%d depth=%d lines=%d",
			rec.status, len(request.Moves), policy, time.Since(started).Milliseconds(), validateMicros, execMillis, depth, lines)
		if rec.status == http.StatusOK && result != nil {
			cache := "miss"
			if hit {
				cache = "hit"
			}
			log.Printf("eval-content engine=sf cache=%s policy=%s fen=%s plies=%d pos=%s %s",
				cache, policy, request.FEN, len(request.Moves), orDash(request.PosHash), sfContentFields(result))
		}
	}()
	decoded, ok := decodeSingle[evaluationRequest](w, r, 64*1024)
	if !ok {
		return
	}
	request = decoded
	validateStart := time.Now()
	if err := validateEvaluationRequest(&request); err != nil {
		validateMicros = time.Since(validateStart).Microseconds()
		writeAPIError(w, 400, err.Code, err.Message)
		return
	}
	validateMicros = time.Since(validateStart).Microseconds()
	// /evaluate is a size-1 batch through the shared executor (lane Focus;
	// any X-Priority header from older clients is ignored). waitCtx dequeues
	// on disconnect; execCtx stays detached so a granted search still writes
	// through after the client goes away.
	execCtx := context.WithoutCancel(r.Context())
	execStart := time.Now()
	live, hit, runErr := s.executeSF(r.Context(), execCtx, PriorityFocus, 0, request, false)
	execMillis = time.Since(execStart).Milliseconds()
	if runErr != nil {
		mapEngineError(w, runErr, "Stockfish evaluation is unavailable")
		return
	}
	result = live
	if hit {
		w.Header().Set("X-Eval-Cache", "hit")
	} else {
		w.Header().Set("X-Eval-Cache", "miss")
	}
	writeJSON(w, 200, result)
}

func validateEvaluationRequest(r *evaluationRequest) *requestError {
	if err := r.Settings.validate(); err != nil {
		return err
	}
	if len(r.Moves) > 256 {
		return &requestError{"history_too_long", "moves may contain at most 256 plies"}
	}
	for _, move := range r.Moves {
		if !uciMovePattern.MatchString(move) {
			return &requestError{"invalid_position", "moves must contain UCI moves"}
		}
	}
	for _, fen := range []*string{&r.FEN, &r.InitialFEN} {
		if fen == &r.InitialFEN && *fen == "" {
			continue
		}
		normalized, _, err := normalizeFEN(*fen)
		if err != nil {
			return &requestError{"invalid_fen", "fen and initial_fen must be valid six-field FENs"}
		}
		*fen = normalized
	}
	// Inconsistent triples are rejected at validation and never filed:
	// with an empty history the reconstruction root must equal the board.
	// Non-empty histories need full chess replay, which only the worker
	// performs (position_mismatch); a worker failure never writes a row.
	if r.InitialFEN != "" && len(r.Moves) == 0 && r.InitialFEN != r.FEN {
		return &requestError{"position_mismatch", "moves do not produce fen"}
	}
	return nil
}

func (e *Evaluator) run(waitCtx, execCtx context.Context, prio Priority, submitSeq uint64, request evaluationRequest) (*evaluationResponse, func(), error) {
	key, _ := sfIdentity(request).coordinates()
	sched := e.schedulerFor(prio)
	grant, err := admit(waitCtx, prio, sched, key, submitSeq)
	if err != nil {
		return nil, nil, err
	}
	release := func() { sched.Release(grant) }
	fail := func(err error) (*evaluationResponse, func(), error) {
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
	var workerError apiError
	if err := json.Unmarshal(output, &workerError); err != nil {
		return fail(err)
	}
	if workerError.Code != "" {
		switch workerError.Code {
		case "invalid_fen", "invalid_position":
			return fail(&requestError{workerError.Code, "position or move history is invalid"})
		case "position_mismatch":
			return fail(&requestError{workerError.Code, "moves do not produce fen"})
		default:
			return fail(errors.New("worker unavailable"))
		}
	}
	var result evaluationResponse
	// Single strict decode path (validate-on-write owns poisoning defense;
	// read validates shape once here, then semantic ranges below). This
	// collapses the former evaluationDocument+strictDocument double decode.
	decoded, err := decodeStrict[evaluationResponse](output, evalRequired, docAllowNull)
	if err != nil || !validEvaluationValue(decoded, request.Settings) {
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
