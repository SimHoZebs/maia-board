package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/chess"
	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/sched"
	"maia-board/backend/internal/store"
)

const (
	// maxBatchRequests bounds one game: 256 plies x three lanes (Stockfish,
	// display Maia, grading Maia 2400). Intake cache-filtering means the
	// queued remainder is misses only. It also bounds unresolved misses per
	// engine scheduler (§2 cap a).
	maxBatchRequests = 768
	// maxKeptJobs bounds in-memory history. Results stay queryable through
	// evaluations_v2 + lookup long after their job row is evicted.
	maxKeptJobs = 8
	// maxUnfinishedJobs bounds admitted-but-unfinished jobs (§2 cap b).
	// Mirrors maxKeptJobs: at most 8 unfinished + up to 8 retained finished
	// in the worst case.
	maxUnfinishedJobs = 8
)

// Single executor: one resolve + execute path for /move, /move/analysis,
// /evaluate, and /reviews entries; lookup reuses resolve read-only.
// strictBatch=false serves degraded 79M→5M fallback without caching;
// strictBatch=true fails per-index so live can retry.
func resolveSFQuery(query LookupRequest, initialFEN string, prefix []string) (engine.EvaluationRequest, *apierror.RequestError) {
	if prefix == nil {
		return engine.EvaluationRequest{}, &apierror.RequestError{Code: "invalid_request", Message: "moves must be an array"}
	}
	if query.EloMaia != nil || query.EloUser != nil || query.Model != "" {
		return engine.EvaluationRequest{}, &apierror.RequestError{Code: "invalid_request", Message: "Stockfish request contains Maia settings"}
	}
	req := engine.EvaluationRequest{FEN: query.FEN, InitialFEN: initialFEN, Moves: prefix, Settings: query.Settings}
	if err := engine.ValidateEvaluationRequest(&req); err != nil {
		return engine.EvaluationRequest{}, &apierror.RequestError{Code: "invalid_request", Message: err.Message}
	}
	return req, nil
}

func resolveMaiaQuery(query LookupRequest, initialFEN string, prefix []string) (engine.MaiaRequest, string, *apierror.RequestError) {
	if prefix == nil {
		return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "invalid_request", Message: "moves must be an array"}
	}
	if query.Settings != nil {
		return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "invalid_request", Message: "Maia request contains Stockfish settings"}
	}
	_, side, _ := chess.NormalizeFEN(query.FEN)
	color := "white"
	if side == "b" {
		color = "black"
	}
	req, model, err := validateMoveRequest(MoveRequest{FEN: query.FEN, InitialFEN: initialFEN,
		Moves: prefix, EloMaia: query.EloMaia, EloUser: query.EloUser,
		ValueEloMaia: query.ValueEloMaia, ValueEloUser: query.ValueEloUser,
		Model: query.Model, MaiaColor: color})
	if err != nil {
		message := "position or move history is invalid"
		if reqErr, ok := errors.AsType[*apierror.RequestError](err); ok {
			message = reqErr.Message
		}
		return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "invalid_request", Message: message}
	}
	return req, model, nil
}

// engineExecutor unifies the Stockfish and Maia execute paths behind one
// contract: cache-read, run, validate, store.
type engineExecutor[T any] interface {
	loadCached() (T, bool)
	runLive(waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64) (result T, release func(), degraded bool, err error)
	validate(T) error
	store(T)
}

// executeWithRetry runs cache→predict→validate→store→release with up to 3
// engine.ErrJoined retries. Release is exactly-once: runLive's grant is released
// after store (or on every error/degraded path) before the next admission,
// so batch entries yield to interactive lanes between entries.
func executeWithRetry[T any](ex engineExecutor[T], waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64, strictBatch bool) (T, bool, error) {
	var zero T
	for attempt := 0; attempt < 3; attempt++ {
		if cached, ok := ex.loadCached(); ok {
			return cached, true, nil
		}
		result, release, degraded, err := ex.runLive(waitCtx, execCtx, prio, submitSeq)
		if err != nil {
			if release != nil {
				release()
			}
			if errors.Is(err, engine.ErrJoined) {
				continue
			}
			return zero, false, err
		}
		if degraded {
			if release != nil {
				release()
			}
			if strictBatch {
				return zero, false, errors.New("degraded fallback is not cached; retry as live analysis")
			}
			return result, false, nil
		}
		if err := ex.validate(result); err != nil {
			if release != nil {
				release()
			}
			return zero, false, err
		}
		ex.store(result)
		if release != nil {
			release()
		}
		return result, false, nil
	}
	return zero, false, errors.New("evaluation did not settle")
}

