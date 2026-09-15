package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// maxBatchRequests bounds one game: 256 plies x two engines. Intake
	// cache-filtering means the queued remainder is misses only.
	maxBatchRequests = 512
	// maxKeptJobs bounds in-memory history. Results stay queryable through
	// evaluations_v2 + lookup long after their job row is evicted.
	maxKeptJobs = 8
)

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
	status    batchStatus
	errMsg    string
}

type batchProgress struct {
	JobID     string            `json:"job_id"`
	Total     int               `json:"total"`
	Done      int               `json:"done"`
	Failed    int               `json:"failed"`
	Cancelled bool              `json:"cancelled"`
	Finished  bool              `json:"finished"`
	Errors    map[string]string `json:"errors,omitempty"`
}

type batchJob struct {
	id        string
	createdAt string
	entries   []*batchEntry
	done      int
	failed    int
	cancelled bool
	finished  bool
	eventID   int
	mu        sync.Mutex
	subs      map[chan []byte]struct{}
}

func (job *batchJob) progressLocked() batchProgress {
	progress := batchProgress{JobID: job.id, Total: len(job.entries), Done: job.done,
		Failed: job.failed, Cancelled: job.cancelled, Finished: job.finished}
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

// complete records one settled entry and notifies live subscribers. Dropped
// notifications are safe: event ids stay sequential, so a client that sees a
// gap reconciles with GET status + bulk lookup.
func (job *batchJob) complete(entry *batchEntry, errMsg string) {
	job.mu.Lock()
	if entry.status == batchPending || entry.status == batchRunning {
		if errMsg == "" {
			entry.status = batchDone
			job.done++
		} else {
			entry.status = batchFailed
			entry.errMsg = errMsg
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
}

func (job *batchJob) isCancelled() bool {
	job.mu.Lock()
	defer job.mu.Unlock()
	return job.cancelled
}

// ReviewJobs runs at most one whole-game batch at a time over the shared
// engine schedulers. Jobs are in-memory orchestration only: finished plies
// persist in evaluations_v2, so eviction or restart never loses computed
// work — the client resubmits and the intake filter skips cached rows.
type ReviewJobs struct {
	mu     sync.Mutex
	jobs   map[string]*batchJob
	order  []string
	active string
	s      *server
}

func NewReviewJobs(s *server) *ReviewJobs {
	return &ReviewJobs{jobs: make(map[string]*batchJob), s: s}
}

func (js *ReviewJobs) byID(id string) *batchJob {
	js.mu.Lock()
	defer js.mu.Unlock()
	return js.jobs[id]
}

func (js *ReviewJobs) activeProgress() (batchProgress, bool) {
	js.mu.Lock()
	defer js.mu.Unlock()
	if js.active == "" {
		return batchProgress{}, false
	}
	job, ok := js.jobs[js.active]
	if !ok {
		js.active = ""
		return batchProgress{}, false
	}
	return job.snapshot(), true
}

// resolveBatchEntry validates one batch request exactly like the sync
// endpoints + lookup do, and reports whether its row is already cached.
func (js *ReviewJobs) resolveBatchEntry(index int, query lookupRequest) (*batchEntry, bool, *requestError) {
	entry := &batchEntry{index: index, engine: query.Engine, status: batchPending}
	if query.Moves == nil {
		return nil, false, &requestError{"invalid_request", fmt.Sprintf("requests[%d]: moves must be an array", index)}
	}
	switch query.Engine {
	case "sf":
		request := evaluationRequest{FEN: query.FEN, InitialFEN: query.InitialFEN, Moves: query.Moves, Settings: query.Settings}
		if err := validateEvaluationRequest(&request); err != nil {
			return nil, false, &requestError{"invalid_request", fmt.Sprintf("requests[%d]: %s", index, err.Message)}
		}
		if query.EloMaia != nil || query.EloUser != nil || query.Model != "" {
			return nil, false, &requestError{"invalid_request", fmt.Sprintf("requests[%d]: Stockfish request contains Maia settings", index)}
		}
		entry.evalReq = request
		if _, ok := js.s.cachedSF(request); ok {
			return entry, true, nil
		}
	case "maia":
		_, side, _ := normalizeFEN(query.FEN)
		color := "white"
		if side == "b" {
			color = "black"
		}
		request, model, err := validateMoveRequest(moveRequest{FEN: query.FEN, InitialFEN: query.InitialFEN,
			Moves: query.Moves, EloMaia: query.EloMaia, EloUser: query.EloUser, Model: query.Model, MaiaColor: color})
		if err != nil {
			var reqErr *requestError
			message := "position or move history is invalid"
			if errors.As(err, &reqErr) {
				message = reqErr.Message
			}
			return nil, false, &requestError{"invalid_request", fmt.Sprintf("requests[%d]: %s", index, message)}
		}
		if query.Settings != nil {
			return nil, false, &requestError{"invalid_request", fmt.Sprintf("requests[%d]: Maia request contains Stockfish settings", index)}
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
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must be a valid batch object")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must contain one JSON object")
		return
	}
	if body.Requests == nil || len(body.Requests) == 0 || len(body.Requests) > maxBatchRequests {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf("requests must contain 1 to %d entries", maxBatchRequests))
		return
	}
	// One batch drains at a time; a second submitter gets the running job
	// id + progress so it can wait, poll, or replace explicitly.
	if progress, busy := js.activeProgress(); busy && !progress.Finished {
		w.Header().Set("Retry-After", "5")
		writeJSON(w, http.StatusConflict, map[string]any{
			"code": "batch_busy", "message": "another review batch is running",
			"job_id": progress.JobID, "progress": progress,
		})
		return
	}
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
	id, err := newGameID()
	if err != nil {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "could not start review batch")
		return
	}
	job := &batchJob{id: id, createdAt: time.Now().UTC().Format(time.RFC3339Nano),
		entries: entries, subs: make(map[chan []byte]struct{})}
	job.done = cached
	js.mu.Lock()
	js.jobs[id] = job
	js.order = append(js.order, id)
	js.active = id
	for len(js.order) > maxKeptJobs {
		oldest := js.order[0]
		js.order = js.order[1:]
		if oldest == id {
			js.order = append(js.order, oldest)
			break
		}
		if old, ok := js.jobs[oldest]; ok && old.snapshot().Finished {
			delete(js.jobs, oldest)
		} else if ok {
			js.order = append(js.order, oldest)
			break
		}
	}
	js.mu.Unlock()
	go js.drain(job)
	pending := len(entries) - cached
	writeJSON(w, http.StatusAccepted, map[string]any{
		"job_id": id, "total": len(entries), "cached": cached, "pending": pending,
	})
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
	switch r.Method {
	case http.MethodGet:
		job := js.byID(id)
		if job == nil {
			writeAPIError(w, http.StatusNotFound, "not_found", "unknown review batch")
			return
		}
		writeJSON(w, http.StatusOK, job.snapshot())
	case http.MethodDelete:
		job := js.byID(id)
		if job == nil {
			writeAPIError(w, http.StatusNotFound, "not_found", "unknown review batch")
			return
		}
		job.mu.Lock()
		job.cancelled = true
		job.mu.Unlock()
		js.s.pool.cancelBatch(id)
		if js.s.evaluator != nil {
			js.s.evaluator.sched.CancelBatch(id)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or DELETE is required")
	}
}

// drain executes one engine lane at a time per engine type (matching the
// single-slot engines) with the two types in parallel. Work runs on detached
// contexts: a disconnected client neither stops the batch nor leaks its slot,
// and an explicit DELETE only drops queued tickets — a running op still
// writes through to the cache.
func (js *ReviewJobs) drain(job *batchJob) {
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
				if job.isCancelled() {
					job.complete(entry, "cancelled")
					continue
				}
				if engine == "sf" {
					js.runSFEntry(job, entry)
				} else {
					js.runMaiaEntry(job, entry)
				}
			}
		}()
	}
	wg.Wait()
	job.mu.Lock()
	job.finished = true
	job.eventID++
	payload, _ := json.Marshal(map[string]any{
		"id": job.eventID, "event": "progress", "progress": job.progressLocked(),
	})
	for sub := range job.subs {
		select {
		case sub <- payload:
		default:
		}
	}
	job.mu.Unlock()
	js.mu.Lock()
	if js.active == job.id {
		js.active = ""
	}
	js.mu.Unlock()
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
	return true
}

