package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os/exec"
	"syscall"
	"time"
)

const SearchPolicy = "sf19-n100k-ms750-mpv2-t1-h64-v1"

type evaluationRequest struct {
	FEN        string             `json:"fen"`
	Moves      []string           `json:"moves"`
	InitialFEN string             `json:"initial_fen,omitempty"`
	Settings   *stockfishSettings `json:"settings,omitempty"`
}

type evaluationScore struct {
	Type        string `json:"type"`
	Value       int    `json:"value"`
	WinningSide string `json:"winning_side,omitempty"`
}

type evaluationLine struct {
	Move  string          `json:"move"`
	Score evaluationScore `json:"score"`
	Depth int             `json:"depth"`
}

type evaluationResponse struct {
	Engine       string           `json:"engine"`
	SearchPolicy string           `json:"search_policy"`
	Depth        int              `json:"depth"`
	Terminal     *string          `json:"terminal"`
	BestMove     *string          `json:"best_move"`
	Score        evaluationScore  `json:"score"`
	Lines        []evaluationLine `json:"lines"`
}

// Evaluator owns the single admission slot and trusted process configuration.
type Evaluator struct {
	command []string
	gate    chan struct{}
	timeout time.Duration
}

func NewEvaluator(python, helper, binary string) *Evaluator {
	return &Evaluator{command: []string{python, helper, "--binary", binary}, gate: make(chan struct{}, 1), timeout: 8 * time.Second}
}

func (s *server) evaluate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, 405, "method_not_allowed", "POST is required")
		return
	}
	var request evaluationRequest
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
	if err := validateEvaluationRequest(&request); err != nil {
		writeAPIError(w, 400, err.Code, err.Message)
		return
	}
	if s.evaluator == nil {
		writeAPIError(w, 502, "engine_unavailable", "Stockfish is unavailable")
		return
	}
	result, err := s.evaluator.run(r.Context(), request)
	if err != nil {
		var requestErr *requestError
		switch {
		case errors.Is(err, ErrWorkerBusy):
			w.Header().Set("Retry-After", "1")
			writeAPIError(w, 503, "engine_busy", "Stockfish is busy")
		case errors.As(err, &requestErr):
			writeAPIError(w, 400, requestErr.Code, requestErr.Message)
		default:
			writeAPIError(w, 502, "engine_unavailable", "Stockfish evaluation is unavailable")
		}
		return
	}
	writeJSON(w, 200, result)
}

func validateEvaluationRequest(r *evaluationRequest) *requestError {
	if err := r.Settings.validate(); err != nil {
		return err
	}
	if len(r.Moves) > 256 {
		return &requestError{"history_too_long", "moves may contain at most 256 plies"}
	}
	for _, move := range r.Moves {
		if !uciMovePattern.MatchString(move) {
			return &requestError{"invalid_position", "moves must contain UCI moves"}
		}
	}
	for _, fen := range []*string{&r.FEN, &r.InitialFEN} {
		if fen == &r.InitialFEN && *fen == "" {
			continue
		}
		normalized, _, err := normalizeFEN(*fen)
		if err != nil {
			return &requestError{"invalid_fen", "fen and initial_fen must be valid six-field FENs"}
		}
		*fen = normalized
	}
	return nil
}

// Output is small; cap collection even if a misconfigured helper is noisy.
type cappedOutput struct{ buffer bytes.Buffer }

func (b *cappedOutput) Bytes() []byte { return b.buffer.Bytes() }

func (b *cappedOutput) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > 64*1024 {
		return 0, errors.New("worker output exceeds limit")
	}
	return b.buffer.Write(p)
}

func (e *Evaluator) run(parent context.Context, request evaluationRequest) (*evaluationResponse, error) {
	select {
	case e.gate <- struct{}{}:
	default:
		return nil, ErrWorkerBusy
	}
	defer func() { <-e.gate }()
	timeout := e.timeout
	if request.Settings != nil {
		timeout += time.Duration(request.Settings.TimeMS) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	input, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, e.command[0], e.command[1:]...)
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
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	pid := cmd.Process.Pid
	if err := cmd.Wait(); err != nil {
		// Clean up only when the wrapper did not exit cleanly; a successful
		// Python finally block already quits the engine.
		cleanupEvaluationGroup(pid)
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		cleanupEvaluationGroup(pid)
		return nil, err
	}
	var workerError apiError
	if err := json.Unmarshal(output.Bytes(), &workerError); err != nil {
		return nil, err
	}
	if workerError.Code != "" {
		switch workerError.Code {
		case "invalid_fen", "invalid_position":
			return nil, &requestError{workerError.Code, "position or move history is invalid"}
		case "position_mismatch":
			return nil, &requestError{workerError.Code, "moves do not produce fen"}
		default:
			return nil, errors.New("worker unavailable")
		}
	}
	var result evaluationResponse
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		return nil, err
	}
	if result.Engine != "Stockfish 19" || result.SearchPolicy != request.Settings.policy() || result.Lines == nil {
		return nil, errors.New("invalid worker response")
	}
	return &result, nil
}

func cleanupEvaluationGroup(pid int) {
	if pid <= 0 {
		return
	}
	_ = syscall.Kill(-pid, syscall.SIGKILL)
	// When the server is container PID 1, it adopts orphaned engine processes.
	// Reap only this request's group; never race another worker's cmd.Wait.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		n, err := syscall.Wait4(-pid, nil, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.ECHILD) {
			return
		}
		if err != nil && !errors.Is(err, syscall.EINTR) {
			return
		}
		if n == 0 {
			time.Sleep(5 * time.Millisecond)
		}
	}
}