type sfExecutor struct {
	s   *Server
	req engine.EvaluationRequest
}

func (e sfExecutor) loadCached() (*engine.EvaluationResponse, bool) { return e.s.cachedSF(e.req) }

func (e sfExecutor) runLive(waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64) (result *engine.EvaluationResponse, release func(), degraded bool, err error) {
	if e.s.evaluator == nil {
		// Cache-only path (e.g. evaluator absent): hits serve, misses fail.
		return nil, nil, false, errors.New("Stockfish is unavailable")
	}
	result, release, err = e.s.evaluator.Run(waitCtx, execCtx, prio, submitSeq, e.req)
	if err != nil {
		return nil, release, false, err
	}
	result.ActualSettings = e.req.Settings
	return result, release, false, nil
}

func (e sfExecutor) validate(*engine.EvaluationResponse) error { return nil }

func (e sfExecutor) store(result *engine.EvaluationResponse) {
	hash, key := engine.SFIdentity(e.req).Coordinates()
	e.s.storeCache(hash, "sf", key, result)
}

type maiaExecutor struct {
	s        *Server
	req      engine.MaiaRequest
	model    string
	useCache bool
}

func (e maiaExecutor) loadCached() (engine.MoveResponse, bool) {
	if !e.useCache {
		return engine.MoveResponse{}, false
	}
	if cached, ok := e.s.cachedMaia(e.req, e.model); ok {
		return *cached, true
	}
	return engine.MoveResponse{}, false
}

func (e maiaExecutor) runLive(waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64) (response engine.MoveResponse, release func(), degraded bool, err error) {
	result, release, used, degraded, err := e.s.pool.Predict(waitCtx, execCtx, prio, submitSeq, e.model, e.req)
	if err != nil {
		return engine.MoveResponse{}, release, false, err
	}
	response = engine.MoveResponse{Move: result.Move, WDL: result.WDL, ModelUsed: used, Degraded: degraded, WaitMs: result.WaitMs}
	for _, candidate := range result.Candidates {
		response.TopMoves = append(response.TopMoves, engine.TopMove{Move: candidate.Move, Prob: candidate.Policy, WDL: candidate.WDL})
	}
	return response, release, degraded, nil
}

func (e maiaExecutor) validate(response engine.MoveResponse) error {
	if !engine.ValidMoveValue(response, e.model, e.useCache) {
		return errors.New("invalid Maia worker response")
	}
	return nil
}

func (e maiaExecutor) store(response engine.MoveResponse) {
	if !e.useCache {
		return
	}
	hash, key := engine.MaiaIdentity(e.req, e.model).Coordinates()
	e.s.storeCache(hash, "maia", key, response)
}

// executeSF runs one Stockfish search with join-retry and write-through.
// Returns hit=true when served from cache. strictBatch is kept for symmetry
// (SF has no degraded fallback); both modes store and serve identically.
// submitSeq orders batch-lane tickets; sync callers pass 0.
func (s *Server) executeSF(waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64, req engine.EvaluationRequest, strictBatch bool) (*engine.EvaluationResponse, bool, error) {
	return executeWithRetry[(*engine.EvaluationResponse)](sfExecutor{s: s, req: req}, waitCtx, execCtx, prio, submitSeq, strictBatch)
}

// executeMaia runs one Maia inference with join-retry and write-through.
// Returns hit=true when served from cache.
func (s *Server) executeMaia(waitCtx, execCtx context.Context, prio sched.Priority, submitSeq uint64, req engine.MaiaRequest, model string, strictBatch bool) (engine.MoveResponse, bool, error) {
	return executeWithRetry[engine.MoveResponse](maiaExecutor{s: s, req: req, model: model, useCache: req.Temperature == 0}, waitCtx, execCtx, prio, submitSeq, strictBatch)
}

type batchStatus string

const (
	batchPending batchStatus = "pending"
	batchRunning batchStatus = "running"
	batchDone    batchStatus = "done"
	batchFailed  batchStatus = "failed"
)

