package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func batchServer(t *testing.T, mode string) *server {
	t.Helper()
	large := &fakePredictor{result: engineFixture("e2e4")}
	small := &fakePredictor{result: engineFixture("e2e4")}
	s := &server{pool: NewEnginePool(large, small), evaluator: fakeEvaluator(t, mode), store: testStore(t)}
	s.reviews = NewReviewJobs(s)
	return s
}

// Batch requests carry the full lookup shape, including initial_fen.
func sfBatchReq() string {
	return fmt.Sprintf(`{"engine":"sf","fen":"%s","initial_fen":"%s","moves":[]}`, startFEN, startFEN)
}

func maiaBatchReq() string {
	return fmt.Sprintf(`{"engine":"maia","fen":"%s","initial_fen":"%s","moves":[],"elo_maia":1500,"elo_user":1500,"model":"79m"}`, startFEN, startFEN)
}

func postBatch(t *testing.T, s *server, body string) (int, map[string]any) {
	t.Helper()
	w := httptest.NewRecorder()
	s.reviews.reviews(w, httptest.NewRequest("POST", "/reviews", strings.NewReader(body)))
	var decoded map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &decoded)
	return w.Code, decoded
}

func getBatch(t *testing.T, s *server, id string) (int, batchProgress) {
	t.Helper()
	w := httptest.NewRecorder()
	s.reviews.reviewByID(w, httptest.NewRequest("GET", "/reviews/"+id, nil))
	var progress batchProgress
	_ = json.Unmarshal(w.Body.Bytes(), &progress)
	return w.Code, progress
}

func awaitBatch(t *testing.T, s *server, id string) batchProgress {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		code, progress := getBatch(t, s, id)
		if code != 200 {
			t.Fatalf("status %d for %s", code, id)
		}
		if progress.Finished {
			return progress
		}
		if time.Now().After(deadline) {
			t.Fatalf("batch %s never finished: %+v", id, progress)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestBatchValidation(t *testing.T) {
	s := batchServer(t, "ok")
	badEngine := fmt.Sprintf(`{"requests":[{"engine":"xx","fen":"%s","initial_fen":"%s","moves":[]}]}`, startFEN, startFEN)
	nilMoves := fmt.Sprintf(`{"requests":[{"engine":"sf","fen":"%s","initial_fen":"%s"}]}`, startFEN, startFEN)
	maiaInSF := fmt.Sprintf(`{"requests":[{"engine":"sf","fen":"%s","initial_fen":"%s","moves":[],"model":"79m"}]}`, startFEN, startFEN)
	sfInMaia := fmt.Sprintf(`{"requests":[{"engine":"maia","fen":"%s","initial_fen":"%s","moves":[],"elo_maia":1500,"elo_user":1500,"model":"79m","settings":{"time_ms":750,"lines":2}}]}`, startFEN, startFEN)
	tooLong := fmt.Sprintf(`{"requests":[{"engine":"sf","fen":"%s","initial_fen":"%s","moves":[%s]}]}`, startFEN, startFEN, strings.Repeat(`"e2e4",`, 257)+`"e2e4"`)
	for _, tc := range []struct {
		name, body string
	}{
		{"empty", `{"requests":[]}`},
		{"missing", `{}`},
		{"bad engine", badEngine},
		{"nil moves", nilMoves},
		{"maia in sf", maiaInSF},
		{"sf in maia", sfInMaia},
		{"too long", tooLong},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if code, _ := postBatch(t, s, tc.body); code != 400 {
				t.Fatalf("status %d, want 400", code)
			}
		})
	}
}

