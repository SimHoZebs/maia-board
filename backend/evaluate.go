package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os/exec"
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

// Evaluator owns the priority schedulers and trusted process configuration.
// Each search still spawns one isolated process (`python helper --binary
// stockfish`); the schedulers only order admission to protect the CPU from
// fork/exec + search overlap.
//
// Per-request overhead breakdown (see stockfish_timing spawn_ms vs search_ms):
// python interpreter startup + python-chess import (~50-100ms) + UCI spawn +
// Threads=4/Hash=128 search. A process-level python-chess import warmup is not
// possible with fork-per-request isolation, and a persistent worker pool was
// deliberately not adopted: one owned engine per request keeps cancellation
// (SIGKILL of the process group), version checks, and crash isolation trivial.
// The speed win here comes from Threads 4 / Hash 128 (policy v3) plus
// concurrency below, not from reusing processes.
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
}

func NewEvaluator(python, helper, binary string) *Evaluator {
	return &Evaluator{command: []string{python, helper, "--binary", binary}, sched: NewScheduler(), batchSched: NewScheduler(), timeout: 8 * time.Second}
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
	defer func() {
		policy := SearchPolicy
		if request.Settings != nil {
			policy = request.Settings.policy()
		}
		depth, lines := -1, -1
		if result != nil {
			depth, lines = result.Depth, len(result.Lines)
		}
		log.Printf("evaluate status=%d plies=%d policy=%s duration_ms=%d depth=%d lines=%d",
			rec.status, len(request.Moves), policy, time.Since(started).Milliseconds(), depth, lines)
	}()
	decoded, ok := decodeSingle[evaluationRequest](w, r, 64*1024)
	if !ok {
		return
	}
	request = decoded
	if err := validateEvaluationRequest(&request); err != nil {
		writeAPIError(w, 400, err.Code, err.Message)
		return
	}
	// /evaluate is a size-1 batch through the shared executor (lane Focus;
	// any X-Priority header from older clients is ignored). waitCtx dequeues
	// on disconnect; execCtx stays detached so a granted search still writes
	// through after the client goes away.
	execCtx := context.WithoutCancel(r.Context())
	live, hit, runErr := s.executeSF(r.Context(), execCtx, PriorityFocus, 0, request, false)
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

// Output is small; cap collection even if a misconfigured helper is noisy.
type cappedOutput struct{ buffer bytes.Buffer }

func (b *cappedOutput) Bytes() []byte { return b.buffer.Bytes() }

func (b *cappedOutput) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > 64*1024 {
		return 0, errors.New("worker output exceeds limit")
	}
	return b.buffer.Write(p)
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
	cmd := exec.CommandContext(ctx, e.command[0], e.command[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil || cmd.Process.Pid <= 0 {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	cmd.WaitDelay = time.Second
	cmd.Stdin = bytes.NewReader(input)
	var output cappedOutput
	cmd.Stdout = &output
	cmd.Stderr = newWorkerDiagnostics("stockfish")
	if err := cmd.Start(); err != nil {
		return fail(err)
	}
	pid := cmd.Process.Pid
	if err := cmd.Wait(); err != nil {
		// Clean up only when the wrapper did not exit cleanly; a successful
		// Python finally block already quits the engine.
		cleanupEvaluationGroup(pid)
		return fail(err)
	}
	if err := ctx.Err(); err != nil {
		cleanupEvaluationGroup(pid)
		return fail(err)
	}
	var workerError apiError
	if err := json.Unmarshal(output.Bytes(), &workerError); err != nil {
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
	decoded, err := decodeStrict[evaluationResponse](output.Bytes(), evalRequired, docAllowNull)
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