// Entry roles: grading vs display. The engine routes the slot; the role
// names why the batch needs the row. "grade" rows double as the delta
// baseline other rows read at serve time; "display" is everything else.
const (
	roleGrade   = "grade"
	roleDisplay = "display"
)

type batchEntry struct {
	index     int
	engine    string // slot routing: which admission slot drains this entry
	role      string // treatment: roleGrade (grading-2400 row) or roleDisplay
	evalReq   engine.EvaluationRequest
	maiaReq   engine.MaiaRequest
	maiaModel string
	// submitSeq is the batch-lane ordering nonce (§1): one process-wide
	// atomic increment per accepted submit, shared by all its entries.
	// Never exposed via API or logs. Set at intake AFTER the cap pass.
	submitSeq uint64
	status    batchStatus
	errMsg    string
	started   time.Time
}

type BatchProgress struct {
	JobID    string            `json:"job_id"`
	Total    int               `json:"total"`
	Done     int               `json:"done"`
	Failed   int               `json:"failed"`
	Finished bool              `json:"finished"`
	Errors   map[string]string `json:"errors,omitempty"`
}

type batchJob struct {
	id        string
	owner     string
	createdAt string
	entries   []*batchEntry
	done      int
	failed    int
	finished  bool
	mu        sync.Mutex
	subs      map[chan BatchProgress]struct{}
}

func (job *batchJob) progressLocked() BatchProgress {
	progress := BatchProgress{JobID: job.id, Total: len(job.entries), Done: job.done,
		Failed: job.failed, Finished: job.finished}
	for _, entry := range job.entries {
		if entry.status == batchFailed {
			if progress.Errors == nil {
				progress.Errors = map[string]string{}
			}
			progress.Errors[fmt.Sprint(entry.index)] = entry.errMsg
		}
	}
	return progress
}

func (job *batchJob) progress() BatchProgress {
	job.mu.Lock()
	defer job.mu.Unlock()
	return job.progressLocked()
}

// complete records one settled entry, notifies live subscribers, and emits
// the per-entry timing line.
func (job *batchJob) complete(entry *batchEntry, errMsg string, waitMs int64) {
	status := batchDone
	if errMsg != "" {
		status = batchFailed
	}
	job.mu.Lock()
	if entry.status == batchPending || entry.status == batchRunning {
		entry.status = status
		entry.errMsg = errMsg
		if errMsg == "" {
			job.done++
		} else {
			job.failed++
		}
	}
	progress := job.progressLocked()
	for sub := range job.subs {
		select {
		case sub <- progress:
		default:
		}
	}
	job.mu.Unlock()
	log.Printf("review-batch entry job=%s index=%d engine=%s role=%s status=%s duration_ms=%d wait_ms=%d err=%s",
		job.id, entry.index, entry.engine, entry.role, status, time.Since(entry.started).Milliseconds(), waitMs, errMsg)
}

// ReviewJobs runs whole-game batches over the shared engine schedulers
// with admission caps (§2) instead of a single-active gate. Jobs are
// in-memory orchestration only: finished plies persist in evaluations_v2,
// so eviction or restart never loses computed work — the client resubmits
// and the intake filter skips cached rows.
type ReviewJobs struct {
	mu    sync.Mutex
	jobs  map[string]*batchJob
	order []string
	s     *Server
}

func NewReviewJobs(s *Server) *ReviewJobs {
	return &ReviewJobs{jobs: make(map[string]*batchJob), s: s}
}

func (js *ReviewJobs) byID(id string) *batchJob {
	js.mu.Lock()
	defer js.mu.Unlock()
	return js.jobs[id]
}

// countMisses tallies accepted-but-unresolved entries by destination
// scheduler. Pure over the passed slice (no locks, no I/O) so cap unit tests
// exercise it directly: pending/running entries only — cached hits settle at
// intake (batchDone) and never count. Maia large-model misses count against
// both large and small: fallback eligibility is failure-dependent and
// unknowable at intake, so every large miss is conservatively assumed
// fallback-eligible; over-counting small only ever rejects early.
func countMisses(entries []*batchEntry) (sf, large, small int) {
	for _, e := range entries {
		if e == nil || (e.status != batchPending && e.status != batchRunning) {
			continue
		}
		switch e.engine {
		case "sf":
			sf++
		case "maia":
			if e.maiaModel == "5m" {
				small++
			} else {
				large++
				small++
			}
		}
	}
	return sf, large, small
}

