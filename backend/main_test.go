package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidateMoveRequest(t *testing.T) {
	maiaElo, userElo := 1500, 1300
	request := moveRequest{
		FEN:       "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
		Moves:     []string{"e2e4"},
		EloMaia:   &maiaElo,
		EloUser:   &userElo,
		Model:     "79m",
		MaiaColor: "black",
	}
	engineRequest, model, err := validateMoveRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	if model != "79m" || engineRequest.SelfElo != 1500 || engineRequest.OppoElo != 1300 {
		t.Fatalf("unexpected request mapping: %+v, model=%s", engineRequest, model)
	}
}

func TestMoveHandlerPersistsAfterClientStopsWaiting(t *testing.T) {
	for _, tc := range []struct {
		name                                 string
		deadline, sampled, degraded, invalid bool
	}{
		{name: "canceled deterministic"},
		{name: "deadline deterministic", deadline: true},
		{name: "canceled sampled", sampled: true},
		{name: "canceled degraded", degraded: true},
		{name: "deadline invalid output", deadline: true, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			worker, started := persistentWorker(t)
			release := filepath.Join(t.TempDir(), "release")
			calls := filepath.Join(t.TempDir(), "calls")
			t.Setenv("MAIA_JSON_RELEASE", release)
			t.Setenv("MAIA_JSON_CALLS", calls)
			unavailable := &fakePredictor{err: errors.New("model unavailable")}
			pool := NewEnginePool(worker, unavailable)
			if tc.degraded {
				pool = NewEnginePool(unavailable, worker)
			}
			app := &server{pool: pool, store: testStore(t)}
			finished := make(chan int, 2)
			serverCanceled := make(chan struct{}, 1)
			mux := http.NewServeMux()
			mux.HandleFunc("/move", func(w http.ResponseWriter, r *http.Request) {
				stop := context.AfterFunc(r.Context(), func() {
					select {
					case serverCanceled <- struct{}{}:
					default:
					}
				})
				defer stop()
				rec := &statusRecorder{ResponseWriter: w, status: 200}
				app.move(rec, r)
				finished <- rec.status
			})
			mux.HandleFunc("/evaluations/lookup", app.evaluationLookup)
			httpServer := httptest.NewServer(mux)
			httpServer.Client().Timeout = 3 * time.Second
			t.Cleanup(func() { _ = os.WriteFile(release, []byte("ready"), 0600); httpServer.Close() })
			self, opponent := 10, 1
			if tc.invalid {
				opponent = 5
			}
			payload := moveRequest{FEN: startFEN, InitialFEN: startFEN, Moves: []string{}, EloMaia: &self, EloUser: &opponent, Model: "79m", MaiaColor: "white"}
			if tc.sampled {
				payload.Temperature = .7
			}
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			if tc.deadline {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 300*time.Millisecond)
			}
			defer cancel()
			request, err := http.NewRequestWithContext(ctx, http.MethodPost, httpServer.URL+"/move", strings.NewReader(string(body)))
			if err != nil {
				t.Fatal(err)
			}
			clientDone := make(chan error, 1)
			go func() {
				response, err := httpServer.Client().Do(request)
				if response != nil {
					_ = response.Body.Close()
				}
				clientDone <- err
			}()
			awaitPID(t, started) // The inference request is admitted and held in the helper.
			if !tc.deadline {
				cancel()
			}
			select {
			case err := <-clientDone:
				want := context.Canceled
				if tc.deadline {
					want = context.DeadlineExceeded
				}
				if !errors.Is(err, want) {
					t.Fatalf("client wait: %v, want %v", err, want)
				}
			case <-time.After(time.Second):
				t.Fatal("client did not stop waiting")
			}
			select {
			case <-serverCanceled:
			case <-time.After(time.Second):
				t.Fatal("server request context did not observe disconnect")
			}
			select {
			case <-finished:
				t.Fatal("handler returned before bounded inference settled")
			case <-time.After(30 * time.Millisecond):
			}
			if len(worker.slot) != 1 {
				t.Fatal("disconnected client released inference slot")
			}
			if err := os.WriteFile(release, []byte("ready"), 0600); err != nil {
				t.Fatal(err)
			}
			select {
			case status := <-finished:
				want := 200
				if tc.invalid {
					want = 502
				}
				if status != want {
					t.Fatalf("handler status=%d want=%d", status, want)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("bounded handler did not finish")
			}
			query := lookupRequest{Engine: "maia", FEN: startFEN, InitialFEN: startFEN, Moves: []string{}, EloMaia: &self, EloUser: &opponent, Model: "79m"}
			lookupBody, err := json.Marshal(map[string]any{"requests": []lookupRequest{query}})
			if err != nil {
				t.Fatal(err)
			}
			response, err := httpServer.Client().Post(httpServer.URL+"/evaluations/lookup", "application/json", strings.NewReader(string(lookupBody)))
			if err != nil {
				t.Fatal(err)
			}
			var result struct {
				Results []lookupResult `json:"results"`
			}
			err = json.NewDecoder(response.Body).Decode(&result)
			_ = response.Body.Close()
			if err != nil || response.StatusCode != 200 {
				t.Fatalf("lookup status=%d err=%v", response.StatusCode, err)
			}
			wantHit := !tc.sampled && !tc.degraded && !tc.invalid
			if (len(result.Results) == 1) != wantHit {
				t.Fatalf("persisted results=%+v wantHit=%t", result.Results, wantHit)
			}
			if wantHit {
				response, err = httpServer.Client().Post(httpServer.URL+"/move", "application/json", strings.NewReader(string(body)))
				if err != nil {
					t.Fatal(err)
				}
				_, _ = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
				if response.StatusCode != 200 || response.Header.Get("X-Eval-Cache") != "hit" {
					t.Fatalf("later request did not use persisted result: %v", response)
				}
			} else {
				count, _, err := app.store.cacheStats()
				if err != nil || count != 0 {
					t.Fatalf("ineligible output persisted count=%d error=%v", count, err)
				}
			}
			count, err := os.ReadFile(calls)
			if err != nil || string(count) != "1" {
				t.Fatalf("inferred again count=%q err=%v", count, err)
			}
		})
	}
}

