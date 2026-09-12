package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
)

func putCache(t *testing.T, s *server, hash, body string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	s.evaluations(w, httptest.NewRequest("PUT", "/evaluations/"+hash, strings.NewReader(body)))
	return w
}

func TestEvaluationCacheRoundTrip(t *testing.T) {
	s := &server{store: testStore(t)}
	value := `{"engine":"Stockfish 19","depth":12}`
	w := putCache(t, s, "abc123", `{"engine":"sf","key":"k","value":`+value+`}`)
	if w.Code != 200 {
		t.Fatalf("put status %d: %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	s.evaluations(w, httptest.NewRequest("GET", "/evaluations/abc123", nil))
	if w.Code != 200 {
		t.Fatalf("get status %d: %s", w.Code, w.Body)
	}
	var entry cachedEvaluation
	if err := json.Unmarshal(w.Body.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry.Engine != "sf" || entry.Key != "k" {
		t.Fatalf("entry = %+v", entry)
	}
	encoded, _ := json.Marshal(entry.Value)
	var want, got any
	if err := json.Unmarshal([]byte(value), &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprintf("%v", want) != fmt.Sprintf("%v", got) {
		t.Fatalf("value changed: %s", encoded)
	}
}

func TestEvaluationCacheMissAndValidation(t *testing.T) {
	s := &server{store: testStore(t)}
	w := httptest.NewRecorder()
	s.evaluations(w, httptest.NewRequest("GET", "/evaluations/deadbeef", nil))
	if w.Code != 404 || !strings.Contains(w.Body.String(), `"code":"not_found"`) {
		t.Fatalf("miss: %d %s", w.Code, w.Body)
	}
	for _, tc := range []struct {
		name, hash, body, code string
		status                 int
	}{
		{"hash", "ZZZ", `{"engine":"sf","key":"k","value":{}}`, "invalid_request", 400},
		{"empty hash is 404", "", `{"engine":"sf","key":"k","value":{}}`, "not_found", 404},
		{"engine", "aa", `{"engine":"lc0","key":"k","value":{}}`, "invalid_request", 400},
		{"key", "aa", `{"engine":"sf","key":"","value":{}}`, "invalid_request", 400},
		{"scalar", "aa", `{"engine":"sf","key":"k","value":42}`, "invalid_request", 400},
		{"empty object", "aa", `{"engine":"sf","key":"k","value":{}}`, "invalid_request", 400},
		{"malformed", "aa", `{`, "invalid_json", 400},
		{"unknown field", "aa", `{"engine":"sf","key":"k","value":{"a":1},"zzz":1}`, "invalid_json", 400},
		{"oversize key", "aa", fmt.Sprintf(`{"engine":"sf","key":%q,"value":{"a":1}}`, strings.Repeat("k", 5000)), "invalid_request", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := putCache(t, s, tc.hash, tc.body)
			if w.Code != tc.status || !strings.Contains(w.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
		})
	}
	w = httptest.NewRecorder()
	s.evaluations(w, httptest.NewRequest("POST", "/evaluations/aa", strings.NewReader(`{}`)))
	if w.Code != 405 {
		t.Fatalf("method status %d", w.Code)
	}
	w = httptest.NewRecorder()
	(&server{}).evaluations(w, httptest.NewRequest("GET", "/evaluations/aa", nil))
	if w.Code != 502 {
		t.Fatalf("nil store status %d", w.Code)
	}
}

func TestEvaluationCacheEvictsOldest(t *testing.T) {
	old := evalCacheMaxRows
	evalCacheMaxRows = 3
	defer func() { evalCacheMaxRows = old }()
	s := &server{store: testStore(t)}
	for _, id := range []string{"a1", "b2", "c3", "d4"} {
		w := putCache(t, s, id, `{"engine":"sf","key":"`+id+`","value":{"n":1}}`)
		if w.Code != 200 {
			t.Fatalf("put %s: %d %s", id, w.Code, w.Body)
		}
	}
	w := httptest.NewRecorder()
	s.evaluations(w, httptest.NewRequest("GET", "/evaluations/stats", nil))
	var stats struct {
		Count   int `json:"count"`
		MaxRows int `json:"max_rows"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if stats.Count != 3 || stats.MaxRows != 3 {
		t.Fatalf("stats = %+v", stats)
	}
	w = httptest.NewRecorder()
	s.evaluations(w, httptest.NewRequest("GET", "/evaluations/a1", nil))
	if w.Code != 404 {
		t.Fatalf("oldest survived: %d", w.Code)
	}
}

func TestEvaluationCacheRewriteRefreshesEvictionRank(t *testing.T) {
	old := evalCacheMaxRows
	evalCacheMaxRows = 3
	defer func() { evalCacheMaxRows = old }()
	s := &server{store: testStore(t)}
	for _, id := range []string{"a1", "b2", "c3"} {
		if w := putCache(t, s, id, `{"engine":"sf","key":"`+id+`","value":{"n":1}}`); w.Code != 200 {
			t.Fatalf("put %s: %d %s", id, w.Code, w.Body)
		}
	}
	// Rewriting a1 must refresh its rank: the next insert evicts b2, not a1.
	if w := putCache(t, s, "a1", `{"engine":"sf","key":"a1","value":{"n":2}}`); w.Code != 200 {
		t.Fatalf("re-put a1: %d %s", w.Code, w.Body)
	}
	if w := putCache(t, s, "d4", `{"engine":"sf","key":"d4","value":{"n":1}}`); w.Code != 200 {
		t.Fatalf("put d4: %d %s", w.Code, w.Body)
	}
	for _, id := range []string{"a1", "c3", "d4"} {
		w := httptest.NewRecorder()
		s.evaluations(w, httptest.NewRequest("GET", "/evaluations/"+id, nil))
		if w.Code != 200 {
			t.Fatalf("expected %s to survive: %d", id, w.Code)
		}
	}
	w := httptest.NewRecorder()
	s.evaluations(w, httptest.NewRequest("GET", "/evaluations/b2", nil))
	if w.Code != 404 {
		t.Fatalf("expected b2 evicted, got %d", w.Code)
	}
}
