package server

import (
	"context"
	"log"
	"net/http"
	"time"

	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/sched"
)

type EvaluateInput struct {
	Body engine.EvaluationRequest
}

// EvaluateOutput carries the Stockfish result plus the cache header.
type EvaluateOutput struct {
	Cache string `header:"X-Eval-Cache"`
	Body  *engine.EvaluationResponse
}

func (s *Server) handleEvaluate(ctx context.Context, input *EvaluateInput) (*EvaluateOutput, error) {
	started := time.Now()
	request := input.Body
	var result *engine.EvaluationResponse
	var hit bool
	status := http.StatusOK
	// Perf spans mirroring serveMove: validate_us covers request
	// validation, exec_ms covers cache→admission→search→store, and
	// wait_ms is the admission queue wait inside exec_ms (-1 when
	// admission was never reached: validation error or cache hit).
	validateMicros, execMillis, waitMillis := int64(-1), int64(-1), int64(-1)
	defer func() {
		policy := engine.SearchPolicy
		if request.Settings != nil {
			policy = request.Settings.Policy()
		}
		depth, lines := -1, -1
		if result != nil {
			depth, lines = result.Depth, len(result.Lines)
		}
		log.Printf("evaluate status=%d plies=%d policy=%s duration_ms=%d validate_us=%d exec_ms=%d wait_ms=%d depth=%d lines=%d",
			status, len(request.Moves), policy, time.Since(started).Milliseconds(), validateMicros, execMillis, waitMillis, depth, lines)
		if status == http.StatusOK && result != nil {
			cache := "miss"
			if hit {
				cache = "hit"
			}
			log.Printf("eval-content engine=sf cache=%s policy=%s fen=%s plies=%d pos=%s %s",
				cache, policy, request.FEN, len(request.Moves), orDash(request.PosHash), sfContentFields(result))
		}
	}()
	validateStart := time.Now()
	if err := engine.ValidateEvaluationRequest(&request); err != nil {
		validateMicros = time.Since(validateStart).Microseconds()
		status = http.StatusBadRequest
		return nil, apiError(status, err.Code, err.Message)
	}
	validateMicros = time.Since(validateStart).Microseconds()
	// /evaluate is a size-1 batch through the shared executor (lane Focus;
	// any X-Priority header from older clients is ignored). The request
	// context dequeues on disconnect; execCtx stays detached so a granted
	// search still writes through after the client goes away.
	execCtx := context.WithoutCancel(ctx)
	execStart := time.Now()
	live, hit, runErr := s.executeSF(ctx, execCtx, sched.PriorityFocus, 0, request, false)
	execMillis = time.Since(execStart).Milliseconds()
	if runErr != nil {
		failStatus, failCode, failMessage := engineFailure(runErr, "Stockfish evaluation is unavailable")
		status = failStatus
		return nil, apiError(failStatus, failCode, failMessage)
	}
	result = live
	if !hit && result != nil {
		waitMillis = result.WaitMs
	}
	out := &EvaluateOutput{Body: result}
	if hit {
		out.Cache = "hit"
	} else {
		out.Cache = "miss"
	}
	return out, nil
}
