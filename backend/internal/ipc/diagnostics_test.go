package ipc

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

func TestWorkerDiagnosticsBoundsAndTimingVisibility(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	d := NewWorkerDiagnostics("test")
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
