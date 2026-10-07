package server

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"maia-board/backend/internal/store"
)

type GamesListInput struct {
	Limit  string `query:"limit"`
	Offset string `query:"offset"`
}

// GamesPage is the GET /games document. current_id and next_offset stay
// null (never omitted) exactly like the old mux; current_game is omitted
// when unset because Huma cannot express a required-but-nullable object
// $ref, and the client already treats an absent game as none. Saved tabs
// keep reading all three without a shape check.
type GamesPage struct {
	Games       []store.GameRow `json:"games"`
	CurrentID   *string         `json:"current_id"`
	CurrentGame *store.GameRow  `json:"current_game,omitempty"`
	Total       int             `json:"total"`
	NextOffset  *int            `json:"next_offset"`
}

type GamesListOutput struct {
	Body GamesPage
}

type GamesCreateInput struct {
	Body store.GamePayload
}

type GamesCreateOutput struct {
	Body store.GameRow
}

type GameByIDInput struct {
	ID string `path:"id"`
}

type GameGetOutput struct {
	Body store.GameRow
}

func (s *Server) handleGamesList(ctx context.Context, input *GamesListInput) (*GamesListOutput, error) {
	if s.store == nil {
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
	}
	limit := 200
	if raw := input.Limit; raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			return nil, apiError(http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
		}
		limit = min(parsed, 500)
	}
	offset := 0
	if raw := input.Offset; raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 {
			return nil, apiError(http.StatusBadRequest, "invalid_request", "offset must be a nonnegative integer")
		}
		offset = parsed
	}
	games, total, err := s.store.List(limit, offset)
	if err != nil {
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
	}
	currentID := s.store.CurrentID()
	var current *store.GameRow
	if currentID != "" {
		row, err := s.store.Get(currentID)
		if err == nil {
			current = &row
		} else if errors.Is(err, sql.ErrNoRows) {
			// Orphan marker (e.g. game deleted between the marker
			// read and the row fetch): report no current game
			// instead of a dangling id the client must null out.
			currentID = ""
		} else {
			return nil, apiError(http.StatusBadGateway, "engine_unavailable", "current game is unavailable")
		}
	}
	out := &GamesListOutput{}
	out.Body.Games = games
	if currentID != "" {
		out.Body.CurrentID = &currentID
	}
	out.Body.CurrentGame = current
	out.Body.Total = total
	if offset < total && len(games) < total-offset {
		next := offset + len(games)
		out.Body.NextOffset = &next
	}
	return out, nil
}

func (s *Server) handleGamesCreate(ctx context.Context, input *GamesCreateInput) (*GamesCreateOutput, error) {
	if s.store == nil {
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
	}
	started := time.Now()
	status := http.StatusOK
	payload := input.Body
	defer func() {
		if status != http.StatusOK {
			log.Printf("game-save status=%d plies=%d model=%s result=%q duration_ms=%d", status, len(payload.Moves), payload.Model, payload.Result, time.Since(started).Milliseconds())
		}
	}()
	if err := store.ValidateGamePayload(&payload); err != nil {
		status = http.StatusBadRequest
		return nil, apiError(status, err.Code, err.Message)
	}
	game, isNew, err := s.store.Save(payload)
	if err != nil {
		status = http.StatusBadGateway
		return nil, apiError(status, "engine_unavailable", "game history is unavailable")
	}
	eloMaia, eloUser := 0, 0
	if payload.EloMaia != nil {
		eloMaia = *payload.EloMaia
	}
	if payload.EloUser != nil {
		eloUser = *payload.EloUser
	}
	log.Printf("game-save status=%d id=%s plies=%d model=%s user_color=%s elo_maia=%d elo_user=%d result=%q current=%t new=%t duration_ms=%d",
		status, game.ID, len(game.Moves), game.Model, game.UserColor, eloMaia, eloUser, game.Result, payload.Current, isNew, time.Since(started).Milliseconds())
	return &GamesCreateOutput{Body: game}, nil
}

func (s *Server) handleGameGet(ctx context.Context, input *GameByIDInput) (*GameGetOutput, error) {
	if s.store == nil {
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
	}
	game, err := s.store.Get(input.ID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apiError(http.StatusNotFound, "not_found", "unknown game")
	}
	if err != nil {
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
	}
	return &GameGetOutput{Body: game}, nil
}

func (s *Server) handleGameDelete(ctx context.Context, input *GameByIDInput) (*struct{}, error) {
	if s.store == nil {
		return nil, apiError(http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
	}
	started := time.Now()
	status := http.StatusNoContent
	defer func() {
		log.Printf("game-delete status=%d id=%s duration_ms=%d", status, input.ID, time.Since(started).Milliseconds())
	}()
	if err := s.store.Delete(input.ID); err != nil {
		status = http.StatusBadGateway
		return nil, apiError(status, "engine_unavailable", "game history is unavailable")
	}
	return &struct{}{}, nil
}
