// Package openings resolves ECO opening names for a move line. Chess truth
// lives in the Python helper (python-chess, already trusted for position
// validation); Go owns validation and the process boundary, mirroring the
// engine Evaluator. The book is defined from the standard start only —
// custom-start lines get empty matches, never an error.
package openings

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/chess"
	"maia-board/backend/internal/ipc"
)

// Request is one book lookup over a UCI move line.
type Request struct {
	InitialFEN string   `json:"initial_fen,omitempty"`
	Moves      []string `json:"moves"`
}

// Match is one exact book hit along the line.
type Match struct {
	Ply  int    `json:"ply"`
	Eco  string `json:"eco"`
	Name string `json:"name"`
}

// Response carries every exact hit plus per-position book flags.
type Response struct {
	Matches   []Match `json:"matches"`
	BookFlags []bool  `json:"book_flags"`
	Degraded  bool    `json:"degraded,omitempty"`
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

// NewOpeningsLookupForTest builds a lookup around a stub run function so
// handler tests never need Python.
func NewOpeningsLookupForTest(run func(ctx context.Context, command []string, input []byte) ([]byte, error)) *OpeningsLookup {
	return &OpeningsLookup{command: []string{"test"}, timeout: time.Second, run: run}
}

// Lookup serves one book lookup: the warm helper in production, the stub in
// tests.
func (l *OpeningsLookup) Lookup(ctx context.Context, input []byte) ([]byte, error) {
	return l.run(ctx, l.command, input)
}

// query serves one lookup on the warm process, starting it on demand.
// Requests serialize on mu; each is millisecond-scale, so no queueing
// scheduler. Any protocol or timeout failure kills the process group and
// drops it — the next query restarts cleanly.
func (l *OpeningsLookup) query(ctx context.Context, input []byte) ([]byte, error) {
	if len(input) > ipc.LineLimit {
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
	cmd.Stderr = ipc.NewWorkerDiagnostics("openings")
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
	proc := &openingsProcess{cmd: cmd, stdin: stdin, stdout: bufio.NewReaderSize(stdout, ipc.LineLimit)}
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

// ValidateRequest bounds the line and normalizes the optional custom start.
// Saved games run to 4096 plies; replay is microseconds per move, so the
// book never rejects a game the library accepts.
func ValidateRequest(r *Request) *apierror.RequestError {
	if len(r.Moves) > 4096 {
		return &apierror.RequestError{Code: "history_too_long", Message: "moves may contain at most 4096 plies"}
	}
	for _, move := range r.Moves {
		if !chess.UCIMovePattern.MatchString(move) {
			return &apierror.RequestError{Code: "invalid_position", Message: "moves must contain UCI moves"}
		}
	}
	if r.InitialFEN != "" {
		normalized, _, err := chess.NormalizeFEN(r.InitialFEN)
		if err != nil {
			return &apierror.RequestError{Code: "invalid_fen", Message: "initial_fen must be a valid six-field FEN"}
		}
		r.InitialFEN = normalized
	}
	return nil
}
