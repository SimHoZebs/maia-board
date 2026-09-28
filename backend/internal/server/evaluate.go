package server

import (
	"context"
	"log"
	"net/http"
	"time"

	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/sched"
)

func (s *Server) evaluate(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	w = rec
	var request engine.EvaluationRequest
	var result *engine.EvaluationResponse
	var hit bool
	// Perf spans mirroring serveMove: validate_us covers request
	// validation, exec_ms covers cache→admission→search→store.
	validateMicros, execMillis := int64(-1), int64(-1)
	defer func() {
		policy := engine.SearchPolicy
		if request.Settings != nil {
			policy = request.Settings.Policy()
		}
		depth, lines := -1, -1
		if result != nil {
			depth, lines = result.Depth, len(result.Lines)
		}
		log.Printf("evaluate status=%d plies=%d policy=%s duration_ms=%d validate_us=%d exec_ms=%d depth=%d lines=%d",
			rec.status, len(request.Moves), policy, time.Since(started).Milliseconds(), validateMicros, execMillis, depth, lines)
		if rec.status == http.StatusOK && result != nil {
			cache := "miss"
			if hit {
				cache = "hit"
			}
			log.Printf("eval-content engine=sf cache=%s policy=%s fen=%s plies=%d pos=%s %s",
				cache, policy, request.FEN, len(request.Moves), orDash(request.PosHash), sfContentFields(result))
		}
	}()
	decoded, ok := decodeSingle[engine.EvaluationRequest](w, r, 64*1024)
	if !ok {
		return
	}
	request = decoded
	validateStart := time.Now()
	if err := engine.ValidateEvaluationRequest(&request); err != nil {
		validateMicros = time.Since(validateStart).Microseconds()
		writeAPIError(w, 400, err.Code, err.Message)
		return
	}
	validateMicros = time.Since(validateStart).Microseconds()
	// /evaluate is a size-1 batch through the shared executor (lane Focus;
	// any X-Priority header from older clients is ignored). waitCtx dequeues
	// on disconnect; execCtx stays detached so a granted search still writes
	// through after the client goes away.
	execCtx := context.WithoutCancel(r.Context())
	execStart := time.Now()
	live, hit, runErr := s.executeSF(r.Context(), execCtx, sched.PriorityFocus, 0, request, false)
	execMillis = time.Since(execStart).Milliseconds()
	if runErr != nil {
		mapEngineError(w, runErr, "Stockfish evaluation is unavailable")
		return
	}
	result = live
	if hit {
		w.Header().Set("X-Eval-Cache", "hit")
	} else {
		w.Header().Set("X-Eval-Cache", "miss")
	}
	writeJSON(w, 200, result)
}
