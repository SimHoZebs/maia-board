package server

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/openings"
)

func (s *Server) openingsHandler(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	w = rec
	var request openings.Request
	defer func() {
		log.Printf("openings status=%d plies=%d duration_ms=%d", rec.status, len(request.Moves), time.Since(started).Milliseconds())
	}()
	decoded, ok := decodeSingle[openings.Request](w, r, 64*1024)
	if !ok {
		return
	}
	request = decoded
	if err := openings.ValidateRequest(&request); err != nil {
		writeAPIError(w, 400, err.Code, err.Message)
		return
	}
	input, err := json.Marshal(request)
	if err != nil {
		writeAPIError(w, 500, "openings_unavailable", "Opening lookup is unavailable")
		return
	}
	output, err := s.openings.Lookup(r.Context(), input)
	if err != nil {
		writeAPIError(w, 502, "openings_unavailable", "Opening lookup is unavailable")
		return
	}
	var workerError apierror.Error
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
	var result openings.Response
	if err := json.Unmarshal(output, &result); err != nil {
		writeAPIError(w, 502, "openings_unavailable", "Opening lookup is unavailable")
		return
	}
	if result.Matches == nil {
		result.Matches = []openings.Match{}
	}
	if len(result.BookFlags) != len(request.Moves) {
		writeAPIError(w, 502, "openings_unavailable", "Opening lookup is unavailable")
		return
	}
	writeJSON(w, 200, result)
}