func TestBatchDrainsAndPersists(t *testing.T) {
	s := batchServer(t, "ok")
	body := `{"requests":[` + sfBatchReq() + `,` + maiaBatchReq() + `]}`
	code, created := postBatch(t, s, body)
	if code != 202 {
		t.Fatalf("submit %d: %v", code, created)
	}
	id, _ := created["job_id"].(string)
	if id == "" {
		t.Fatalf("no job id: %v", created)
	}
	progress := awaitBatch(t, s, id)
	if progress.Total != 2 || progress.Done != 2 || progress.Failed != 0 {
		t.Fatalf("progress: %+v", progress)
	}
	// Finished rows are ordinary cache rows visible to bulk lookup.
	lookupBody := `{"requests":[` + sfBatchReq() + `,` + maiaBatchReq() + `]}`
	w := httptest.NewRecorder()
	s.evaluationLookup(w, httptest.NewRequest("POST", "/evaluations/lookup", strings.NewReader(lookupBody)))
	var lookup struct {
		Results []lookupResult `json:"results"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &lookup); err != nil || len(lookup.Results) != 2 {
		t.Fatalf("lookup after batch: %d %s %v", w.Code, w.Body.String(), err)
	}
	// Resubmitting the same batch completes from cache with nothing pending.
	code, resubmitted := postBatch(t, s, body)
	if code != 202 || resubmitted["pending"].(float64) != 0 {
		t.Fatalf("resubmit %d: %v", code, resubmitted)
	}
}

func TestBatchConcurrentAdmits(t *testing.T) {
	s := batchServer(t, "ok")
	otherFEN := strings.Replace(startFEN, "w KQkq", "b KQkq", 1)
	body1 := fmt.Sprintf(`{"requests":[{"engine":"maia","fen":%q,"initial_fen":%q,"moves":[],"elo_maia":1500,"elo_user":1500,"model":"79m"}]}`,
		startFEN, startFEN)
	body2 := fmt.Sprintf(`{"requests":[{"engine":"maia","fen":%q,"initial_fen":%q,"moves":[],"elo_maia":1500,"elo_user":1500,"model":"79m"}]}`,
		otherFEN, otherFEN)
	code1, created1 := postBatch(t, s, body1)
	if code1 != 202 {
		t.Fatalf("first submit %d: %v", code1, created1)
	}
	id1, _ := created1["job_id"].(string)
	// No single-active gate: a second submit while the first drains admits.
	code2, created2 := postBatch(t, s, body2)
	if code2 != 202 {
		t.Fatalf("second submit %d, want 202: %v", code2, created2)
	}
	id2, _ := created2["job_id"].(string)
	if id1 == "" || id2 == "" || id1 == id2 {
		t.Fatalf("job ids: %q %q", id1, id2)
	}
	p1 := awaitBatch(t, s, id1)
	p2 := awaitBatch(t, s, id2)
	if p1.Done != 1 || p2.Done != 1 || p1.Finished != true || p2.Finished != true {
		t.Fatalf("concurrent batches: %+v %+v", p1, p2)
	}
}

func TestBatchUnknownID(t *testing.T) {
	s := batchServer(t, "ok")
	w := httptest.NewRecorder()
	s.reviews.reviewByID(w, httptest.NewRequest("GET", "/reviews/nope", nil))
	if w.Code != 404 {
		t.Fatalf("get %d", w.Code)
	}
	// No DELETE route: removed handler answers 405 via the default (§3),
	// even for unknown ids (DELETE-404 becomes DELETE-405).
	w = httptest.NewRecorder()
	s.reviews.reviewByID(w, httptest.NewRequest("DELETE", "/reviews/nope", nil))
	if w.Code != 405 {
		t.Fatalf("delete unknown %d, want 405", w.Code)
	}
	w = httptest.NewRecorder()
	s.reviews.reviewEvents(w, httptest.NewRequest("GET", "/reviews/nope/events", nil))
	if w.Code != 404 {
		t.Fatalf("events %d", w.Code)
	}
}

func TestBatchDeleteGone(t *testing.T) {
	s := batchServer(t, "ok")
	body := `{"requests":[` + sfBatchReq() + `]}`
	code, created := postBatch(t, s, body)
	if code != 202 {
		t.Fatalf("submit %d: %v", code, created)
	}
	id, _ := created["job_id"].(string)
	w := httptest.NewRecorder()
	s.reviews.reviewByID(w, httptest.NewRequest("DELETE", "/reviews/"+id, nil))
	if w.Code != 405 {
		t.Fatalf("delete known %d, want 405", w.Code)
	}
	// DELETE changes nothing: the job still drains to done.
	progress := awaitBatch(t, s, id)
	if !progress.Finished || progress.Done != 1 {
		t.Fatalf("job after DELETE 405: %+v", progress)
	}
}

func sfReqFEN(fen string) string {
	return fmt.Sprintf(`{"engine":"sf","fen":%q,"initial_fen":%q,"moves":[]}`, fen, fen)
}

func maiaReqFEN(fen, model string) string {
	return fmt.Sprintf(`{"engine":"maia","fen":%q,"initial_fen":%q,"moves":[],"elo_maia":1500,"elo_user":1500,"model":%q}`, fen, fen, model)
}

func postBatchRec(s *server, body string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	s.reviews.reviews(w, httptest.NewRequest("POST", "/reviews", strings.NewReader(body)))
	return w
}

func assertEngineBusy(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if w.Code != 429 {
		t.Fatalf("status %d, want 429: %s", w.Code, w.Body.String())
	}
	if w.Header().Get("Retry-After") != "5" {
		t.Fatalf("Retry-After %q, want 5", w.Header().Get("Retry-After"))
	}
	var decoded map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("429 body not JSON: %v", err)
	}
	if decoded["code"] != "engine_busy" {
		t.Fatalf("429 code %v, want engine_busy", decoded)
	}
	msg, _ := decoded["message"].(string)
	if !strings.Contains(msg, "queue depth") {
		t.Fatalf("429 message %q must name queue depth", msg)
	}
	lowered := strings.ToLower(w.Body.String())
	for _, leak := range []string{"submitseq", "submit_seq", "submit_seq", "batchcursor", "batch_cursor"} {
		if strings.Contains(lowered, leak) {
			t.Fatalf("429 body leaks ordering nonce: %s", w.Body.String())
		}
	}
	return decoded
}

// seedFakeJob inserts an unfinished (or finished) job with pending entries
// directly, without draining. Counts toward caps like a real draining job but
// never settles, keeping tests fast and deterministic.
func seedFakeJob(js *ReviewJobs, id string, finished bool, sfN, largeN, smallN int) {
	entries := []*batchEntry{}
	idx := 0
	for i := 0; i < sfN; i++ {
		entries = append(entries, &batchEntry{index: idx, engine: "sf", status: batchPending})
		idx++
	}
	for i := 0; i < largeN; i++ {
		entries = append(entries, &batchEntry{index: idx, engine: "maia", maiaModel: "79m", status: batchPending})
		idx++
	}
	for i := 0; i < smallN; i++ {
		entries = append(entries, &batchEntry{index: idx, engine: "maia", maiaModel: "5m", status: batchPending})
		idx++
	}
	if finished {
		for _, e := range entries {
			e.status = batchDone
		}
	}
	job := &batchJob{id: id, createdAt: "seed", entries: entries, subs: make(map[chan []byte]struct{}), finished: finished}
	if finished {
		job.done = len(entries)
	}
	js.mu.Lock()
	js.jobs[id] = job
	js.order = append(js.order, id)
	js.mu.Unlock()
}

func TestCountMisses(t *testing.T) {
	entries := []*batchEntry{
		{engine: "sf", status: batchPending},
		{engine: "sf", status: batchRunning},
		{engine: "sf", status: batchDone},
		{engine: "sf", status: batchFailed},
		{engine: "maia", maiaModel: "79m", status: batchPending},
		{engine: "maia", maiaModel: "5m", status: batchPending},
		{engine: "maia", maiaModel: "79m", status: batchDone},
		nil,
	}
	sf, large, small := countMisses(entries)
	if sf != 2 || large != 1 || small != 2 {
		t.Fatalf("countMisses sf=%d large=%d small=%d", sf, large, small)
	}
	// Large double-counts toward small (fallback-eligible).
	onlyLarge := []*batchEntry{{engine: "maia", maiaModel: "79m", status: batchPending}}
	if _, large, small := countMisses(onlyLarge); large != 1 || small != 1 {
		t.Fatalf("large fallback double-count large=%d small=%d", large, small)
	}
}

func TestOverCap(t *testing.T) {
	if !overCap(8, 0, 0, 0, 0, 0, 0) {
		t.Fatal("8 unfinished must be over cap")
	}
	if overCap(7, 0, 0, 0, 0, 0, 0) {
		t.Fatal("7 unfinished must pass")
	}
	if !overCap(0, maxBatchRequests, 0, 0, 1, 0, 0) {
		t.Fatal("sf maxBatchRequests+1 must be over cap")
	}
	if overCap(0, maxBatchRequests-1, 0, 0, 1, 0, 0) {
		t.Fatal("sf maxBatchRequests-1+1 must pass")
	}
	if !overCap(0, 0, 0, maxBatchRequests, 0, 0, 1) {
		t.Fatal("small maxBatchRequests+1 must be over cap")
	}
}

func TestEvictScansAnywhere(t *testing.T) {
	s := batchServer(t, "ok")
	js := s.reviews
	// Head is unfinished, middle + tail finished: head-only eviction would
	// stall, anywhere-scan must remove the first finished (mid).
	seedFakeJob(js, "u1", false, 1, 0, 0)
	seedFakeJob(js, "f1", true, 0, 0, 0)
	seedFakeJob(js, "f2", true, 0, 0, 0)
	for len(js.order) < maxKeptJobs+1 {
		seedFakeJob(js, fmt.Sprintf("pad%d", len(js.order)), true, 0, 0, 0)
	}
	js.mu.Lock()
	js.evictLocked("keep-new")
	still := map[string]bool{}
	for _, oid := range js.order {
		still[oid] = true
	}
	_, u1kept := js.jobs["u1"]
	js.mu.Unlock()
	if !still["u1"] || !u1kept {
		t.Fatal("unfinished head must be retained")
	}
	if still["f1"] {
		t.Fatalf("first finished anywhere must be evicted, order=%v", js.order)
	}
	if len(js.order) != maxKeptJobs {
		t.Fatalf("order len %d, want %d", len(js.order), maxKeptJobs)
	}
}

func TestBatchUnfinishedCap(t *testing.T) {
	s := batchServer(t, "ok")
	for i := 0; i < maxUnfinishedJobs; i++ {
		seedFakeJob(s.reviews, fmt.Sprintf("busy%d", i), false, 1, 0, 0)
	}
	w := postBatchRec(s, `{"requests":[`+sfBatchReq()+`]}`)
	assertEngineBusy(t, w)
	// Finished jobs do not count toward the cap.
	s2 := batchServer(t, "ok")
	for i := 0; i < maxUnfinishedJobs; i++ {
		seedFakeJob(s2.reviews, fmt.Sprintf("done%d", i), true, 1, 0, 0)
	}
	code, _ := postBatch(t, s2, `{"requests":[`+sfBatchReq()+`]}`)
	if code != 202 {
		t.Fatalf("finished jobs must not trip unfinished cap: %d", code)
	}
}

func TestBatchMissCapSF(t *testing.T) {
	s := batchServer(t, "ok")
	seedFakeJob(s.reviews, "fill", false, maxBatchRequests, 0, 0)
	w := postBatchRec(s, `{"requests":[`+sfBatchReq()+`]}`)
	assertEngineBusy(t, w)
	unfinished, sf, _, _ := s.reviews.snapshotCounts()
	if unfinished != 1 || sf != maxBatchRequests {
		t.Fatalf("snapshot unfinished=%d sf=%d", unfinished, sf)
	}
}

func TestBatchMissCapMaiaDoubleCounts(t *testing.T) {
	s := batchServer(t, "ok")
	// maxBatchRequests large-model misses fill both large and small (fallback-eligible).
	seedFakeJob(s.reviews, "fill-large", false, 0, maxBatchRequests, 0)
	otherFEN := strings.Replace(startFEN, "w KQkq", "b KQkq", 1)
	// Large-destined submit 429s on large.
	w := postBatchRec(s, `{"requests":[`+maiaReqFEN(otherFEN, "79m")+`]}`)
	assertEngineBusy(t, w)
	// 5m-destined submit 429s alike on small: no reservation.
	w = postBatchRec(s, `{"requests":[`+maiaReqFEN(otherFEN, "5m")+`]}`)
	assertEngineBusy(t, w)
	// Small-only fills leave large room.
	s2 := batchServer(t, "ok")
	seedFakeJob(s2.reviews, "fill-small", false, 0, 0, maxBatchRequests)
	w = postBatchRec(s2, `{"requests":[`+maiaReqFEN(otherFEN, "5m")+`]}`)
	assertEngineBusy(t, w)
	code, _ := postBatch(t, s2, `{"requests":[`+maiaReqFEN(otherFEN, "79m")+`]}`)
	// Large still has room (0 large used) but small is full and large
	// double-counts small, so this 429s too — on small, not large.
	if code != 429 {
		t.Fatalf("large miss past full small must 429, got %d", code)
	}
}

func TestBatchCachedHitsDontCount(t *testing.T) {
	s := batchServer(t, "ok")
	// Warm one Maia row, then fill schedulers with distinct misses.
	warm := `{"requests":[` + maiaReqFEN(startFEN, "79m") + `]}`
	code, warmed := postBatch(t, s, warm)
	if code != 202 {
		t.Fatalf("warm submit %d", code)
	}
	_ = awaitBatch(t, s, warmed["job_id"].(string))
	otherFEN := strings.Replace(startFEN, "w KQkq", "b KQkq", 1)
	seedFakeJob(s.reviews, "fill", false, 0, maxBatchRequests, 0)
	// All-hits resubmit passes despite full queues.
	w := postBatchRec(s, warm)
	if w.Code != 202 {
		t.Fatalf("cached-hits submit %d, want 202: %s", w.Code, w.Body.String())
	}
	// One more miss still 429s.
	w = postBatchRec(s, `{"requests":[`+maiaReqFEN(otherFEN, "79m")+`]}`)
	assertEngineBusy(t, w)
}

func TestBatchRaceRetryThen429(t *testing.T) {
	s := batchServer(t, "ok")
	// One slot of headroom: maxBatchRequests-1 of maxBatchRequests.
	seedFakeJob(s.reviews, "fill", false, maxBatchRequests-1, 0, 0)
	fenA := strings.Replace(startFEN, "0 1", "0 2", 1)
	fenB := strings.Replace(startFEN, "0 1", "0 3", 1)
	bodyA := `{"requests":[` + sfReqFEN(fenA) + `]}`
	bodyB := `{"requests":[` + sfReqFEN(fenB) + `]}`
	var wg sync.WaitGroup
	codes := make([]int, 2)
	wg.Add(2)
	go func() { defer wg.Done(); codes[0] = postBatchRec(s, bodyA).Code }()
	go func() { defer wg.Done(); codes[1] = postBatchRec(s, bodyB).Code }()
	wg.Wait()
	n202, n429 := 0, 0
	for _, c := range codes {
		if c == 202 {
			n202++
		} else if c == 429 {
			n429++
		}
	}
	if n202 != 1 || n429 != 1 {
		t.Fatalf("race codes %v, want one 202 + one 429", codes)
	}
	// Overshoot stays zero: exactly at cap, never past.
	_, sf, _, _ := s.reviews.snapshotCounts()
	if sf > maxBatchRequests {
		t.Fatalf("overshoot sf=%d", sf)
	}
}

func TestBatchSubmitSeqAssignedAndHidden(t *testing.T) {
	s := batchServer(t, "ok")
	before := submitSeqCounter.Load()
	code, created := postBatch(t, s, `{"requests":[`+sfBatchReq()+`]}`)
	if code != 202 {
		t.Fatalf("submit %d", code)
	}
	id, _ := created["job_id"].(string)
	if submitSeqCounter.Load() != before+1 {
		t.Fatalf("accepted submit must consume one nonce")
	}
	job := s.reviews.byID(id)
	if job == nil || len(job.entries) == 0 {
		t.Fatal("job missing")
	}
	seq := job.entries[0].submitSeq
	if seq == 0 {
		t.Fatal("submitSeq unset")
	}
	for _, e := range job.entries {
		if e.submitSeq != seq {
			t.Fatal("entries in one submit must share the stamp")
		}
	}
	// Rejected submits consume nothing.
	code, _ = postBatch(t, s, `{"requests":[{"engine":"xx"}]}`)
	if code != 400 {
		t.Fatalf("invalid %d", code)
	}
	seedFakeJob(s.reviews, "capfill", false, maxBatchRequests, 0, 0)
	otherFEN := strings.Replace(startFEN, "0 1", "0 2", 1)
	w := postBatchRec(s, `{"requests":[`+sfReqFEN(otherFEN)+`]}`)
	assertEngineBusy(t, w)
	if submitSeqCounter.Load() != before+1 {
		t.Fatalf("rejected submits must consume nothing")
	}
	// Non-exposure: absent from GET/SSE/429 bodies.
	gw := httptest.NewRecorder()
	s.reviews.reviewByID(gw, httptest.NewRequest("GET", "/reviews/"+id, nil))
	for _, body := range []string{gw.Body.String(), w.Body.String()} {
		lowered := strings.ToLower(body)
		if strings.Contains(lowered, "submitseq") || strings.Contains(lowered, "submit_seq") || strings.Contains(lowered, "batchcursor") || strings.Contains(lowered, "batch_cursor") {
			t.Fatalf("ordering nonce exposed: %s", body)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ew := httptest.NewRecorder()
	s.reviews.reviewEvents(ew, httptest.NewRequestWithContext(ctx, "GET", "/reviews/"+id+"/events", nil))
	lowered := strings.ToLower(ew.Body.String())
	if strings.Contains(lowered, "submitseq") || strings.Contains(lowered, "submit_seq") {
		t.Fatalf("SSE leaks ordering nonce: %s", ew.Body.String())
	}
	_ = awaitBatch(t, s, id)
}

func TestBatchEventsStreamSnapshot(t *testing.T) {
	s := batchServer(t, "ok")
	// Pre-warm the cache so the batch is fully settled at submit.
	warm := `{"requests":[` + sfBatchReq() + `]}`
	code, warmed := postBatch(t, s, warm)
	if code != 202 {
		t.Fatal("warmup submit failed")
	}
	_ = awaitBatch(t, s, warmed["job_id"].(string))
	code, created := postBatch(t, s, warm)
	if code != 202 {
		t.Fatalf("submit %d", code)
	}
	id, _ := created["job_id"].(string)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	w := httptest.NewRecorder()
	s.reviews.reviewEvents(w, httptest.NewRequestWithContext(ctx, "GET", "/reviews/"+id+"/events", nil))
	body, _ := io.ReadAll(w.Result().Body)
	text := string(body)
	if !strings.Contains(text, "event: progress") || !strings.Contains(text, id) {
		t.Fatalf("events missing snapshot: %q", text)
	}
	_ = awaitBatch(t, s, id)
}

// Batch drain yields to interactive between entries: a Focus request arriving
// mid-batch grants before the next batch entry (Play>Focus>Batch), so it
// completes before the whole batch finishes.
func TestBatchYieldsToInteractive(t *testing.T) {
	s := batchServer(t, "slow")
	otherFEN := strings.Replace(startFEN, "w KQkq", "b KQkq", 1)
	body := fmt.Sprintf(`{"requests":[{"engine":"sf","fen":%q,"initial_fen":%q,"moves":[]},{"engine":"sf","fen":%q,"initial_fen":%q,"moves":[]}]}`,
		startFEN, startFEN, otherFEN, otherFEN)
	code, created := postBatch(t, s, body)
	if code != 202 {
		t.Fatalf("submit %d: %v", code, created)
	}
	id, _ := created["job_id"].(string)
	// Let the first slow entry (≈300ms) own the slot.
	time.Sleep(100 * time.Millisecond)
	// Probe contends on the same Evaluator scheduler with a distinct,
	// consistent position (empty moves rooting at fen).
	thirdFEN := strings.Replace(startFEN, "0 1", "0 2", 1)
	probe := evaluationRequest{FEN: thirdFEN, InitialFEN: thirdFEN, Moves: []string{}}
	done := make(chan error, 1)
	go func() {
		bg := context.Background()
		_, _, err := s.executeSF(bg, bg, PriorityFocus, 0, probe, false)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("focus probe: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("focus probe starved by batch")
	}
	// Yield means the probe ran between batch entries: the batch must still
	// be draining when the probe finishes. Without yield the batch would hold
	// the slot across entries and finish before the probe starts.
	if _, prog := getBatch(t, s, id); prog.Finished {
		t.Fatal("batch finished before focus: no yield between entries")
	}
	progress := awaitBatch(t, s, id)
	if progress.Done != 2 {
		t.Fatalf("batch: %+v", progress)
	}
}