func batchErrMessage(err error) string {
	var reqErr *requestError
	if errors.As(err, &reqErr) {
		return reqErr.Message
	}
	return sanitizeError(err.Error())
}

func (js *ReviewJobs) runSFEntry(job *batchJob, entry *batchEntry) {
	if js.s.evaluator == nil {
		job.complete(entry, "Stockfish is unavailable")
		return
	}
	if _, ok := js.s.cachedSF(entry.evalReq); ok {
		job.complete(entry, "")
		return
	}
	bg := context.Background()
	for attempt := 0; attempt < 2; attempt++ {
		result, release, err := js.s.evaluator.run(bg, bg, PriorityBatch, job.id, entry.evalReq)
		if err != nil {
			if errors.Is(err, ErrJoined) {
				if _, ok := js.s.cachedSF(entry.evalReq); ok {
					job.complete(entry, "")
					return
				}
				continue
			}
			if errors.Is(err, ErrSuperseded) || errors.Is(err, context.Canceled) {
				job.complete(entry, "cancelled")
				return
			}
			job.complete(entry, batchErrMessage(err))
			return
		}
		result.ActualSettings = entry.evalReq.Settings
		hash, key := sfIdentity(entry.evalReq).coordinates()
		js.s.storeCache(hash, "sf", key, result)
		if release != nil {
			release()
		}
		job.complete(entry, "")
		return
	}
	job.complete(entry, "evaluation did not settle")
}

