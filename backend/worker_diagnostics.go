package main

import (
	"log"
	"strings"
	"sync"
	"time"
)

// Drain stderr continuously with bounded memory and at most 20 log lines per
// second per process. Long lines are truncated; suppressed bytes are never kept.
type workerDiagnostics struct {
	mu     sync.Mutex
	name   string
	line   []byte
	window time.Time
	lines  int
}

func newWorkerDiagnostics(name string) *workerDiagnostics { return &workerDiagnostics{name: name} }
func (d *workerDiagnostics) Write(p []byte) (int, error) {
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
