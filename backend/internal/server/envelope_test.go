package server

import (
	"bytes"
	"errors"
	"log"
	"net/http"
	"strings"
	"testing"
)

type failingResponseWriter struct{}

func (failingResponseWriter) Header() http.Header { return http.Header{} }
func (failingResponseWriter) WriteHeader(int)     {}
func (failingResponseWriter) Write([]byte) (int, error) {
	return 0, errors.New("disconnected test client")
}

func TestHTTPResponseWriteErrorsAreLogged(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	writeJSON(failingResponseWriter{}, 200, map[string]any{"ok": true})
	if !strings.Contains(output.String(), "disconnected test client") {
		t.Fatal("discarded response write error")
	}
}
