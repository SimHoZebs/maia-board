package main

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
// /evaluate, and /reviews entries. Lookup reuses resolve read-only (no admission, no store).
// Live callers pass strictBatch=false (forgiving: 79M→5M degraded fallback is
// served but never cached); batch entries pass strictBatch=true (per-index
// failure so live can retry). Both engines keep one timeout policy each
// (Worker.startWait/moveWait, Evaluator.timeout); admission lives inside
// predict/run. Work runs on detached contexts so disconnects never leak slots
// and granted ops still write through. Intake cache-filtering happens at
// batch submit (resolveBatchEntry); write-through happens inside execute.
func resolveSFQuery(query lookupRequest) (evaluationRequest, *requestError) {
	if query.Moves == nil {
		return evaluationRequest{}, &requestError{"invalid_request", "moves must be an array"}
	}
	if query.EloMaia != nil || query.EloUser != nil || query.Model != "" {
		return evaluationRequest{}, &requestError{"invalid_request", "Stockfish request contains Maia settings"}
	}
	req := evaluationRequest{FEN: query.FEN, InitialFEN: query.InitialFEN, Moves: query.Moves, Settings: query.Settings}
	if err := validateEvaluationRequest(&req); err != nil {
		return evaluationRequest{}, &requestError{"invalid_request", err.Message}
	}
	return req, nil
}

func resolveMaiaQuery(query lookupRequest) (EngineRequest, string, *requestError) {
	if query.Moves == nil {
		return EngineRequest{}, "", &requestError{"invalid_request", "moves must be an array"}
	}
	if query.Settings != nil {
		return EngineRequest{}, "", &requestError{"invalid_request", "Maia request contains Stockfish settings"}
	}
	_, side, _ := normalizeFEN(query.FEN)
	color := "white"
	if side == "b" {
		color = "black"
	}
	req, model, err := validateMoveRequest(moveRequest{FEN: query.FEN, InitialFEN: query.InitialFEN,
		Moves: query.Moves, EloMaia: query.EloMaia, EloUser: query.EloUser, Model: query.Model, MaiaColor: color})
	if err != nil {
		message := "position or move history is invalid"
		if reqErr, ok := errors.AsType[*requestError](err); ok {
			message = reqErr.Message
		}
		return EngineRequest{}, "", &requestError{"invalid_request", message}
	}
	return req, model, nil
}

// engineExecutor unifies the Stockfish and Maia execute paths behind one
// contract: cache-read, run, validate, store, with degraded policy handled
// generically (SF never degrades; Maia live serves degraded without caching,
// batch fails per-index). Both engines keep one timeout policy each;
// admission lives inside runLive.
type engineExecutor[T any] interface {
	loadCached() (T, bool)
	runLive(waitCtx, execCtx context.Context, prio Priority, submitSeq uint64) (result T, release func(), degraded bool, err error)
	validate(T) error
	store(T)
}

