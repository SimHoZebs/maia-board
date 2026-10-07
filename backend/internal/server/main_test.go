package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/ipc"
	"maia-board/backend/internal/sched"
)

// serve routes one request through the full Chi+Huma stack, exactly like
// production (middlewares, Huma validation, Huma envelope). POST/PUT/PATCH
// carry application/json like every real client.
func serve(s *Server, method, path, body string) *httptest.ResponseRecorder {
	var reader *strings.Reader
	if body == "" {
		reader = strings.NewReader("")
	} else {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if method == http.MethodPost || method == http.MethodPut || method == http.MethodPatch {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	return w
}

// humaCode extracts errors[0].message — our machine-readable code vocabulary
// inside Huma's ErrorModel envelope — from an error response. Empty when the
// failure is Huma's own (malformed JSON, schema violations, oversize).
func humaCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var failure struct {
		Title  string `json:"title"`
		Status int    `json:"status"`
		Detail string `json:"detail"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &failure); err != nil {
		t.Fatalf("decode error body: %v (%s)", err, w.Body.String())
	}
	if len(failure.Errors) == 0 {
		return ""
	}
	return failure.Errors[0].Message
}

func TestValidateMoveRequest(t *testing.T) {
	maiaElo, userElo := 1500, 1300
	request := MoveRequest{
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

func TestValidateMoveRequestValueElos(t *testing.T) {
	maiaElo, userElo, valueMaia, valueUser := 800, 800, 2400, 2400
	request := MoveRequest{
		FEN:          startFEN,
		Moves:        []string{},
		EloMaia:      &maiaElo,
		EloUser:      &userElo,
		ValueEloMaia: &valueMaia,
		ValueEloUser: &valueUser,
		Model:        "79m",
		MaiaColor:    "white",
	}
	engineRequest, _, err := validateMoveRequest(request)
	if err != nil {
		t.Fatal(err)
	}
	if engineRequest.ValueSelfElo == nil || *engineRequest.ValueSelfElo != 2400 ||
		engineRequest.ValueOppoElo == nil || *engineRequest.ValueOppoElo != 2400 {
		t.Fatalf("value Elos not mapped: %+v", engineRequest)
	}
	outOfRange := 5001
	if _, _, err := validateMoveRequest(MoveRequest{FEN: startFEN, EloMaia: &maiaElo, EloUser: &userElo,
		ValueEloMaia: &outOfRange, Model: "79m", MaiaColor: "white"}); err == nil {
		t.Fatal("out-of-range value Elo accepted")
	}
	// Omitted value Elos stay nil (worker defaults to policy Elos).
	plain, _, err := validateMoveRequest(MoveRequest{FEN: startFEN, EloMaia: &maiaElo, EloUser: &userElo, Model: "79m", MaiaColor: "white"})
	if err != nil {
		t.Fatal(err)
	}
	if plain.ValueSelfElo != nil || plain.ValueOppoElo != nil {
		t.Fatalf("omitted value Elos must stay nil: %+v", plain)
	}
}

type prioRecorder struct {
	result engine.MaiaResult
	prios  []sched.Priority
}

func (f *prioRecorder) Predict(_ context.Context, _ context.Context, prio sched.Priority, _ uint64, _ engine.MaiaRequest) (engine.MaiaResult, func(), error) {
	f.prios = append(f.prios, prio)
	return f.result, nil, nil
}
func (f *prioRecorder) WorkerStatus() engine.WorkerStatus { return engine.WorkerStatus{} }

func TestMoveEndpointsAdmitOnSeparateLanes(t *testing.T) { // /move (live replies) admits on Play, /move/analysis (retrospective
	// analysis) on Focus, so a play move and its analysis queue instead of
	// superseding each other on the shared slot.
	wdl := [3]float64{0.2, 0.3, 0.5}
	rec := &prioRecorder{result: engine.MaiaResult{Move: "e2e4",
		Candidates: []engine.MaiaCandidate{{Move: "e2e4", Policy: 0.6, WDL: wdl}}, WDL: wdl}}
	s := &Server{pool: engine.NewEnginePool(rec, rec), store: testStore(t)}
	post := func(path, eloUser string) *httptest.ResponseRecorder {
		body := `{"fen":"` + startFEN + `","moves":[],"elo_maia":1600,"elo_user":` + eloUser + `,"model":"79m","maia_color":"white"}`
		return serve(s, http.MethodPost, path, body)
	}
	// Distinct Elo per call so the second request misses the cache the
	// first call wrote and actually reaches admission.
	if w := post("/move", "1600"); w.Code != http.StatusOK {
		t.Fatalf("play move: %d %s", w.Code, w.Body)
	}
	if w := post("/move/analysis", "1601"); w.Code != http.StatusOK {
		t.Fatalf("move analysis: %d %s", w.Code, w.Body)
	}
	if len(rec.prios) != 2 || rec.prios[0] != sched.PriorityPlay || rec.prios[1] != sched.PriorityFocus {
		t.Fatalf("lanes = %v, want [Play Focus]", rec.prios)
	}
}

func TestMoveRejectsDisabledModel(t *testing.T) {
	live := &fakePredictor{result: engineFixture("e2e4")}
	s := &Server{pool: engine.NewEnginePool(live, nil), store: testStore(t)}
	post := func(model string) *httptest.ResponseRecorder {
		body := `{"fen":"` + startFEN + `","moves":[],"elo_maia":1600,"elo_user":1600,"model":"` + model + `","maia_color":"white"}`
		return serve(s, http.MethodPost, "/move", body)
	}
	if w := post("79m"); w.Code != http.StatusOK {
		t.Fatalf("enabled 79m: %d %s", w.Code, w.Body)
	}
	if w := post("5m"); w.Code != http.StatusBadRequest || humaCode(t, w) != "invalid_model" {
		t.Fatalf("disabled 5m: %d %s, want 400 invalid_model", w.Code, w.Body)
	}
}

// statusCapture forwards a live response while recording its status for
// tests that assert on handler completion through a real HTTP server.
type statusCapture struct {
	http.ResponseWriter
	status int
}

func (r *statusCapture) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
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
			pool := engine.NewEnginePool(worker, unavailable)
			if tc.degraded {
				pool = engine.NewEnginePool(unavailable, worker)
			}
			app := &Server{pool: pool, store: testStore(t)}
			app.reviews = NewReviewJobs(app)
			finished := make(chan int, 2)
			serverCanceled := make(chan struct{}, 1)
			mux := http.NewServeMux()
			// The full Chi+Huma stack: disconnect observation and the
			// detached write-through run through the real router.
			mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				stop := context.AfterFunc(r.Context(), func() {
					select {
					case serverCanceled <- struct{}{}:
					default:
					}
				})
				defer stop()
				rec := &statusCapture{ResponseWriter: w, status: 200}
				app.Handler().ServeHTTP(rec, r)
				finished <- rec.status
			}))
			httpServer := httptest.NewServer(mux)
			httpServer.Client().Timeout = 3 * time.Second
			t.Cleanup(func() { _ = os.WriteFile(release, []byte("ready"), 0600); httpServer.Close() })
			self, opponent := 10, 1
			if tc.invalid {
				opponent = 5
			}
			payload := MoveRequest{FEN: startFEN, InitialFEN: startFEN, Moves: []string{}, EloMaia: &self, EloUser: &opponent, Model: "79m", MaiaColor: "white"}
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
			request.Header.Set("Content-Type", "application/json")
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
			if worker.Idle() {
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
			query := LookupRequest{Engine: "maia", FEN: startFEN, Ply: 0, EloMaia: &self, EloUser: &opponent, Model: "79m"}
			lookupBody, err := json.Marshal(map[string]any{"line": BatchLine{InitialFEN: startFEN, Moves: []string{}}, "requests": []LookupRequest{query}})
			if err != nil {
				t.Fatal(err)
			}
			response, err := httpServer.Client().Post(httpServer.URL+"/evaluations/lookup", "application/json", strings.NewReader(string(lookupBody)))
			if err != nil {
				t.Fatal(err)
			}
			var result struct {
				Results []LookupResult `json:"results"`
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
				count, _, err := app.store.CacheStats()
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
	_, _, err := validateMoveRequest(MoveRequest{
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
	live := &fakePredictor{result: engine.MaiaResult{Move: "e2e4", Candidates: []engine.MaiaCandidate{{Move: "e2e4", Policy: 0.6, WDL: wdl}}, WDL: wdl}}
	s := &Server{pool: engine.NewEnginePool(live, live), store: store}
	// Miss: predicts live, stores the row, reports miss.
	w := serve(s, http.MethodPost, "/move", body)
	if w.Code != http.StatusOK || w.Header().Get("X-Eval-Cache") != "miss" {
		t.Fatalf("miss: %d %s header=%q", w.Code, w.Body, w.Header().Get("X-Eval-Cache"))
	}
	first := w.Body.String()
	if live.calls != 1 {
		t.Fatalf("miss predicted %d times", live.calls)
	}
	// Hit: serves from SQLite without touching the pool.
	broken := &fakePredictor{err: errors.New("boom")}
	hit := &Server{pool: engine.NewEnginePool(broken, broken), store: store}
	w = serve(hit, http.MethodPost, "/move", body)
	if w.Code != http.StatusOK || w.Header().Get("X-Eval-Cache") != "hit" {
		t.Fatalf("hit: %d %s header=%q", w.Code, w.Body, w.Header().Get("X-Eval-Cache"))
	}
	if normalizeJSON(t, w.Body.String()) != normalizeJSON(t, first) {
		t.Fatalf("cached body changed:\n%s\n%s", first, w.Body)
	}
	// Degraded fallback answers are never persisted.
	large := &fakePredictor{err: errors.New("79m failed")}
	small := &fakePredictor{result: engine.MaiaResult{Move: "e2e4", Candidates: []engine.MaiaCandidate{{Move: "e2e4", Policy: 0.6, WDL: wdl}}, WDL: wdl}}
	degradedBody := `{"fen":"` + startFEN + `","moves":[],"elo_maia":1700,"elo_user":1600,"model":"79m","maia_color":"white","cache_hash":"def456","cache_key":"degraded"}`
	w = serve(&Server{pool: engine.NewEnginePool(large, small), store: store}, http.MethodPost, "/move", degradedBody)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"degraded":true`) {
		t.Fatalf("degraded: %d %s", w.Code, w.Body)
	}
	w = serve(hit, http.MethodPost, "/move", degradedBody)
	if w.Code == http.StatusOK && w.Header().Get("X-Eval-Cache") == "hit" {
		t.Fatal("degraded answer was persisted")
	}
}

func TestMoveAnalysisAttachesDeltaWithoutStoring(t *testing.T) {
	body := `{"fen":"` + startFEN + `","moves":[],"elo_maia":1600,"elo_user":1600,"model":"79m","maia_color":"white"}`
	store := testStore(t)
	seedMaia(t, &Server{store: store}, engine.MaiaRequest{FEN: startFEN, SelfElo: 2400, OppoElo: 2400}, "79m",
		engine.MoveResponse{Move: "e2e4", WDL: [3]float64{.2, .3, .5}, ModelUsed: "79m",
			TopMoves: []engine.TopMove{{Move: "e2e4", Prob: 1, WDL: [3]float64{.2, .3, .5}}}})
	wdl := [3]float64{0.437, 0.063, 0.5}
	live := &fakePredictor{result: engine.MaiaResult{Move: "e2e4", Candidates: []engine.MaiaCandidate{{Move: "e2e4", Policy: 0.6, WDL: wdl}}, WDL: wdl}}
	s := &Server{pool: engine.NewEnginePool(live, live), store: store}
	w := serve(s, http.MethodPost, "/move/analysis", body)
	if w.Code != http.StatusOK {
		t.Fatalf("analysis: %d %s", w.Code, w.Body)
	}
	var served engine.MoveResponse
	if err := json.Unmarshal(w.Body.Bytes(), &served); err != nil {
		t.Fatal(err)
	}
	if served.DeltaBaseline == nil || served.DeltaBaseline.Kind != "before" ||
		math.Abs(served.DeltaBaseline.Value-65) > 1e-9 {
		t.Fatalf("served baseline = %+v", served.DeltaBaseline)
	}
	if len(served.TopMoves) != 1 || served.TopMoves[0].Delta == nil ||
		math.Abs(*served.TopMoves[0].Delta-(53.15-65)) > 1e-9 {
		t.Fatalf("served deltas = %+v", served.TopMoves)
	}
	// The persisted row stays baseline-free: baselines depend on which
	// grading rows exist at serve time and would go stale frozen.
	hash, _ := engine.MaiaIdentity(engine.MaiaRequest{FEN: startFEN, SelfElo: 1600, OppoElo: 1600}, "79m").Coordinates()
	entry, err := store.CacheGet(hash)
	if err != nil {
		t.Fatal(err)
	}
	var stored engine.MoveResponse
	if err := json.Unmarshal(entry.Value, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.DeltaBaseline != nil || stored.TopMoves[0].Delta != nil {
		t.Fatalf("stored baseline leaked: %+v", stored)
	}
}

func TestMoveCacheGuards(t *testing.T) {
	wdl := [3]float64{0.2, 0.3, 0.5}
	live := &fakePredictor{result: engine.MaiaResult{Move: "e2e4", Candidates: []engine.MaiaCandidate{{Move: "e2e4", Policy: 0.6, WDL: wdl}}, WDL: wdl}}
	store := testStore(t)
	s := &Server{pool: engine.NewEnginePool(live, live), store: store}
	post := func(body string) *httptest.ResponseRecorder {
		return serve(s, http.MethodPost, "/move", body)
	}
	base := `{"fen":"` + startFEN + `","moves":[],"elo_maia":1600,"elo_user":1600,"model":"79m","maia_color":"white"`
	seed := func(hash, value string) {
		// Corruption fixtures bypass the server-owned writer deliberately.
		hash, key := engine.MaiaIdentity(engine.MaiaRequest{FEN: startFEN, SelfElo: 1600, OppoElo: 1600}, "79m").Coordinates()
		if _, err := store.CachePut(hash, "maia", key, value); err != nil {
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
	get := serve(s, "GET", "/evaluations/aa03", "")
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
	app := &Server{pool: engine.NewEnginePool(engine.NewWorker("79m", nil), engine.NewWorker("5m", nil))}

	get := serve(app, http.MethodGet, "/healthz", "")
	if get.Code != http.StatusOK {
		t.Fatalf("GET /healthz status = %d, want %d", get.Code, http.StatusOK)
	}

	post := serve(app, http.MethodPost, "/healthz", "")
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
	var body struct {
		Detail string `json:"detail"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("panic body is not JSON: %v", err)
	}
	if len(body.Errors) == 0 || body.Errors[0].Message != "internal" || body.Detail == "" {
		t.Fatalf("unexpected panic body: %+v", body)
	}
}

func TestFrontendServesImmutableAssetsAndFreshIndex(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app-abc123.js"), []byte("console.log(1)"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{staticDir: dir}
	asset := httptest.NewRecorder()
	s.frontend(asset, httptest.NewRequest(http.MethodGet, "/assets/app-abc123.js", nil))
	if asset.Code != 200 || asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset cache = %q status = %d", asset.Header().Get("Cache-Control"), asset.Code)
	}
	index := httptest.NewRecorder()
	s.frontend(index, httptest.NewRequest(http.MethodGet, "/analyze?moves=e2e4", nil))
	if index.Code != 200 || index.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("index cache = %q status = %d", index.Header().Get("Cache-Control"), index.Code)
	}
}

func engineFixture(move string) engine.MaiaResult {
	wdl := [3]float64{.2, .2, .6}
	return engine.MaiaResult{Move: move, Candidates: []engine.MaiaCandidate{{Move: move, Policy: 1, WDL: wdl}}, WDL: wdl}
}

type fakePredictor struct {
	result engine.MaiaResult
	err    error
	calls  int
	status engine.WorkerStatus
}

func (f *fakePredictor) Predict(_, _ context.Context, _ sched.Priority, _ uint64, _ engine.MaiaRequest) (engine.MaiaResult, func(), error) {
	f.calls++
	return f.result, nil, f.err
}
func (f *fakePredictor) WorkerStatus() engine.WorkerStatus { return f.status }

// Re-exec the Go test binary as a persistent JSON-lines helper. The request's
// SelfElo selects a delay; OppoElo selects its unique answer, exposing cross-talk.
// Each test binary needs its own copy: os.Args[0] re-executes this package's
// test binary, so the helper must be defined here, not just in internal/engine.
func TestPersistentMaiaHelper(t *testing.T) {
	if os.Getenv("MAIA_JSON_HELPER") != "1" {
		return
	}
	if os.Getenv("MAIA_JSON_SLOW_INIT") == "1" {
		_ = os.WriteFile(os.Getenv("MAIA_JSON_STARTED"), []byte(strconv.Itoa(os.Getpid())), 0600)
		time.Sleep(time.Minute)
	}
	fmt.Println(`{"ready":true}`)
	scanner := bufio.NewScanner(os.Stdin)
	calls := 0
	for scanner.Scan() {
		var r engine.MaiaRequest
		if json.Unmarshal(scanner.Bytes(), &r) != nil {
			os.Exit(2)
		}
		if path := os.Getenv("MAIA_JSON_STARTED"); path != "" {
			_ = os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())), 0600)
		}
		calls++
		if path := os.Getenv("MAIA_JSON_CALLS"); path != "" {
			_ = os.WriteFile(path, []byte(strconv.Itoa(calls)), 0600)
		}
		if path := os.Getenv("MAIA_JSON_RELEASE"); path != "" {
			for {
				if _, err := os.Stat(path); err == nil {
					break
				}
				time.Sleep(time.Millisecond)
			}
		}
		if r.SelfElo == 4999 {
			time.Sleep(time.Minute)
		} else {
			time.Sleep(time.Duration(r.SelfElo) * time.Millisecond)
		}
		move := "e2e4"
		if r.OppoElo == 2 {
			move = "d2d4"
		}
		if r.OppoElo == 3 {
			fmt.Println(strings.Repeat("x", ipc.LineLimit+1))
			continue
		}
		if r.OppoElo == 4 {
			fmt.Println(`{"error":{"code":"invalid_position","message":"invalid board"}}`)
			continue
		}
		result := engineFixture(move)
		if r.OppoElo == 5 {
			result.Candidates[0].Policy = 2
		}
		if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"result": result, "legal_count": 1}); err != nil {
			os.Exit(2)
		}
	}
	os.Exit(0)
}

func persistentWorker(t *testing.T) (*engine.Worker, string) {
	t.Helper()
	t.Setenv("MAIA_JSON_HELPER", "1")
	path := filepath.Join(t.TempDir(), "started")
	t.Setenv("MAIA_JSON_STARTED", path)
	w := engine.NewWorker("test", []string{os.Args[0], "-test.run=^TestPersistentMaiaHelper$"})
	w.SetWaitsForTest(time.Second, 2*time.Second)
	t.Cleanup(w.Close)
	return w, path
}

func awaitPID(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(path)
		if err == nil {
			if pid, err := strconv.Atoi(string(data)); err == nil {
				return pid
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("worker did not receive request")
	return 0
}
