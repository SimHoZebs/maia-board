// Package engine owns Maia/Stockfish process lifecycle, admission, engine
// request/response types, and engine-value validation. Go remains the HTTP
// boundary; Python adapters perform history-aware chess validation.
package ipc

import (
	"log"
	"strings"
	"sync"
	"time"
)

// Drain stderr continuously with bounded memory and at most 20 log lines per
// second per process. Long lines are truncated; suppressed bytes are never kept.
type WorkerDiagnostics struct {
	mu     sync.Mutex
	name   string
	line   []byte
	window time.Time
	lines  int
}

func NewWorkerDiagnostics(name string) *WorkerDiagnostics {
	return &WorkerDiagnostics{name: name}
}
func (d *WorkerDiagnostics) Write(p []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, c := range p {
		if c != '\n' {
			if len(d.line) < 1024 {
				d.line = append(d.line, c)
			}
			continue
		}
		if time.Since(d.window) >= time.Second {
			d.window, d.lines = time.Now(), 0
		}
		if d.lines < 20 {
			log.Printf("worker=%s stderr=%s", d.name, strings.ToValidUTF8(string(d.line), "?"))
			d.lines++
		}
		d.line = d.line[:0]
	}
	return len(p), nil
}