func TestValidateMoveRequestRejectsNonMaiaTurn(t *testing.T) {
	maiaElo, userElo := 1500, 1300
	_, _, err := validateMoveRequest(moveRequest{
		FEN:       "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
		EloMaia:   &maiaElo,
		EloUser:   &userElo,
		MaiaColor: "white",
	})
	if err == nil || err.Error() != "not_maia_turn: fen side-to-move is not maia_color" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMoveCacheReadThrough(t *testing.T) {
	body := `{"fen":"` + startFEN + `","moves":[],"elo_maia":1600,"elo_user":1600,"model":"79m","maia_color":"white","cache_hash":"abc123","cache_key":"mk"}`
	store := testStore(t)
	wdl := [3]float64{0.2, 0.3, 0.5}
	live := &fakePredictor{result: EngineResult{Move: "e2e4", Candidates: []Candidate{{Move: "e2e4", Policy: 0.6, WDL: wdl}}, WDL: wdl}}
	s := &server{pool: NewEnginePool(live, live), store: store}
	// Miss: predicts live, stores the row, reports miss.
	w := httptest.NewRecorder()
	s.move(w, httptest.NewRequest(http.MethodPost, "/move", strings.NewReader(body)))
	if w.Code != http.StatusOK || w.Header().Get("X-Eval-Cache") != "miss" {
		t.Fatalf("miss: %d %s header=%q", w.Code, w.Body, w.Header().Get("X-Eval-Cache"))
	}
	first := w.Body.String()
	if live.calls != 1 {
		t.Fatalf("miss predicted %d times", live.calls)
	}
	// Hit: serves from SQLite without touching the pool.
	broken := &fakePredictor{err: errors.New("boom")}
	hit := &server{pool: NewEnginePool(broken, broken), store: store}
	w = httptest.NewRecorder()
	hit.move(w, httptest.NewRequest(http.MethodPost, "/move", strings.NewReader(body)))
	if w.Code != http.StatusOK || w.Header().Get("X-Eval-Cache") != "hit" {
		t.Fatalf("hit: %d %s header=%q", w.Code, w.Body, w.Header().Get("X-Eval-Cache"))
	}
	if normalizeJSON(t, w.Body.String()) != normalizeJSON(t, first) {
		t.Fatalf("cached body changed:\n%s\n%s", first, w.Body)
	}
	// Degraded fallback answers are never persisted.
	large := &fakePredictor{err: errors.New("79m failed")}
	small := &fakePredictor{result: EngineResult{Move: "e2e4", Candidates: []Candidate{{Move: "e2e4", Policy: 0.6, WDL: wdl}}, WDL: wdl}}
	degradedBody := `{"fen":"` + startFEN + `","moves":[],"elo_maia":1700,"elo_user":1600,"model":"79m","maia_color":"white","cache_hash":"def456","cache_key":"degraded"}`
	w = httptest.NewRecorder()
	(&server{pool: NewEnginePool(large, small), store: store}).move(w, httptest.NewRequest(http.MethodPost, "/move", strings.NewReader(degradedBody)))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"degraded":true`) {
		t.Fatalf("degraded: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	hit.move(w, httptest.NewRequest(http.MethodPost, "/move", strings.NewReader(degradedBody)))
	if w.Code == http.StatusOK && w.Header().Get("X-Eval-Cache") == "hit" {
		t.Fatal("degraded answer was persisted")
	}
}

func TestMoveCacheGuards(t *testing.T) {
	wdl := [3]float64{0.2, 0.3, 0.5}
	live := &fakePredictor{result: EngineResult{Move: "e2e4", Candidates: []Candidate{{Move: "e2e4", Policy: 0.6, WDL: wdl}}, WDL: wdl}}
	store := testStore(t)
	s := &server{pool: NewEnginePool(live, live), store: store}
	post := func(body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.move(w, httptest.NewRequest(http.MethodPost, "/move", strings.NewReader(body)))
		return w
	}
	base := `{"fen":"` + startFEN + `","moves":[],"elo_maia":1600,"elo_user":1600,"model":"79m","maia_color":"white"`
	seed := func(hash, value string) {
		// Corruption fixtures bypass the server-owned writer deliberately.
		hash, key := maiaIdentity(EngineRequest{FEN: startFEN, SelfElo: 1600, OppoElo: 1600}, "79m").coordinates()
		if _, err := store.cachePut(hash, "maia", key, value); err != nil {
			t.Fatal(err)
		}
	}
	// Degraded legacy rows are never served as hits.
	seed("aa01", `{"move":"e2e4","top_moves":[],"wdl":[0.2,0.3,0.5],"model_used":"79m","degraded":true}`)
	w := post(base + `,"cache_hash":"aa01","cache_key":"k"}`)
	if w.Code != http.StatusOK || w.Header().Get("X-Eval-Cache") != "miss" || live.calls != 1 {
		t.Fatalf("degraded hit: %d %s header=%q calls=%d", w.Code, w.Body, w.Header().Get("X-Eval-Cache"), live.calls)
	}
	// Rows stored under another model are never served as hits.
	seed("aa02", `{"move":"e2e4","top_moves":[],"wdl":[0.2,0.3,0.5],"model_used":"5m","degraded":false}`)
	w = post(base + `,"cache_hash":"aa02","cache_key":"k"}`)
	if w.Code != http.StatusOK || w.Header().Get("X-Eval-Cache") != "miss" || live.calls != 2 {
		t.Fatalf("model mismatch hit: %d %s header=%q calls=%d", w.Code, w.Body, w.Header().Get("X-Eval-Cache"), live.calls)
	}
	// Sampled (temperature != 0) requests bypass the cache both ways.
	w = post(base + `,"temperature":1,"cache_hash":"aa03","cache_key":"k"}`)
	if w.Code != http.StatusOK || w.Header().Get("X-Eval-Cache") != "" || live.calls != 3 {
		t.Fatalf("sampled: %d %s header=%q calls=%d", w.Code, w.Body, w.Header().Get("X-Eval-Cache"), live.calls)
	}
	get := httptest.NewRecorder()
	s.evaluations(get, httptest.NewRequest("GET", "/evaluations/aa03", nil))
	if get.Code != 404 {
		t.Fatalf("sampled answer persisted: %d %s", get.Code, get.Body)
	}
	// Deterministic requests still hit.
	w = post(base + `,"cache_hash":"aa04","cache_key":"k"}`)
	if w.Header().Get("X-Eval-Cache") != "hit" || live.calls != 3 {
		t.Fatalf("seeded miss: header=%q calls=%d", w.Header().Get("X-Eval-Cache"), live.calls)
	}
	w = post(base + `,"cache_hash":"aa04","cache_key":"k"}`)
	if w.Code != http.StatusOK || w.Header().Get("X-Eval-Cache") != "hit" || live.calls != 3 {
		t.Fatalf("deterministic hit: %d %s header=%q calls=%d", w.Code, w.Body, w.Header().Get("X-Eval-Cache"), live.calls)
	}
}

func TestHealthzMethod(t *testing.T) {
	app := &server{pool: NewEnginePool(NewWorker("79m", nil), NewWorker("5m", nil))}

	get := httptest.NewRecorder()
	app.healthz(get, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /healthz status = %d, want %d", get.Code, http.StatusOK)
	}

	post := httptest.NewRecorder()
	app.healthz(post, httptest.NewRequest(http.MethodPost, "/healthz", nil))
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /healthz status = %d, want %d", post.Code, http.StatusMethodNotAllowed)
	}
}

func TestRecoverJSONEmitsErrorBeforeCrash(t *testing.T) {
	handler := recoverJSON(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/move", nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("panic status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
	var body apiError
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("panic body is not JSON: %v", err)
	}
	if body.Code != "internal" || body.Message == "" {
		t.Fatalf("unexpected panic body: %+v", body)
	}
}
