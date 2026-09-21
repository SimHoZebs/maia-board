package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

// Cache fixtures are inserted directly. Public PUT is intentionally
// disabled; corruption fixtures are untrusted producers. Short legacy ids
// address nothing since the legacy table was dropped: they 404.
func putCache(t *testing.T, s *server, hash, body string) *httptest.ResponseRecorder {
	t.Helper()
	var put struct {
		Engine string          `json:"engine"`
		Key    string          `json:"key"`
		Value  json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal([]byte(body), &put); err != nil {
		t.Fatal(err)
	}
	entry, err := s.store.cachePut(hash, put.Engine, put.Key, string(put.Value))
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	writeJSON(w, 200, entry)
	return w
}
func TestLegacyEvaluationIdsAreGone(t *testing.T) {
	s := &server{store: testStore(t)}
	w := httptest.NewRecorder()
	s.evaluations(w, httptest.NewRequest("GET", "/evaluations/abc123", nil))
	if w.Code != 404 {
		t.Fatal(w)
	}
	for _, body := range []string{`{"engine":"sf","key":"k","value":{"depth":13}}`, `{`, `{}`} {
		w = httptest.NewRecorder()
		s.evaluations(w, httptest.NewRequest("PUT", "/evaluations/abc123", strings.NewReader(body)))
		if w.Code != 405 {
			t.Fatalf("public PUT accepted: %d", w.Code)
		}
	}
	w = httptest.NewRecorder()
	s.evaluations(w, httptest.NewRequest("GET", "/evaluations/deadbeef", nil))
	if w.Code != 404 {
		t.Fatal(w)
	}
	if _, ok := s.cachedSF(evaluationRequest{FEN: startFEN}); ok {
		t.Fatal("empty cache hit")
	}
}
func TestEvaluationCacheEvictionRefreshesRank(t *testing.T) {
	old := evalCacheMaxRows
	evalCacheMaxRows = 3
	defer func() { evalCacheMaxRows = old }()
	s := &server{store: testStore(t)}
	ids := map[int]string{}
	for _, n := range []int{1, 2, 3, 1, 4} {
		i := sfIdentity(evaluationRequest{FEN: startFEN, Settings: &stockfishSettings{750, n, 0}})
		hash, key := i.coordinates()
		ids[n] = hash
		if _, err := s.store.cachePut(hash, "sf", key, fmt.Sprintf(`{"n":%d}`, n)); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range []int{1, 3, 4} {
		if _, err := s.store.cacheGet(ids[n]); err != nil {
			t.Fatalf("evicted %d: %v", n, err)
		}
	}
	if _, err := s.store.cacheGet(ids[2]); err == nil {
		t.Fatal("oldest retained")
	}
	count, _, err := s.store.cacheStats()
	if err != nil || count != 3 {
		t.Fatalf("stats %d %v", count, err)
	}
}

func TestEvalContentMaiaLine(t *testing.T) {
	resp := moveResponse{Move: "e2e4", WDL: [3]float64{0.437, 0.063, 0.5}, ModelUsed: "79m",
		TopMoves: []topMove{
			{Move: "e2e4", Prob: 0.466, WDL: [3]float64{0.437, 0.063, 0.5}},
			{Move: "d2d4", Prob: 0.335, WDL: [3]float64{0.435, 0.066, 0.499}},
		}}
	fields := maiaContentFields(resp)
	for _, want := range []string{
		"move=e2e4", "wdl=0.437/0.063/0.500", "exp=53.1", "used=79m", "degraded=false",
		"e2e4:46.6%:0.437/0.063/0.500", "d2d4:33.5%:0.435/0.066/0.499",
	} {
		if !strings.Contains(fields, want) {
			t.Fatalf("maia fields %q missing %q", fields, want)
		}
	}
	if got := wdlExpected([3]float64{0.5, 0.06, 0.44}); got < 46.999 || got > 47.001 {
		t.Fatalf("wdlExpected = %v, want ~47", got)
	}
}

func TestEvalContentSFLine(t *testing.T) {
	best := "e2e4"
	resp := &evaluationResponse{Engine: "Stockfish 19", SearchPolicy: SearchPolicy, Depth: 18,
		Score: evaluationScore{Type: "cp", Value: 35}, BestMove: &best,
		Lines: []evaluationLine{
			{Move: "e2e4", Score: evaluationScore{Type: "cp", Value: 35}, Depth: 18},
			{Move: "d2d4", Score: evaluationScore{Type: "cp", Value: 12}, Depth: 18},
		}}
	fields := sfContentFields(resp)
	for _, want := range []string{
		"score=cp:35", "best=e2e4", "depth=18", "terminal=-", "policy=" + SearchPolicy,
		"lines=e2e4:cp:35,d2d4:cp:12",
	} {
		if !strings.Contains(fields, want) {
			t.Fatalf("sf fields %q missing %q", fields, want)
		}
	}
	mate := &evaluationResponse{Score: evaluationScore{Type: "mate", Value: 3, WinningSide: "white"}}
	if got := sfContentFields(mate); !strings.Contains(got, "score=mate:3:white") {
		t.Fatalf("mate fields %q missing mate score", got)
	}
}
