package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// decodeSingle owns the shared HTTP envelope for single-JSON-object POST
// endpoints: method check, body cap, strict decode rejecting unknown fields,
// trailing-data rejection, and invalid_json writes. Callers keep their own
// maxBytes value, validation, limits, and success shapes.
func decodeSingle[T any](w http.ResponseWriter, r *http.Request, maxBytes int64) (T, bool) {
	var zero T
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST is required")
		return zero, false
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBytes))
	decoder.DisallowUnknownFields()
	var value T
	if err := decoder.Decode(&value); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must be a valid JSON object")
		return zero, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must contain one JSON object")
		return zero, false
	}
	return value, true
}

// mapEngineError owns the engine-error-to-HTTP mapping shared by the live
// inference endpoints (/move, /evaluate). Statuses and codes are preserved;
// busy/superseded/validation messages are unified to neutral wording
// (previously per-engine). The engine-unavailable fallback stays per-endpoint:
// /move sanitizes the underlying error while /evaluate keeps its fixed
// message, matching pre-unification behavior.
func mapEngineError(w http.ResponseWriter, err error, engineUnavailable string) {
	if reqErr, ok := errors.AsType[*requestError](err); ok {
		writeAPIError(w, http.StatusBadRequest, reqErr.Code, reqErr.Message)
		return
	}
	switch {
	case errors.Is(err, ErrSuperseded):
		writeAPIError(w, http.StatusConflict, "superseded", "a newer request superseded this position")
	case errors.Is(err, ErrWorkerBusy):
		w.Header().Set("Retry-After", "1")
		writeAPIError(w, http.StatusServiceUnavailable, "engine_busy", "the engine is busy")
	case errors.Is(err, ErrPositionMismatch):
		writeAPIError(w, http.StatusBadRequest, "position_mismatch", "moves do not produce fen")
	case errors.Is(err, ErrInvalidPosition):
		writeAPIError(w, http.StatusBadRequest, "invalid_position", "position or move history is invalid")
	case errors.Is(err, ErrNoLegalMoves):
		writeAPIError(w, http.StatusBadRequest, "game_over", "position has no legal moves")
	default:
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", engineUnavailable)
	}
}
