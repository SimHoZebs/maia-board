package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
	degradedBody := `{"fen":"` + startFEN + `","moves":[],"elo_maia":1600,"elo_user":1600,"model":"79m","maia_color":"white","cache_hash":"def456","cache_key":"degraded"}`
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
		w := httptest.NewRecorder()
		s.evaluations(w, httptest.NewRequest("PUT", "/evaluations/"+hash, strings.NewReader(`{"engine":"maia","key":"k","value":`+value+`}`)))
		if w.Code != 200 {
			t.Fatalf("seed %s: %d %s", hash, w.Code, w.Body)
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
	if w.Header().Get("X-Eval-Cache") != "miss" || live.calls != 4 {
		t.Fatalf("seeded miss: header=%q calls=%d", w.Header().Get("X-Eval-Cache"), live.calls)
	}
	w = post(base + `,"cache_hash":"aa04","cache_key":"k"}`)
	if w.Code != http.StatusOK || w.Header().Get("X-Eval-Cache") != "hit" || live.calls != 4 {
		t.Fatalf("deterministic hit: %d %s header=%q calls=%d", w.Code, w.Body, w.Header().Get("X-Eval-Cache"), live.calls)
	}
}

func TestPositionCommand(t *testing.T) {
	if got := positionCommand(EngineRequest{FEN: "current", Moves: []string{"e2e4"}}); got != "position startpos moves e2e4" {
		t.Fatalf("unexpected startpos command: %s", got)
	}
	if got := positionCommand(EngineRequest{FEN: "current", InitialFEN: "custom", Moves: []string{"e2e4"}}); got != "position fen custom moves e2e4" {
		t.Fatalf("unexpected custom command: %s", got)
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
