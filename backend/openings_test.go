package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
