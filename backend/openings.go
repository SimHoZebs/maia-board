package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os/exec"
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

// OpeningsLookup owns the trusted helper configuration. run is a seam for
// tests so handler tests never need Python.
type OpeningsLookup struct {
	command []string
	timeout time.Duration
	run     func(ctx context.Context, command []string, input []byte) ([]byte, error)
}

func NewOpeningsLookup(python, helper string) *OpeningsLookup {
	return &OpeningsLookup{command: []string{python, helper}, timeout: 15 * time.Second, run: execOpeningsLookup}
}

func execOpeningsLookup(ctx context.Context, command []string, input []byte) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil || cmd.Process.Pid <= 0 {
			return nil
		}
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	cmd.WaitDelay = time.Second
	cmd.Stdin = bytes.NewReader(input)
	var output cappedOutput
	cmd.Stdout = &output
	cmd.Stderr = newWorkerDiagnostics("openings")
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	if err := cmd.Wait(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func (s *server) openingsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, 405, "method_not_allowed", "POST is required")
		return
	}
	started := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	w = rec
	var request openingsRequest
	defer func() {
		log.Printf("openings status=%d plies=%d duration_ms=%d", rec.status, len(request.Moves), time.Since(started).Milliseconds())
	}()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeAPIError(w, 400, "invalid_json", "request body must be a valid JSON object")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeAPIError(w, 400, "invalid_json", "request body must contain one JSON object")
		return
	}
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