// capTallies scans unfinished jobs under js.mu and returns the
// accepted-but-unresolved tallies per scheduler plus the unfinished-job
// count. Fast O(records): entries are only counted, never resolved here.
func (js *ReviewJobs) capTallies() (unfinished, sf, large, small int) {
	js.mu.Lock()
	defer js.mu.Unlock()
	return js.capTalliesLocked()
}

// capTalliesLocked is capTallies for callers already holding js.mu
// (Go mutexes are not reentrant, so the submit path cannot call capTallies
// while holding the lock). It takes each job.mu briefly, same as capTallies.
func (js *ReviewJobs) capTalliesLocked() (unfinished, sf, large, small int) {
	for _, job := range js.jobs {
		job.mu.Lock()
		if job.finished {
			job.mu.Unlock()
			continue
		}
		unfinished++
		sfJob, largeJob, smallJob := countMisses(job.entries)
		sf += sfJob
		large += largeJob
		small += smallJob
		job.mu.Unlock()
	}
	return unfinished, sf, large, small
}

// overCap reports whether admitting newSF/newLarge/newSmall misses on top of
// the existing tallies (or one more unfinished job) would pass either §2 cap.
func overCap(unfinished, sf, large, small, newSF, newLarge, newSmall int) bool {
	if unfinished >= maxUnfinishedJobs {
		return true
	}
	if sf+newSF > maxBatchRequests || large+newLarge > maxBatchRequests || small+newSmall > maxBatchRequests {
		return true
	}
	return false
}

// evictLocked removes finished jobs while order exceeds maxKeptJobs,
// scanning for the first finished job anywhere in order (not head-only).
// Stale order entries missing from the map are dropped too. Unfinished jobs
// (and the just-inserted job) are never evicted; when nothing finished
// remains the loop breaks and order temporarily exceeds the bound — the
// unfinished-job cap (§2b) bounds that growth. Callers hold js.mu.
func (js *ReviewJobs) evictLocked(keepID string) {
	for len(js.order) > maxKeptJobs {
		idx := -1
		for i, oid := range js.order {
			if oid == keepID {
				continue
			}
			old, ok := js.jobs[oid]
			if !ok {
				idx = i
				break
			}
			old.mu.Lock()
			finished := old.finished
			old.mu.Unlock()
			if finished {
				idx = i
				break
			}
		}
		if idx == -1 {
			break
		}
		oid := js.order[idx]
		js.order = append(js.order[:idx], js.order[idx+1:]...)
		delete(js.jobs, oid)
	}
}

// resolveBatchEntryRequest validates one batch request exactly like the sync
// endpoints + lookup do (via the shared resolve). The prefix is sliced from
// the shared line (pure slice, no chess); the derived triple feeds the
// unchanged identity/validate paths. Cache filtering happens separately in
// reviews() from one prefetched snapshot, so intake costs one bulk read
// instead of a point read per entry.
func (js *ReviewJobs) resolveBatchEntryRequest(index int, line BatchLine, query LookupRequest) (*batchEntry, *apierror.RequestError) {
	entry := &batchEntry{index: index, engine: query.Engine, status: batchPending}
	prefixMsg := fmt.Sprintf("requests[%d]: ", index)
	prefix, prefixErr := linePrefix(line, query.Ply)
	if prefixErr != nil {
		return nil, &apierror.RequestError{Code: "invalid_request", Message: prefixMsg + prefixErr.Message}
	}
	switch query.Engine {
	case "sf":
		request, reqErr := resolveSFQuery(query, line.InitialFEN, prefix)
		if reqErr != nil {
			return nil, &apierror.RequestError{Code: "invalid_request", Message: prefixMsg + reqErr.Message}
		}
		entry.evalReq = request
		entry.role = roleDisplay
	case "maia":
		request, model, reqErr := resolveMaiaQuery(query, line.InitialFEN, prefix)
		if reqErr != nil {
			return nil, &apierror.RequestError{Code: "invalid_request", Message: prefixMsg + reqErr.Message}
		}
		if js.s != nil && js.s.pool != nil && !js.s.pool.Supports(model) {
			return nil, &apierror.RequestError{Code: "invalid_request", Message: prefixMsg + "model 5m is not enabled on this server"}
		}
		entry.maiaReq, entry.maiaModel = request, model
		entry.role = roleDisplay
		// Grading lane: a Maia entry whose identity equals the grading hash
		// shares the grading row other rows read as their delta baseline.
		entryHash, _ := engine.MaiaIdentity(request, model).Coordinates()
		gradeHash, _ := maiaGradingHash(request)
		if entryHash == gradeHash {
			entry.role = roleGrade
		}
	default:
		return nil, &apierror.RequestError{Code: "invalid_request", Message: fmt.Sprintf("requests[%d]: engine must be sf or maia", index)}
	}
	return entry, nil
}

