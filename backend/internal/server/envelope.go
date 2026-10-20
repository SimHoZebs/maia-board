// Package server owns the HTTP boundary: routes, handlers, the shared
// error mapping, batch orchestration, and cache read/write-through. Engine
// admission and process lifecycle live in internal/engine, persistence in
// internal/store.
package server

import (
	"errors"
	"net/http"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/sched"
)

// engineFailure maps engine/scheduler failures to the HTTP status, our
// machine-readable code, and the human message shared by the live inference
// endpoints (/move, /move/analysis, /evaluate). Retry-After for 503/429 is
// applied by the retryAfter middleware in server.go, not here.
func engineFailure(err error, engineUnavailable string) (status int, code, message string) {
	if reqErr, ok := errors.AsType[*apierror.RequestError](err); ok {
		return http.StatusBadRequest, reqErr.Code, reqErr.Message
	}
	switch {
	case errors.Is(err, sched.ErrSuperseded):
		return http.StatusConflict, "superseded", "a newer request superseded this position"
	case errors.Is(err, engine.ErrWorkerBusy):
		return http.StatusServiceUnavailable, "engine_busy", "the engine is busy"
	case errors.Is(err, engine.ErrPositionMismatch):
		return http.StatusBadRequest, "position_mismatch", "moves do not produce fen"
	case errors.Is(err, engine.ErrInvalidPosition):
		return http.StatusBadRequest, "invalid_position", "position or move history is invalid"
	case errors.Is(err, engine.ErrNoLegalMoves):
		return http.StatusBadRequest, "game_over", "position has no legal moves"
	default:
		return http.StatusBadGateway, "engine_unavailable", engineUnavailable
	}
}