func (js *ReviewJobs) runMaiaEntry(job *batchJob, entry *batchEntry) {
	if _, ok := js.s.cachedMaia(entry.maiaReq, entry.maiaModel); ok {
		job.complete(entry, "")
		return
	}
	bg := context.Background()
	for attempt := 0; attempt < 2; attempt++ {
		result, release, used, degraded, err := js.s.pool.predict(bg, bg, PriorityBatch, job.id, entry.maiaModel, entry.maiaReq)
		if err != nil {
			// Operation errors arrive with a grant (nothing was stored);
			// admission failures and joins carry none.
			if release != nil {
				release()
			}
			if errors.Is(err, ErrJoined) {
				if _, ok := js.s.cachedMaia(entry.maiaReq, entry.maiaModel); ok {
					job.complete(entry, "")
					return
				}
				continue
			}
			if errors.Is(err, ErrSuperseded) || errors.Is(err, context.Canceled) {
				job.complete(entry, "cancelled")
				return
			}
			job.complete(entry, batchErrMessage(err))
			return
		}
		response := moveResponse{Move: result.Move, WDL: result.WDL, ModelUsed: used, Degraded: degraded}
		for _, candidate := range result.Candidates {
			response.TopMoves = append(response.TopMoves, topMove{Move: candidate.Move, Prob: candidate.Policy})
		}
		if degraded {
			if release != nil {
				release()
			}
			job.complete(entry, "degraded fallback is not cached; retry as live analysis")
			return
		}
		if !validMoveValue(response, entry.maiaModel, true) {
			if release != nil {
				release()
			}
			job.complete(entry, "invalid Maia worker response")
			return
		}
		hash, key := maiaIdentity(entry.maiaReq, entry.maiaModel).coordinates()
		js.s.storeCache(hash, "maia", key, response)
		if release != nil {
			release()
		}
		job.complete(entry, "")
		return
	}
	job.complete(entry, "evaluation did not settle")
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