// entryHashes lists every cache identity the intake filter may read for one
// entry: the exact SF identity plus larger-lines superset variants, or the
// single Maia identity. Keyed by engine: identity shapes differ per model.
func entryHashes(entry *batchEntry) []string {
	if entry.engine == "sf" {
		candidates := sfSupersetCandidates(entry.evalReq)
		hashes := make([]string, 0, len(candidates))
		for _, candidate := range candidates {
			hash, _ := engine.SFIdentity(candidate).Coordinates()
			hashes = append(hashes, hash)
		}
		return hashes
	}
	hash, _ := engine.MaiaIdentity(entry.maiaReq, entry.maiaModel).Coordinates()
	return []string{hash}
}

// SubmitBody is the POST /reviews bulk shape: the shared line once,
// entries referencing it by ply.
type SubmitBody struct {
	Line     BatchLine       `json:"line"`
	Requests []LookupRequest `json:"requests"`
}

type SubmitInput struct {
	Body SubmitBody
}

// BatchSubmitted is the 202 submit answer: cache-filter totals.
type BatchSubmitted struct {
	JobID   string `json:"job_id"`
	Total   int    `json:"total"`
	Cached  int    `json:"cached"`
	Pending int    `json:"pending"`
}

type SubmitOutput struct {
	Body BatchSubmitted
}

func (js *ReviewJobs) handleSubmit(ctx context.Context, input *SubmitInput) (*SubmitOutput, error) {
	if js.s.store == nil {
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
	}
	ownerID := ""
	if js.s.authEnabled() {
		user, err := js.s.requireUser(ctx)
		if err != nil {
			return nil, err
		}
		ownerID = user.ID
	}
	body := input.Body
	if lineErr := validateBatchLine(body.Line); lineErr != nil {
		return nil, apiError(http.StatusBadRequest, lineErr.Code, lineErr.Message)
	}
	if body.Requests == nil || len(body.Requests) == 0 || len(body.Requests) > maxBatchRequests {
		return nil, apiError(http.StatusBadRequest, "invalid_request", fmt.Sprintf("requests must contain 1 to %d entries", maxBatchRequests))
	}
	// Two-phase admission (§2): snapshot counts under js.mu so a large
	// submit never stalls status reads, release, resolve outside the lock
	// (cache reads only, no ReviewJobs reentry, so no lock cycle), then
	// re-acquire and re-check before insert. The re-check + insert hold one
	// lock hold, so overshoot stays zero. Retry the whole intake at most
	// once on a lost race (a concurrent insert landing between snapshot and
	// re-check); a second collision is backpressure, honestly 429ed.
	for attempt := 0; attempt < 2; attempt++ {
		entries := make([]*batchEntry, 0, len(body.Requests))
		cached := 0
		sfMiss := false
		// Intake cache-filter in two phases: validate every entry first
		// (no I/O), prefetch all identities in one bulk read, then mark
		// hits from the snapshot. Same accept/filter outcome as per-entry
		// reads, without N sequential round trips on long games.
		var hashes []string
		for index, query := range body.Requests {
			entry, invalid := js.resolveBatchEntryRequest(index, body.Line, query)
			if invalid != nil {
				return nil, apiError(http.StatusBadRequest, invalid.Code, invalid.Message)
			}
			hashes = append(hashes, entryHashes(entry)...)
			entries = append(entries, entry)
		}
		src := js.s.prefetch(hashes)
		for _, entry := range entries {
			var hit bool
			// Engine-keyed: the cached read matches the entry's identity shape.
			switch entry.engine {
			case "sf":
				_, hit = js.s.cachedSFFrom(src, entry.evalReq)
			case "maia":
				_, hit = js.s.cachedMaiaFrom(src, entry.maiaReq, entry.maiaModel)
			}
			if entry.engine == "sf" && !hit {
				sfMiss = true
			}
			if hit {
				entry.status = batchDone
				cached++
			}
		}
		// The sync /evaluate endpoint serves cache hits without an evaluator;
		// batches are identical: only sf misses need live inference.
		if sfMiss && js.s.evaluator == nil {
			return nil, apiError(http.StatusBadGateway, "engine_unavailable", "Stockfish is unavailable")
		}
		newSF, newLarge, newSmall := countMisses(entries)
		js.mu.Lock()
		unfinished, sf, large, small := js.capTalliesLocked()
		if overCap(unfinished, sf, large, small, newSF, newLarge, newSmall) {
			js.mu.Unlock()
			if attempt == 0 {
				continue
			}
			js.writeBusy(unfinished, sf, large, small)
			return nil, apiError(http.StatusTooManyRequests, "engine_busy", "review queue depth exceeded, retry later")
		}
		// Cap pass: consume one ordering nonce for the whole submit (§1).
		// Rejected submits consume nothing.
		seq := sched.NextSubmitSeq()
		for _, e := range entries {
			e.submitSeq = seq
		}
		id, err := store.NewHexID()
		if err != nil {
			js.mu.Unlock()
			return nil, apiError(http.StatusBadGateway, "engine_unavailable", "could not start review batch")
		}
		job := &batchJob{id: id, owner: ownerID, createdAt: time.Now().UTC().Format(time.RFC3339Nano),
			entries: entries, subs: make(map[chan BatchProgress]struct{})}
		job.done = cached
		js.jobs[id] = job
		js.order = append(js.order, id)
		js.evictLocked(id)
		js.mu.Unlock()
		go js.drain(job)
		pending := len(entries) - cached
		log.Printf("review-batch submit job=%s total=%d cached=%d pending=%d", id, len(entries), cached, pending)
		return &SubmitOutput{Body: BatchSubmitted{
			JobID: id, Total: len(entries), Cached: cached, Pending: pending,
		}}, nil
	}
	// Unreachable: the cap loop either admits or 429s on the second attempt.
	return nil, apiError(http.StatusTooManyRequests, "engine_busy", "review queue depth exceeded, retry later")
}

