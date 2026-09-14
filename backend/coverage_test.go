package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func getCoverage(t *testing.T, s *server, query string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	s.coverage(w, httptest.NewRequest("GET", "/evaluations/coverage"+query, nil))
	return w
}

func TestCoverageRoundTrip(t *testing.T) {
	s := &server{store: testStore(t)}
	putCache(t, s, "abc123", `{"engine":"sf","key":"k1","value":{"engine":"Stockfish 19","depth":12}}`)
	putCache(t, s, "def456", `{"engine":"maia","key":"k2","value":{"move":"e2e4"}}`)
	w := getCoverage(t, s, "?hash=abc123&hash=def456&hash=000000")
	if w.Code != 200 {
		t.Fatalf("coverage status %d: %s", w.Code, w.Body)
	}
	var body struct {
		Rows map[string]cachedEvaluation `json:"rows"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Rows) != 2 {
		t.Fatalf("rows = %+v", body.Rows)
	}
	if body.Rows["abc123"].Engine != "sf" || body.Rows["abc123"].Key != "k1" {
		t.Fatalf("sf row = %+v", body.Rows["abc123"])
	}
	if body.Rows["def456"].Engine != "maia" {
		t.Fatalf("maia row = %+v", body.Rows["def456"])
	}
}

func TestCoverageValidation(t *testing.T) {
	s := &server{store: testStore(t)}
	w := getCoverage(t, s, "?hash=XYZ")
	if w.Code != 400 || !strings.Contains(w.Body.String(), `"code":"invalid_request"`) {
		t.Fatalf("bad hash: %d %s", w.Code, w.Body)
	}
	many := "?hash=" + strings.Repeat("ab&hash=", 1025) + "ab"
	w = getCoverage(t, s, many)
	if w.Code != 400 {
		t.Fatalf("too many hashes: %d %s", w.Code, w.Body)
	}
	w = getCoverage(t, s, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"rows":{}`) {
		t.Fatalf("empty lookup: %d %s", w.Code, w.Body)
	}
	w = httptest.NewRecorder()
	s.coverage(w, httptest.NewRequest("POST", "/evaluations/coverage?hash=abc123", nil))
	if w.Code != 405 {
		t.Fatalf("wrong method: %d %s", w.Code, w.Body)
	}
	nilServer := &server{}
	w = httptest.NewRecorder()
	nilServer.coverage(w, httptest.NewRequest("GET", "/evaluations/coverage?hash=abc123", nil))
	if w.Code != 502 {
		t.Fatalf("nil store: %d %s", w.Code, w.Body)
	}
}
