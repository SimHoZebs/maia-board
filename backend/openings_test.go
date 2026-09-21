package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func stubOpenings(t *testing.T, output string, err error) *OpeningsLookup {
	t.Helper()
	return &OpeningsLookup{
		command: []string{"stub"},
		timeout: time.Second,
		run: func(ctx context.Context, command []string, input []byte) ([]byte, error) {
			return []byte(output), err
		},
	}
}

func TestOpeningsHandlerReturnsMatches(t *testing.T) {
	s := &server{openings: stubOpenings(t, `{"matches":[{"ply":5,"eco":"C50","name":"Italian Game"}],"book_flags":[true,true,true,false,false]}`, nil)}
	w := httptest.NewRecorder()
	s.openingsHandler(w, httptest.NewRequest(http.MethodPost, "/openings", strings.NewReader(`{"moves":["e2e4","e7e5","g1f3","b8c6","f1c4"]}`)))
	if w.Code != 200 {
		t.Fatalf("status = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	var result openingsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(result.Matches) != 1 || result.Matches[0].Eco != "C50" || result.Matches[0].Ply != 5 {
		t.Fatalf("matches = %+v", result.Matches)
	}
	if len(result.BookFlags) != 5 || !result.BookFlags[0] || result.BookFlags[3] {
		t.Fatalf("book_flags = %v", result.BookFlags)
	}
}

func TestOpeningsHandlerRejectsBadInput(t *testing.T) {
	cases := []struct {
		name string
		body string
		code string
	}{
		{"method", ``, "method_not_allowed"},
		{"json", `{`, "invalid_json"},
		{"uci shape", `{"moves":["e2e4","bogus"]}`, "invalid_position"},
		{"fen shape", `{"initial_fen":"nope","moves":[]}`, "invalid_fen"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &server{openings: stubOpenings(t, `{"matches":[],"book_flags":[]}`, nil)}
			var w *httptest.ResponseRecorder
			if tc.name == "method" {
				w = httptest.NewRecorder()
				s.openingsHandler(w, httptest.NewRequest(http.MethodGet, "/openings", nil))
			} else {
				w = httptest.NewRecorder()
				s.openingsHandler(w, httptest.NewRequest(http.MethodPost, "/openings", strings.NewReader(tc.body)))
			}
			var failure apiError
			if err := json.Unmarshal(w.Body.Bytes(), &failure); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if failure.Code != tc.code {
				t.Fatalf("code = %q, want %q (%s)", failure.Code, tc.code, w.Body.String())
			}
		})
	}
}

func TestOpeningsHandlerMapsHelperErrors(t *testing.T) {
	s := &server{openings: stubOpenings(t, `{"code":"invalid_position","message":"bad"}`, nil)}
	w := httptest.NewRecorder()
	s.openingsHandler(w, httptest.NewRequest(http.MethodPost, "/openings", strings.NewReader(`{"moves":["e2e4"]}`)))
	var failure apiError
	if err := json.Unmarshal(w.Body.Bytes(), &failure); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if w.Code != 400 || failure.Code != "invalid_position" {
		t.Fatalf("status = %d code = %q", w.Code, failure.Code)
	}

	broken := &server{openings: stubOpenings(t, ``, context.DeadlineExceeded)}
	w = httptest.NewRecorder()
	broken.openingsHandler(w, httptest.NewRequest(http.MethodPost, "/openings", strings.NewReader(`{"moves":[]}`)))
	if w.Code != 502 {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}

func TestOpeningsHandlerRejectsFlagCountMismatch(t *testing.T) {
	s := &server{openings: stubOpenings(t, `{"matches":[],"book_flags":[true]}`, nil)}
	w := httptest.NewRecorder()
	s.openingsHandler(w, httptest.NewRequest(http.MethodPost, "/openings", strings.NewReader(`{"moves":[]}`)))
	if w.Code != 502 {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}

// TestOpeningsServeHelper is not a test: re-executed as the warm helper
// process, it speaks the --serve protocol (ready marker, one JSON line per
// lookup) so worker tests never need Python.
func TestOpeningsServeHelper(t *testing.T) {
	if os.Getenv("OPENINGS_SERVE_HELPER") != "1" {
		return
	}
	fmt.Println(`{"ready":true}`)
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		fmt.Printf("{\"pid\":%d,\"echo\":%s}\n", os.Getpid(), strings.TrimSpace(line))
	}
}

func warmTestLookup(t *testing.T) *OpeningsLookup {
	t.Helper()
	t.Setenv("OPENINGS_SERVE_HELPER", "1")
	lookup := NewOpeningsLookup(os.Args[0], "-test.run=^TestOpeningsServeHelper$")
	// Drop the python-only --serve flag: the helper speaks the protocol
	// unconditionally when the env var is set.
	lookup.command = lookup.command[:2]
	lookup.timeout = 5 * time.Second
	return lookup
}

func TestWarmWorkerServesSequentialQueriesFromOneProcess(t *testing.T) {
	lookup := warmTestLookup(t)
	var pids []int
	for _, moves := range []string{`{"moves":["e2e4"]}`, `{"moves":["d2d4"]}`} {
		out, err := lookup.run(context.Background(), lookup.command, []byte(moves))
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			PID int `json:"pid"`
		}
		if err := json.Unmarshal(out, &body); err != nil {
			t.Fatalf("helper output is not JSON: %v (%s)", err, out)
		}
		pids = append(pids, body.PID)
	}
	if len(pids) != 2 || pids[0] != pids[1] {
		t.Fatalf("sequential queries forked per request: %v", pids)
	}
}

func TestWarmWorkerRejectsOversizeInputWithoutFork(t *testing.T) {
	lookup := warmTestLookup(t)
	if _, err := lookup.run(context.Background(), lookup.command, []byte(`{"moves":["`+strings.Repeat("e2e4,", 20000)+`"]}`)); err == nil {
		t.Fatal("oversize input accepted")
	}
	lookup.mu.Lock()
	defer lookup.mu.Unlock()
	if lookup.proc != nil {
		t.Fatal("oversize input started the helper")
	}
}

func TestWarmWorkerRestartsDeadHelper(t *testing.T) {
	lookup := warmTestLookup(t)
	if _, err := lookup.run(context.Background(), lookup.command, []byte(`{"moves":[]}`)); err != nil {
		t.Fatal(err)
	}
	lookup.mu.Lock()
	first := lookup.proc
	lookup.mu.Unlock()
	if first == nil {
		t.Fatal("first query started no helper")
	}
	lookup.mu.Lock()
	lookup.failLocked()
	lookup.mu.Unlock()
	if _, err := lookup.run(context.Background(), lookup.command, []byte(`{"moves":[]}`)); err != nil {
		t.Fatalf("query after helper death: %v", err)
	}
	lookup.mu.Lock()
	defer lookup.mu.Unlock()
	if lookup.proc == nil || lookup.proc == first {
		t.Fatal("dead helper was not replaced")
	}
}