// writeBusy emits the queue-pressure snapshot line.
func (js *ReviewJobs) writeBusy(unfinished, sf, large, small int) {
	log.Printf("review-batch busy unfinished=%d sf_queue=%d large_queue=%d small_queue=%d",
		unfinished, sf, large, small)
}

// reviewStatusInput carries the batch id for GET /reviews/{id}.
type ReviewStatusInput struct {
	ID string `path:"id"`
}

type ReviewStatusOutput struct {
	Body BatchProgress
}

func (js *ReviewJobs) handleStatus(ctx context.Context, input *ReviewStatusInput) (*ReviewStatusOutput, error) {
	// No DELETE: the router answers DELETE with 405 before this handler runs.
	job := js.byID(input.ID)
	if job == nil {
		return nil, apiError(http.StatusNotFound, "not_found", "unknown review batch")
	}
	if js.s.authEnabled() {
		user, err := js.s.requireUser(ctx)
		if err != nil {
			return nil, err
		}
		if job.owner != "" && job.owner != user.ID {
			return nil, apiError(http.StatusNotFound, "not_found", "unknown review batch")
		}
	}
	return &ReviewStatusOutput{Body: job.progress()}, nil
}

// drain executes one slot lane at a time per engine (the maia lane runs up
// to the pool's replica count in parallel). Lanes are engine-keyed; entry
// roles ride along for treatment, never routing. Each entry holds its slot
// only for that entry, so pumpLocked grants waiting Play/Focus tickets next
// (Play>Focus>Batch). Work runs on detached contexts.
func (js *ReviewJobs) drain(job *batchJob) {
	started := time.Now()
	var wg sync.WaitGroup
	for _, lane := range []string{"sf", "maia"} {
		lane := lane
		if !job.hasPending(lane) {
			continue
		}
		workers := 1
		if lane == "maia" {
			workers = js.maiaConcurrency()
		}
		for i := 0; i < workers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for _, entry := range job.entries {
					if entry.engine != lane || !job.claim(entry) {
						continue
					}
					js.runEntry(job, entry)
				}
			}()
		}
	}
	wg.Wait()
	job.mu.Lock()
	job.finished = true
	progress := job.progressLocked()
	for sub := range job.subs {
		select {
		case sub <- progress:
		default:
		}
	}
	job.mu.Unlock()
	log.Printf("review-batch finish job=%s done=%d failed=%d duration_ms=%d",
		job.id, progress.Done, progress.Failed, time.Since(started).Milliseconds())
}

