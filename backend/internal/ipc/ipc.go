// Package ipc owns the JSON-lines pipe contract shared by the Go engine
// adapters and their Python helpers: one JSON object per line, bounded so a
// runaway helper cannot grow Go memory without bound.
package ipc

// LineLimit bounds one stdin/stdout JSON line (64 KiB), matching the HTTP
// single-object body cap so a document the API accepts always fits the pipe.
const LineLimit = 64 * 1024
