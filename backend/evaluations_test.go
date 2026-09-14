package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

// Legacy storage fixtures are inserted directly. Public PUT is intentionally
// disabled; neither legacy rows nor corruption fixtures are trusted producers.
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
func TestLegacyEvaluationCacheReadOnly(t *testing.T) {
	s := &server{store: testStore(t)}
	putCache(t, s, "abc123", `{"engine":"sf","key":"k","value":{"depth":12}}`)
	w := httptest.NewRecorder()
	s.evaluations(w, httptest.NewRequest("GET", "/evaluations/abc123", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"depth":12`) {
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
		t.Fatal("trusted legacy row")
	}
}
func TestEvaluationCacheEvictionPreservesLegacyAndRefreshesRank(t *testing.T) {
	old := evalCacheMaxRows
	evalCacheMaxRows = 3
	defer func() { evalCacheMaxRows = old }()
	s := &server{store: testStore(t)}
	putCache(t, s, "abc123", `{"engine":"sf","key":"legacy","value":{"depth":12}}`)
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
	if _, err := s.store.cacheGet("abc123"); err != nil {
		t.Fatal("legacy was removed", err)
	}
	count, _, err := s.store.cacheStats()
	if err != nil || count != 4 {
		t.Fatalf("stats %d %v", count, err)
	}
}
