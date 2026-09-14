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
	var put cachePut
	if err := json.Unmarshal([]byte(body), &put); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(put.Value)
	if err != nil {
		t.Fatal(err)
	}
	entry, err := s.store.cachePut(hash, put.Engine, put.Key, string(data))
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
