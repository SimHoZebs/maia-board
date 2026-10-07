package server

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"maia-board/backend/internal/openings"
)

func stubOpenings(t *testing.T, output string, err error) *openings.OpeningsLookup {
	t.Helper()
	return openings.NewOpeningsLookupForTest(func(ctx context.Context, command []string, input []byte) ([]byte, error) {
		return []byte(output), err
	})
}

func TestOpeningsHandlerReturnsMatches(t *testing.T) {
	s := &Server{openings: stubOpenings(t, `{"matches":[{"ply":5,"eco":"C50","name":"Italian Game"}],"book_flags":[true,true,true,false,false]}`, nil)}
	w := serve(s, "POST", "/openings", `{"moves":["e2e4","e7e5","g1f3","b8c6","f1c4"]}`)
	if w.Code != 200 {
		t.Fatalf("status = %d, want 200 (%s)", w.Code, w.Body.String())
	}
	var result openings.Response
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
		name   string
		method string
		body   string
		code   string
		status int
	}{
		{"method", http.MethodGet, ``, "method_not_allowed", 405},
		{"json", http.MethodPost, `{`, "", 400},
		{"uci shape", http.MethodPost, `{"moves":["e2e4","bogus"]}`, "invalid_position", 400},
		{"fen shape", http.MethodPost, `{"initial_fen":"nope","moves":[]}`, "invalid_fen", 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{openings: stubOpenings(t, `{"matches":[],"book_flags":[]}`, nil)}
			w := serve(s, tc.method, "/openings", tc.body)
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d (%s)", w.Code, tc.status, w.Body.String())
			}
			if tc.code != "" && humaCode(t, w) != tc.code {
				t.Fatalf("code = %q, want %q (%s)", humaCode(t, w), tc.code, w.Body.String())
			}
		})
	}
}

func TestOpeningsHandlerMapsHelperErrors(t *testing.T) {
	s := &Server{openings: stubOpenings(t, `{"code":"invalid_position","message":"bad"}`, nil)}
	w := serve(s, "POST", "/openings", `{"moves":["e2e4"]}`)
	if w.Code != 400 || humaCode(t, w) != "invalid_position" {
		t.Fatalf("status = %d code = %q", w.Code, humaCode(t, w))
	}

	broken := &Server{openings: stubOpenings(t, ``, context.DeadlineExceeded)}
	w = serve(broken, "POST", "/openings", `{"moves":[]}`)
	if w.Code != 502 {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}

func TestOpeningsHandlerRejectsFlagCountMismatch(t *testing.T) {
	s := &Server{openings: stubOpenings(t, `{"matches":[],"book_flags":[true]}`, nil)}
	w := serve(s, "POST", "/openings", `{"moves":[]}`)
	if w.Code != 502 {
		t.Fatalf("status = %d, want 502", w.Code)
	}
}

// TestOpeningsServeHelper is not a test: re-executed as the warm helper
