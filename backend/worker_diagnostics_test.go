package main

import (
	"bytes"
	"errors"
	"log"
	"net/http"
	"strings"
	"testing"
)

func TestWorkerDiagnosticsBoundsAndTimingVisibility(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	d := newWorkerDiagnostics("test")
	input := strings.Repeat("x", 1024*1024)
	if n, err := d.Write([]byte(input)); err != nil || n != len(input) {
		t.Fatal(n, err)
	}
	if len(d.line) > 1024 {
		t.Fatal("unbounded diagnostic line")
	}
	_, _ = d.Write([]byte("\nstockfish_timing duration_ms=1\n"))
	_, _ = d.Write([]byte(strings.Repeat("noise\n", 1000)))
	if strings.Count(output.String(), "\n") > 20 || !strings.Contains(output.String(), "stockfish_timing") || output.Len() > 25000 {
		t.Fatal("diagnostics not bounded or timing hidden")
	}
}

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
