package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// Opening-book lookup. Chess truth lives in the Python helper (python-chess,
// already trusted for position validation); Go owns HTTP validation and the
// process boundary, mirroring Evaluator.run. The book is defined from the
// standard start only — custom-start lines get empty matches, never an error.

type openingsRequest struct {
	InitialFEN string   `json:"initial_fen,omitempty"`
	Moves      []string `json:"moves"`
}

type openingMatch struct {
	Ply  int    `json:"ply"`
	Eco  string `json:"eco"`
	Name string `json:"name"`
}

type openingsResponse struct {
	Matches   []openingMatch `json:"matches"`
	BookFlags []bool         `json:"book_flags"`
	Degraded  bool           `json:"degraded,omitempty"`
}

// OpeningsLookup owns the trusted helper configuration plus one warm helper
// process. The table (447 KiB JSON) loads once at first use; every lookup
// after that is one JSON line through the already-imported interpreter, not
// a fork/exec + import + table load. run is a seam for tests so handler
// tests never need Python.
type OpeningsLookup struct {
	command []string
	timeout time.Duration
	run     func(ctx context.Context, command []string, input []byte) ([]byte, error)
	mu      sync.Mutex
	proc    *openingsProcess
}

type openingsProcess struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}

func NewOpeningsLookup(python, helper string) *OpeningsLookup {
	lookup := &OpeningsLookup{command: []string{python, helper, "--serve"}, timeout: 15 * time.Second}
	lookup.run = func(ctx context.Context, _ []string, input []byte) ([]byte, error) {
		return lookup.query(ctx, input)
	}
	return lookup
}

// query serves one lookup on the warm process, starting it on demand.
// Requests serialize on mu; each is millisecond-scale, so no queueing
// scheduler. Any protocol or timeout failure kills the process group and
// drops it — the next query restarts cleanly.
func (l *OpeningsLookup) query(ctx context.Context, input []byte) ([]byte, error) {
	if len(input) > workerLineLimit {
		return nil, errors.New("openings request exceeds limit")
	}
	ctx, cancel := context.WithTimeout(ctx, l.timeout)
	defer cancel()
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.ensureLocked(ctx); err != nil {
		return nil, err
	}
	proc := l.proc
	writeDone := make(chan error, 1)
	go func() {
		_, err := proc.stdin.Write(append(append([]byte(nil), input...), '\n'))
		writeDone <- err
	}()
	select {
	case err := <-writeDone:
		if err != nil {
			l.failLocked()
			return nil, err
		}
	case <-ctx.Done():
		l.failLocked()
		return nil, ctx.Err()
	}
	type response struct {
		line []byte
		err  error
	}
	readDone := make(chan response, 1)
	go func() {
		line, err := proc.stdout.ReadSlice('\n')
		readDone <- response{append([]byte(nil), line...), err}
	}()
	select {
	case r := <-readDone:
		if r.err != nil {
			l.failLocked()
			return nil, r.err
		}
		return r.line, nil
	case <-ctx.Done():
		l.failLocked()
		return nil, ctx.Err()
	}
}

func (l *OpeningsLookup) ensureLocked(ctx context.Context) error {
	if l.proc != nil {
		return nil
	}
	if len(l.command) == 0 {
		return errors.New("openings helper has no command")
	}
	cmd := exec.Command(l.command[0], l.command[1:]...)
	cmd.Env = append(os.Environ(), "PYTHONUNBUFFERED=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stderr = newWorkerDiagnostics("openings")
	cmd.WaitDelay = time.Second
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return err
	}
	proc := &openingsProcess{cmd: cmd, stdin: stdin, stdout: bufio.NewReaderSize(stdout, workerLineLimit)}
	l.proc = proc
	line, err := l.readLineLocked(ctx)
	if err != nil {
		l.failLocked()
		return err
	}
	var ready struct {
		Ready bool `json:"ready"`
	}
	if json.Unmarshal(line, &ready) != nil || !ready.Ready {
		l.failLocked()
		return errors.New("openings helper missing ready marker")
	}
	return nil
}

func (l *OpeningsLookup) readLineLocked(ctx context.Context) ([]byte, error) {
	proc := l.proc
	type response struct {
		line []byte
		err  error
	}
	done := make(chan response, 1)
	go func() {
		line, err := proc.stdout.ReadSlice('\n')
		done <- response{append([]byte(nil), line...), err}
	}()
	select {
	case r := <-done:
		return r.line, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (l *OpeningsLookup) failLocked() {
	if l.proc == nil {
		return
	}
	proc := l.proc
	l.proc = nil
	_ = proc.stdin.Close()
	if proc.cmd.Process != nil {
		_ = syscall.Kill(-proc.cmd.Process.Pid, syscall.SIGKILL)
	}
	_ = proc.cmd.Wait()
}

func (s *server) openingsHandler(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	w = rec
	var request openingsRequest
	defer func() {
		log.Printf("openings status=%d plies=%d duration_ms=%d", rec.status, len(request.Moves), time.Since(started).Milliseconds())
	}()
	decoded, ok := decodeSingle[openingsRequest](w, r, 64*1024)
	if !ok {
		return
	}
	request = decoded
	if err := validateOpeningsRequest(&request); err != nil {
		writeAPIError(w, 400, err.Code, err.Message)
		return
	}
	input, err := json.Marshal(request)
	if err != nil {
		writeAPIError(w, 500, "openings_unavailable", "Opening lookup is unavailable")
		return
	}
	output, err := s.openings.run(r.Context(), s.openings.command, input)
	if err != nil {
		writeAPIError(w, 502, "openings_unavailable", "Opening lookup is unavailable")
		return
	}
	var workerError apiError
	if err := json.Unmarshal(output, &workerError); err != nil {
		writeAPIError(w, 502, "openings_unavailable", "Opening lookup is unavailable")
		return
	}
	if workerError.Code != "" {
		switch workerError.Code {
		case "invalid_fen", "invalid_position":
			writeAPIError(w, 400, workerError.Code, "position or move history is invalid")
		default:
			writeAPIError(w, 502, "openings_unavailable", "Opening lookup is unavailable")
		}
		return
	}
	var result openingsResponse
	if err := json.Unmarshal(output, &result); err != nil {
		writeAPIError(w, 502, "openings_unavailable", "Opening lookup is unavailable")
		return
	}
	if result.Matches == nil {
		result.Matches = []openingMatch{}
	}
	if len(result.BookFlags) != len(request.Moves) {
		writeAPIError(w, 502, "openings_unavailable", "Opening lookup is unavailable")
		return
	}
	writeJSON(w, 200, result)
}

func validateOpeningsRequest(r *openingsRequest) *requestError {
	// Saved games run to 4096 plies; replay is microseconds per move, so the
	// book never rejects a game the library accepts.
	if len(r.Moves) > 4096 {
		return &requestError{"history_too_long", "moves may contain at most 4096 plies"}
	}
	for _, move := range r.Moves {
		if !uciMovePattern.MatchString(move) {
			return &requestError{"invalid_position", "moves must contain UCI moves"}
		}
	}
	if r.InitialFEN != "" {
		normalized, _, err := normalizeFEN(r.InitialFEN)
		if err != nil {
			return &requestError{"invalid_fen", "initial_fen must be a valid six-field FEN"}
		}
		r.InitialFEN = normalized
	}
	return nil
}
