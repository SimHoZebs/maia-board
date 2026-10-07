// Package server owns the HTTP boundary: routes, handlers, the shared
// error mapping, batch orchestration, and cache read/write-through. Engine
// admission and process lifecycle live in internal/engine, persistence in
// internal/store.
//
// Routing is Chi with Huma operations (see api.go for the topology).
// Request bodies are decoded and schema-validated by Huma: malformed JSON
// is a 400, unknown fields or missing required keys are a 422, oversized
// bodies are a 413. Domain validation (chess rules, Elo ranges, identities)
// stays in the hand-written validate functions and answers 400 with our
// machine-readable code in errors[0].message.
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
// endpoints (/move, /move/analysis, /evaluate). Statuses and codes are the
// pre-Huma contract; only the envelope changed. Retry-After for 503/429 is
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
