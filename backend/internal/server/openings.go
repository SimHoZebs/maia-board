package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/openings"
)

type OpeningsInput struct {
	Body openings.Request
}

type OpeningsOutput struct {
	Body openings.Response
}

func (s *Server) handleOpenings(ctx context.Context, input *OpeningsInput) (*OpeningsOutput, error) {
	started := time.Now()
	request := input.Body
	status := http.StatusOK
	defer func() {
		log.Printf("openings status=%d plies=%d duration_ms=%d", status, len(request.Moves), time.Since(started).Milliseconds())
	}()
	if err := openings.ValidateRequest(&request); err != nil {
		status = http.StatusBadRequest
		return nil, apiError(status, err.Code, err.Message)
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		status = http.StatusInternalServerError
		return nil, apiError(status, "openings_unavailable", "Opening lookup is unavailable")
	}
	output, err := s.openings.Lookup(ctx, encoded)
	if err != nil {
		status = http.StatusBadGateway
		return nil, apiError(status, "openings_unavailable", "Opening lookup is unavailable")
	}
	var workerError apierror.Error
	if err := json.Unmarshal(output, &workerError); err != nil {
		status = http.StatusBadGateway
		return nil, apiError(status, "openings_unavailable", "Opening lookup is unavailable")
	}
	if workerError.Code != "" {
		switch workerError.Code {
		case "invalid_fen", "invalid_position":
			status = http.StatusBadRequest
			return nil, apiError(status, workerError.Code, "position or move history is invalid")
		default:
			status = http.StatusBadGateway
			return nil, apiError(status, "openings_unavailable", "Opening lookup is unavailable")
		}
	}
	var result openings.Response
	if err := json.Unmarshal(output, &result); err != nil {
		status = http.StatusBadGateway
		return nil, apiError(status, "openings_unavailable", "Opening lookup is unavailable")
	}
	if result.Matches == nil {
		result.Matches = []openings.Match{}
	}
	if len(result.BookFlags) != len(request.Moves) {
		status = http.StatusBadGateway
		return nil, apiError(status, "openings_unavailable", "Opening lookup is unavailable")
	}
	return &OpeningsOutput{Body: result}, nil
}