// maiaConcurrency bounds the maia drain lane: one worker per pool replica
// (non-pool predictors count as 1).
func (js *ReviewJobs) maiaConcurrency() int {
	if js == nil || js.s == nil || js.s.pool == nil {
		return 1
	}
	return js.s.pool.MaiaParallelism()
}

func (job *batchJob) hasPending(lane string) bool {
	job.mu.Lock()
	defer job.mu.Unlock()
	for _, entry := range job.entries {
		if entry.engine == lane && entry.status == batchPending {
			return true
		}
	}
	return false
}

// claim moves one pending entry to running exactly once across lanes.
func (job *batchJob) claim(entry *batchEntry) bool {
	job.mu.Lock()
	defer job.mu.Unlock()
	if entry.status != batchPending {
		return false
	}
	entry.status = batchRunning
	entry.started = time.Now()
	return true
}

func batchErrMessage(err error) string {
	if reqErr, ok := errors.AsType[*apierror.RequestError](err); ok {
		return reqErr.Message
	}
	return engine.SanitizeError(err.Error())
}

// runEntry executes one batch entry through the shared executor table.
// The runner is engine-keyed; the entry's role does not route.
func (js *ReviewJobs) runEntry(job *batchJob, entry *batchEntry) {
	bg := context.Background()
	runners := map[string]func() (int64, error){
		"sf": func() (int64, error) {
			res, _, err := js.s.executeSF(bg, bg, sched.PriorityBatch, entry.submitSeq, entry.evalReq, true)
			if err != nil || res == nil {
				return -1, err
			}
			return res.WaitMs, err
		},
		"maia": func() (int64, error) {
			res, _, err := js.s.executeMaia(bg, bg, sched.PriorityBatch, entry.submitSeq, entry.maiaReq, entry.maiaModel, true)
			if err != nil {
				return -1, err
			}
			return res.WaitMs, err
		},
	}
	run, ok := runners[entry.engine]
	if !ok {
		job.complete(entry, "unknown engine", -1)
		return
	}
	if waitMs, err := run(); err != nil {
		job.complete(entry, batchErrMessage(err), waitMs)
		return
	} else {
		job.complete(entry, "", waitMs)
	}
}

// reviewEvents streams live progress as server-sent events. The opening
// snapshot makes reconnects self-healing: the client reconciles via
// GET status + bulk lookup instead of trusting the stream. Counters are
// cumulative, so the latest tick supersedes earlier ones; the server keeps
// no replay buffer and ignores Last-Event-ID.
func (js *ReviewJobs) reviewEvents(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/reviews/")
	id = strings.TrimSuffix(id, "/events")
	if id == "" || strings.Contains(id, "/") {
		writeHumaError(w, http.StatusNotFound, "not_found", "unknown review batch")
		return
	}
	job := js.byID(id)
	if job == nil {
		writeHumaError(w, http.StatusNotFound, "not_found", "unknown review batch")
		return
	}
	if js.s.authEnabled() {
		user, err := js.s.requireUser(r.Context())
		if err != nil {
			writeHumaError(w, http.StatusUnauthorized, "unauthenticated", "login is required")
			return
		}
		if job.owner != "" && job.owner != user.ID {
			writeHumaError(w, http.StatusNotFound, "not_found", "unknown review batch")
			return
		}
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "streaming is unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	sub := make(chan BatchProgress, 16)
	job.mu.Lock()
	job.subs[sub] = struct{}{}
	snapshot := job.progressLocked()
	job.mu.Unlock()
	defer func() {
		job.mu.Lock()
		delete(job.subs, sub)
		job.mu.Unlock()
	}()
	send := func(progress BatchProgress) bool {
		payload, _ := json.Marshal(progress)
		if _, err := fmt.Fprintf(w, "event: progress\ndata: %s\n\n", payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !send(snapshot) {
		return
	}
	if snapshot.Finished {
		return
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ":ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case update := <-sub:
			if !send(update) {
				return
			}
			if update.Finished {
				return
			}
		}
	}
}
