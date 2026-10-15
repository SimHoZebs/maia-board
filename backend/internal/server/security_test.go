package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The Account panel downloads public game exports from the Lichess API in
// the browser, so connect-src must name lichess.org alongside same-origin.
func TestSecurityHeadersAllowLichessConnect(t *testing.T) {
	recorder := httptest.NewRecorder()
	securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {})).
		ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	policy := recorder.Header().Get("Content-Security-Policy")
	if !strings.Contains(policy, "connect-src 'self' https://lichess.org") {
		t.Fatalf("CSP = %q", policy)
	}
}