// executeWithRetry runs cache→predict→validate→store→release with up to 3
// ErrJoined retries. Release is exactly-once: runLive's grant is released
// after store (or on every error/degraded path) before the next admission,
// so batch entries yield to interactive lanes between entries.
func executeWithRetry[T any](ex engineExecutor[T], waitCtx, execCtx context.Context, prio Priority, submitSeq uint64, strictBatch bool) (T, bool, error) {
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
			if errors.Is(err, ErrJoined) {
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
	s   *server
	req evaluationRequest
}

func (e sfExecutor) loadCached() (*evaluationResponse, bool) { return e.s.cachedSF(e.req) }

func (e sfExecutor) runLive(waitCtx, execCtx context.Context, prio Priority, submitSeq uint64) (result *evaluationResponse, release func(), degraded bool, err error) {
	if e.s.evaluator == nil {
		// Cache-only path (e.g. evaluator absent): hits serve, misses fail.
		return nil, nil, false, errors.New("Stockfish is unavailable")
	}
	result, release, err = e.s.evaluator.run(waitCtx, execCtx, prio, submitSeq, e.req)
	if err != nil {
		return nil, release, false, err
	}
	result.ActualSettings = e.req.Settings
	return result, release, false, nil
}

func (e sfExecutor) validate(*evaluationResponse) error { return nil }

func (e sfExecutor) store(result *evaluationResponse) {
	hash, key := sfIdentity(e.req).coordinates()
	e.s.storeCache(hash, "sf", key, result)
}

type maiaExecutor struct {
	s        *server
	req      EngineRequest
	model    string
	useCache bool
}

func (e maiaExecutor) loadCached() (moveResponse, bool) {
	if !e.useCache {
		return moveResponse{}, false
	}
	if cached, ok := e.s.cachedMaia(e.req, e.model); ok {
		return *cached, true
	}
	return moveResponse{}, false
}

func (e maiaExecutor) runLive(waitCtx, execCtx context.Context, prio Priority, submitSeq uint64) (response moveResponse, release func(), degraded bool, err error) {
	result, release, used, degraded, err := e.s.pool.predict(waitCtx, execCtx, prio, submitSeq, e.model, e.req)
	if err != nil {
		return moveResponse{}, release, false, err
	}
	response = moveResponse{Move: result.Move, WDL: result.WDL, ModelUsed: used, Degraded: degraded}
	for _, candidate := range result.Candidates {
		response.TopMoves = append(response.TopMoves, topMove{Move: candidate.Move, Prob: candidate.Policy, WDL: candidate.WDL})
	}
	return response, release, degraded, nil
}

func (e maiaExecutor) validate(response moveResponse) error {
	if !validMoveValue(response, e.model, e.useCache) {
		return errors.New("invalid Maia worker response")
	}
	return nil
}

func (e maiaExecutor) store(response moveResponse) {
	if !e.useCache {
		return
	}
	hash, key := maiaIdentity(e.req, e.model).coordinates()
	e.s.storeCache(hash, "maia", key, response)
}

// executeSF runs one Stockfish search with join-retry and write-through.
// Returns hit=true when served from cache. strictBatch is kept for symmetry
// (SF has no degraded fallback); both modes store and serve identically.
// submitSeq orders batch-lane tickets; sync callers pass 0.
func (s *server) executeSF(waitCtx, execCtx context.Context, prio Priority, submitSeq uint64, req evaluationRequest, strictBatch bool) (*evaluationResponse, bool, error) {
	return executeWithRetry[(*evaluationResponse)](sfExecutor{s: s, req: req}, waitCtx, execCtx, prio, submitSeq, strictBatch)
}

// executeMaia runs one Maia inference with join-retry and write-through.
// Returns hit=true when served from cache. Live (strictBatch=false) serves
// degraded 79M→5M fallback without caching; batch (strictBatch=true) fails
// per-index so the position can be retried live. submitSeq orders batch-lane
// tickets; sync callers pass 0.
func (s *server) executeMaia(waitCtx, execCtx context.Context, prio Priority, submitSeq uint64, req EngineRequest, model string, strictBatch bool) (moveResponse, bool, error) {
	return executeWithRetry[moveResponse](maiaExecutor{s: s, req: req, model: model, useCache: req.Temperature == 0}, waitCtx, execCtx, prio, submitSeq, strictBatch)
}

type batchStatus string

const (
	batchPending batchStatus = "pending"
	batchRunning batchStatus = "running"
	batchDone    batchStatus = "done"
	batchFailed  batchStatus = "failed"
)

type batchEntry struct {
	index     int
	engine    string
	evalReq   evaluationRequest
	maiaReq   EngineRequest
	maiaModel string
	// submitSeq is the batch-lane ordering nonce (§1): one process-wide
	// atomic increment per accepted submit, shared by all its entries.
	// Never exposed via API or logs. Set at intake AFTER the cap pass.
	submitSeq uint64
	status    batchStatus
	errMsg    string
	started   time.Time
}

type batchProgress struct {
	JobID    string            `json:"job_id"`
	Total    int               `json:"total"`
	Done     int               `json:"done"`
	Failed   int               `json:"failed"`
	Finished bool              `json:"finished"`
	Errors   map[string]string `json:"errors,omitempty"`
}

type batchJob struct {
	id        string
	createdAt string
	entries   []*batchEntry
	done      int
	failed    int
	finished  bool
	eventID   int
	mu        sync.Mutex
	subs      map[chan []byte]struct{}
}

func (job *batchJob) progressLocked() batchProgress {
	progress := batchProgress{JobID: job.id, Total: len(job.entries), Done: job.done,
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

func (job *batchJob) snapshot() batchProgress {
	job.mu.Lock()
	defer job.mu.Unlock()
	return job.progressLocked()
}

// complete records one settled entry, notifies live subscribers, and emits
// the per-entry timing line. Those lines are the batch equivalent of the
// per-request move/evaluate lines: `docker logs` (Komodo) shows the
// per-index latency curve, where a second-half cliff points at
// ply-correlated cost and flat-but-slow lines point at the search budget.
func (job *batchJob) complete(entry *batchEntry, errMsg string) {
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
	job.eventID++
	payload, _ := json.Marshal(map[string]any{
		"id": job.eventID, "event": "progress", "progress": job.progressLocked(),
		"index": entry.index, "status": string(entry.status),
	})
	for sub := range job.subs {
		select {
		case sub <- payload:
		default:
		}
	}
	job.mu.Unlock()
	log.Printf("review-batch entry job=%s index=%d engine=%s status=%s duration_ms=%d err=%s",
		job.id, entry.index, entry.engine, status, time.Since(entry.started).Milliseconds(), errMsg)
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
	s     *server
}

func NewReviewJobs(s *server) *ReviewJobs {
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

// snapshotCounts scans unfinished jobs under js.mu and returns the
// accepted-but-unresolved tallies per scheduler plus the unfinished-job
// count. Fast O(records): entries are only counted, never resolved here.
func (js *ReviewJobs) snapshotCounts() (unfinished, sf, large, small int) {
	js.mu.Lock()
	defer js.mu.Unlock()
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

func writeEngineBusy(w http.ResponseWriter, unfinished, sf, large, small int) {
	w.Header().Set("Retry-After", "5")
	log.Printf("review-batch busy unfinished=%d sf_queue=%d large_queue=%d small_queue=%d",
		unfinished, sf, large, small)
	writeJSON(w, http.StatusTooManyRequests, map[string]any{
		"code": "engine_busy", "message": "review queue depth exceeded, retry later",
	})
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

// resolveBatchEntry validates one batch request exactly like the sync
// endpoints + lookup do (via the shared resolve), and reports whether its
// row is already cached (intake cache-filter).
func (js *ReviewJobs) resolveBatchEntry(index int, query lookupRequest) (*batchEntry, bool, *requestError) {
	entry := &batchEntry{index: index, engine: query.Engine, status: batchPending}
	prefix := fmt.Sprintf("requests[%d]: ", index)
	switch query.Engine {
	case "sf":
		request, reqErr := resolveSFQuery(query)
		if reqErr != nil {
			return nil, false, &requestError{"invalid_request", prefix + reqErr.Message}
		}
		entry.evalReq = request
		if _, ok := js.s.cachedSF(request); ok {
			return entry, true, nil
		}
	case "maia":
		request, model, reqErr := resolveMaiaQuery(query)
		if reqErr != nil {
			return nil, false, &requestError{"invalid_request", prefix + reqErr.Message}
		}
		entry.maiaReq, entry.maiaModel = request, model
		if _, ok := js.s.cachedMaia(request, model); ok {
			return entry, true, nil
		}
	default:
		return nil, false, &requestError{"invalid_request", fmt.Sprintf("requests[%d]: engine must be sf or maia", index)}
	}
	return entry, false, nil
}

func (js *ReviewJobs) reviews(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST is required")
		return
	}
	if js.s.store == nil {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	var body struct {
		Requests []lookupRequest `json:"requests"`
	}
	decoded, ok := decodeSingle[struct {
		Requests []lookupRequest `json:"requests"`
	}](w, r, 4*1024*1024)
	if !ok {
		return
	}
	body = decoded
	if body.Requests == nil || len(body.Requests) == 0 || len(body.Requests) > maxBatchRequests {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf("requests must contain 1 to %d entries", maxBatchRequests))
		return
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
		for index, query := range body.Requests {
			entry, hit, invalid := js.resolveBatchEntry(index, query)
			if invalid != nil {
				writeAPIError(w, http.StatusBadRequest, invalid.Code, invalid.Message)
				return
			}
			if entry.engine == "sf" && !hit {
				sfMiss = true
			}
			if hit {
				entry.status = batchDone
				cached++
			}
			entries = append(entries, entry)
		}
		// The sync /evaluate endpoint serves cache hits without an evaluator;
		// batches are identical: only sf misses need live inference.
		if sfMiss && js.s.evaluator == nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "Stockfish is unavailable")
			return
		}
		newSF, newLarge, newSmall := countMisses(entries)
		js.mu.Lock()
		unfinished, sf, large, small := 0, 0, 0, 0
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
		if overCap(unfinished, sf, large, small, newSF, newLarge, newSmall) {
			js.mu.Unlock()
			if attempt == 0 {
				continue
			}
			writeEngineBusy(w, unfinished, sf, large, small)
			return
		}
		// Cap pass: consume one ordering nonce for the whole submit (§1).
		// Rejected submits consume nothing.
		seq := nextSubmitSeq()
		for _, e := range entries {
			e.submitSeq = seq
		}
		id, err := newGameID()
		if err != nil {
			js.mu.Unlock()
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "could not start review batch")
			return
		}
		job := &batchJob{id: id, createdAt: time.Now().UTC().Format(time.RFC3339Nano),
			entries: entries, subs: make(map[chan []byte]struct{})}
		job.done = cached
		js.jobs[id] = job
		js.order = append(js.order, id)
		js.evictLocked(id)
		js.mu.Unlock()
		go js.drain(job)
		pending := len(entries) - cached
		log.Printf("review-batch submit job=%s total=%d cached=%d pending=%d", id, len(entries), cached, pending)
		writeJSON(w, http.StatusAccepted, map[string]any{
			"job_id": id, "total": len(entries), "cached": cached, "pending": pending,
		})
		return
	}
}

// reviewRouter splits /reviews/:id from /reviews/:id/events.
func (js *ReviewJobs) reviewRouter(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/reviews/")
	if id, found := strings.CutSuffix(rest, "/events"); found {
		r.URL.Path = "/reviews/" + id + "/events"
		js.reviewEvents(w, r)
		return
	}
	js.reviewByID(w, r)
}

func (js *ReviewJobs) reviewByID(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/reviews/")
	if id == "" || strings.Contains(id, "/") {
		writeAPIError(w, http.StatusNotFound, "not_found", "unknown review batch")
		return
	}
	// No DELETE: the route falls to the 405 default (§3). Old-tab teardowns
	// already swallow teardown failures.
	switch r.Method {
	case http.MethodGet:
		job := js.byID(id)
		if job == nil {
			writeAPIError(w, http.StatusNotFound, "not_found", "unknown review batch")
			return
		}
		writeJSON(w, http.StatusOK, job.snapshot())
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET is required")
	}
}

// drain executes one engine lane at a time per engine type (matching the
// single-slot engines) with the two types in parallel. Work runs on detached
// contexts: a disconnected client neither stops the batch nor leaks its slot.
//
// Batch yield: each entry holds its engine slot only for that entry. After
// the write-through the slot is released before the next entry is admitted,
// so pumpLocked grants any waiting Play/Focus ticket next (Play>Focus>Batch).
// Interactive work therefore waits at most one batch op.
func (js *ReviewJobs) drain(job *batchJob) {
	started := time.Now()
	var wg sync.WaitGroup
	for _, engine := range []string{"sf", "maia"} {
		engine := engine
		if !job.hasPending(engine) {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			for _, entry := range job.entries {
				if entry.engine != engine || !job.claim(entry) {
					continue
				}
				js.runEntry(job, entry)
			}
		}()
	}
	wg.Wait()
	job.mu.Lock()
	job.finished = true
	progress := job.progressLocked()
	job.eventID++
	payload, _ := json.Marshal(map[string]any{
		"id": job.eventID, "event": "progress", "progress": progress,
	})
	for sub := range job.subs {
		select {
		case sub <- payload:
		default:
		}
	}
	job.mu.Unlock()
	log.Printf("review-batch finish job=%s done=%d failed=%d duration_ms=%d",
		job.id, progress.Done, progress.Failed, time.Since(started).Milliseconds())
}

func (job *batchJob) hasPending(engine string) bool {
	job.mu.Lock()
	defer job.mu.Unlock()
	for _, entry := range job.entries {
		if entry.engine == engine && entry.status == batchPending {
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
	if reqErr, ok := errors.AsType[*requestError](err); ok {
		return reqErr.Message
	}
	return sanitizeError(err.Error())
}

// runEntry executes one batch entry through the shared executor table.
// Each entry holds its engine slot only for that entry; the slot is released
// inside execute before the next entry is admitted, so interactive work waits
// at most one batch op. Per-index completion (with job correlation) stays in
// job.complete, which emits the per-entry timing line.
func (js *ReviewJobs) runEntry(job *batchJob, entry *batchEntry) {
	bg := context.Background()
	runners := map[string]func() error{
		"sf": func() error {
			_, _, err := js.s.executeSF(bg, bg, PriorityBatch, entry.submitSeq, entry.evalReq, true)
			return err
		},
		"maia": func() error {
			_, _, err := js.s.executeMaia(bg, bg, PriorityBatch, entry.submitSeq, entry.maiaReq, entry.maiaModel, true)
			return err
		},
	}
	run, ok := runners[entry.engine]
	if !ok {
		job.complete(entry, "unknown engine")
		return
	}
	if err := run(); err != nil {
		job.complete(entry, batchErrMessage(err))
		return
	}
	job.complete(entry, "")
}

// reviewEvents streams live progress as server-sent events. The opening
// snapshot makes reconnects self-healing: a client that sees an event-id gap
// reconciles with GET status + bulk lookup instead of trusting the stream.
func (js *ReviewJobs) reviewEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET is required")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/reviews/")
	id = strings.TrimSuffix(id, "/events")
	if id == "" || strings.Contains(id, "/") {
		writeAPIError(w, http.StatusNotFound, "not_found", "unknown review batch")
		return
	}
	job := js.byID(id)
	if job == nil {
		writeAPIError(w, http.StatusNotFound, "not_found", "unknown review batch")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "streaming is unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	sub := make(chan []byte, 16)
	job.mu.Lock()
	job.subs[sub] = struct{}{}
	snapshot, eventID := job.progressLocked(), job.eventID
	job.mu.Unlock()
	defer func() {
		job.mu.Lock()
		delete(job.subs, sub)
		job.mu.Unlock()
	}()
	send := func(id int, progress batchProgress) bool {
		payload, _ := json.Marshal(map[string]any{"id": id, "event": "progress", "progress": progress})
		if _, err := fmt.Fprintf(w, "id: %d\nevent: progress\ndata: %s\n\n", id, payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !send(eventID, snapshot) {
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
		case payload := <-sub:
			var envelope struct {
				ID       int           `json:"id"`
				Progress batchProgress `json:"progress"`
			}
			if err := json.Unmarshal(payload, &envelope); err != nil {
				continue
			}
			if !send(envelope.ID, envelope.Progress) {
				return
			}
			if envelope.Progress.Finished {
				return
			}
		}
	}
}
