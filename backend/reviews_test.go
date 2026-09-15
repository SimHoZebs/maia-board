package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
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

func TestBatchSecondSubmitConflicts(t *testing.T) {
	s := batchServer(t, "hang")
	body := `{"requests":[` + sfBatchReq() + `]}`
	code, created := postBatch(t, s, body)
	if code != 202 {
		t.Fatalf("submit %d: %v", code, created)
	}
	id, _ := created["job_id"].(string)
	code, conflict := postBatch(t, s, body)
	if code != 409 {
		t.Fatalf("second submit %d, want 409: %v", code, conflict)
	}
	if conflict["code"] != "batch_busy" || conflict["job_id"] != id {
		t.Fatalf("conflict body: %v", conflict)
	}
	w := httptest.NewRecorder()
	s.reviews.reviewByID(w, httptest.NewRequest("DELETE", "/reviews/"+id, nil))
	if w.Code != 204 {
		t.Fatalf("delete %d", w.Code)
	}
	progress := awaitBatch(t, s, id)
	if !progress.Cancelled || !progress.Finished {
		t.Fatalf("cancelled batch: %+v", progress)
	}
}

func TestBatchUnknownID(t *testing.T) {
	s := batchServer(t, "ok")
	w := httptest.NewRecorder()
	s.reviews.reviewByID(w, httptest.NewRequest("GET", "/reviews/nope", nil))
	if w.Code != 404 {
		t.Fatalf("get %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.reviews.reviewByID(w, httptest.NewRequest("DELETE", "/reviews/nope", nil))
	if w.Code != 404 {
		t.Fatalf("delete %d", w.Code)
	}
	w = httptest.NewRecorder()
	s.reviews.reviewEvents(w, httptest.NewRequest("GET", "/reviews/nope/events", nil))
	if w.Code != 404 {
		t.Fatalf("events %d", w.Code)
	}
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
		_, _, err := s.executeSF(bg, bg, PriorityFocus, "", probe, false)
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
