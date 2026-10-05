package server

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"maia-board/backend/internal/store"
)

func (s *Server) games(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	switch r.Method {
	case http.MethodGet:
		limit := 200
		if raw := r.URL.Query().Get("limit"); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 1 {
				writeAPIError(w, http.StatusBadRequest, "invalid_request", "limit must be a positive integer")
				return
			}
			limit = min(parsed, 500)
		}
		offset := 0
		if raw := r.URL.Query().Get("offset"); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 0 {
				writeAPIError(w, http.StatusBadRequest, "invalid_request", "offset must be a nonnegative integer")
				return
			}
			offset = parsed
		}
		games, total, err := s.store.List(limit, offset)
		if err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			return
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
				writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "current game is unavailable")
				return
			}
		}
		var nextOffset any
		if offset < total && len(games) < total-offset {
			nextOffset = offset + len(games)
		}
		writeJSON(w, http.StatusOK, map[string]any{"games": games, "current_id": nullableString(currentID), "current_game": current, "total": total, "next_offset": nextOffset})
	case http.MethodPost:
		started := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		w = rec
		payload, ok := decodeSingle[store.GamePayload](w, r, 64*1024)
		if !ok {
			log.Printf("game-save status=%d plies=-1 duration_ms=%d", rec.status, time.Since(started).Milliseconds())
			return
		}
		if err := store.ValidateGamePayload(&payload); err != nil {
			writeAPIError(w, http.StatusBadRequest, err.Code, err.Message)
			log.Printf("game-save status=%d plies=%d model=%s result=%q duration_ms=%d", rec.status, len(payload.Moves), payload.Model, payload.Result, time.Since(started).Milliseconds())
			return
		}
		game, isNew, err := s.store.Save(payload)
		if err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			log.Printf("game-save status=%d plies=%d model=%s result=%q duration_ms=%d", rec.status, len(payload.Moves), payload.Model, payload.Result, time.Since(started).Milliseconds())
			return
		}
		eloMaia, eloUser := 0, 0
		if payload.EloMaia != nil {
			eloMaia = *payload.EloMaia
		}
		if payload.EloUser != nil {
			eloUser = *payload.EloUser
		}
		log.Printf("game-save status=%d id=%s plies=%d model=%s user_color=%s elo_maia=%d elo_user=%d result=%q current=%t new=%t duration_ms=%d",
			rec.status, game.ID, len(game.Moves), game.Model, game.UserColor, eloMaia, eloUser, game.Result, payload.Current, isNew, time.Since(started).Milliseconds())
		writeJSON(w, http.StatusOK, game)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or POST is required")
	}
}

func (s *Server) gameByID(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/games/")
	if id == "" || strings.Contains(id, "/") {
		writeAPIError(w, http.StatusNotFound, "not_found", "unknown game")
		return
	}
	switch r.Method {
	case http.MethodGet:
		game, err := s.store.Get(id)
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, http.StatusNotFound, "not_found", "unknown game")
			return
		}
		if err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			return
		}
		writeJSON(w, http.StatusOK, game)
	case http.MethodDelete:
		started := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusNoContent}
		w = rec
		if err := s.store.Delete(id); err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			log.Printf("game-delete status=%d id=%s duration_ms=%d", rec.status, id, time.Since(started).Milliseconds())
			return
		}
		log.Printf("game-delete status=%d id=%s duration_ms=%d", rec.status, id, time.Since(started).Milliseconds())
		w.WriteHeader(http.StatusNoContent)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or DELETE is required")
	}
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
