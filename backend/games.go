package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// GameStore persists game history in SQLite. All games start from the standard
// position, so only the UCI move history is stored. Terminal resignation is
// stored in result; other endings derive from replaying moves.
type GameStore struct {
	db *sql.DB
}

type gameRow struct {
	Temperature float64  `json:"temperature"`
	ID          string   `json:"id"`
	CreatedAt   string   `json:"created_at"`
	UpdatedAt   string   `json:"updated_at"`
	UserColor   string   `json:"user_color"`
	EloMaia     int      `json:"elo_maia"`
	EloUser     int      `json:"elo_user"`
	Model       string   `json:"model"`
	Moves       []string `json:"moves"`
	Result      string   `json:"result,omitempty"`
}

type gamePayload struct {
	Temperature float64  `json:"temperature,omitempty"`
	ID          string   `json:"id,omitempty"`
	CreatedAt   string   `json:"created_at,omitempty"`
	UserColor   string   `json:"user_color"`
	EloMaia     *int     `json:"elo_maia"`
	EloUser     *int     `json:"elo_user"`
	Model       string   `json:"model"`
	Moves       []string `json:"moves"`
	Result      string   `json:"result,omitempty"`
	Current     bool     `json:"current,omitempty"`
}

// gameStoreDSN carries the connection pragmas in validated shorthand form so
// every pooled connection inherits them (an Exec would only reach one).
func gameStoreDSN(path string) string {
	const params = "_journal_mode=WAL&_timeout=5000&_fk=1"
	if strings.HasPrefix(path, "file:") {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		return path + sep + params
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}
	dsn := (&url.URL{Scheme: "file", Path: abs}).String()
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	return dsn + sep + params
}

func NewGameStore(path string) (*GameStore, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", gameStoreDSN(path))
	if err != nil {
		return nil, err
	}
	// WAL keeps readers unblocked during batch write bursts; every pooled
	// connection inherits the pragmas from the DSN (Exec pragmas would only
	// reach one pooled connection). Writes still serialize inside SQLite.
	db.SetMaxOpenConns(8)
	schema := `
	CREATE TABLE IF NOT EXISTS games (
		id TEXT PRIMARY KEY,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		user_color TEXT NOT NULL CHECK (user_color IN ('white', 'black')),
		elo_maia INTEGER NOT NULL,
		elo_user INTEGER NOT NULL,
		model TEXT NOT NULL,
		moves TEXT NOT NULL DEFAULT '[]',
		result TEXT NOT NULL DEFAULT ''
	);
	CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE INDEX IF NOT EXISTS idx_games_updated ON games(updated_at DESC);`
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	// The legacy evaluations table is disposable cache, not user data: drop
	// it once on open. Misses recompute through the engine endpoints.
	if _, err := db.Exec(`DROP TABLE IF EXISTS evaluations`); err != nil {
		db.Close()
		return nil, err
	}
	if err := ensureV2Cache(db); err != nil {
		db.Close()
		return nil, err
	}
	if err := migrateGameSchema(db); err != nil {
		db.Close()
		return nil, err
	}
	return &GameStore{db: db}, nil
}

func newGameID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

func validateGamePayload(payload *gamePayload) *requestError {
	if !validTemperature(payload.Temperature) {
		return &requestError{"invalid_request", "temperature must be between 0 and 2"}
	}
	if payload.Result != "" && payload.Result != "resigned" {
		return &requestError{"invalid_result", "result must be empty or resigned"}
	}
	if payload.UserColor != "white" && payload.UserColor != "black" {
		return &requestError{"invalid_user_color", "user_color must be white or black"}
	}
	if err := validateElo(payload.EloMaia, payload.EloUser); err != nil {
		return err
	}
	if payload.Model != "79m" && payload.Model != "5m" {
		return &requestError{"invalid_model", "model must be lowercase 79m or 5m"}
	}
	if payload.Moves == nil {
		payload.Moves = []string{}
	}
	if len(payload.Moves) > 4096 {
		return &requestError{"history_too_long", "moves may contain at most 4096 plies"}
	}
	if err := validateUCIMoves(payload.Moves); err != nil {
		return err
	}
	if payload.CreatedAt != "" {
		if _, err := time.Parse(time.RFC3339, payload.CreatedAt); err != nil {
			return &requestError{"invalid_created_at", "created_at must be RFC3339"}
		}
	}
	return nil
}

// Save inserts or updates a game. created_at is immutable once set; updated_at
// always becomes now. When current is true the current-game marker moves too.
func (s *GameStore) Save(payload gamePayload) (gameRow, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	id := payload.ID
	if id == "" {
		generated, err := newGameID()
		if err != nil {
			return gameRow{}, err
		}
		id = generated
	}
	moves, err := encodeJSONColumn(payload.Moves)
	if err != nil {
		return gameRow{}, err
	}
	return withTx(s.db, func(tx *sql.Tx) (gameRow, error) {
		var created, updated, stored string
		var storedColor, storedModel, storedResult string
		var storedMaia, storedUser int
		var storedTemperature float64
		err := tx.QueryRow(`SELECT created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result
			FROM games WHERE id = ?`, id).Scan(&created, &updated, &storedColor, &storedMaia, &storedUser, &storedModel, &stored, &storedTemperature, &storedResult)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			created = payload.CreatedAt
			if created == "" {
				created = now
			}
		case err != nil:
			return gameRow{}, err
		default:
			// Resuming or re-saving unchanged content must not churn recency order.
			if storedColor == payload.UserColor && storedMaia == *payload.EloMaia && storedUser == *payload.EloUser &&
				storedModel == payload.Model && stored == moves && storedTemperature == payload.Temperature && storedResult == payload.Result {
				if payload.Current {
					if _, err := tx.Exec(`INSERT INTO meta (key, value) VALUES ('current_game_id', ?)
						ON CONFLICT (key) DO UPDATE SET value = excluded.value`, id); err != nil {
						return gameRow{}, err
					}
				}
				return gameRow{ID: id, CreatedAt: created, UpdatedAt: updated, UserColor: payload.UserColor,
					EloMaia: *payload.EloMaia, EloUser: *payload.EloUser, Model: payload.Model, Moves: payload.Moves, Temperature: payload.Temperature, Result: payload.Result}, nil
			}
		}
		_, err = tx.Exec(`INSERT INTO games (id, created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, user_color = excluded.user_color,
				elo_maia = excluded.elo_maia, elo_user = excluded.elo_user, model = excluded.model, moves = excluded.moves, temperature = excluded.temperature, result = excluded.result`,
			id, created, now, payload.UserColor, *payload.EloMaia, *payload.EloUser, payload.Model, moves, payload.Temperature, payload.Result)
		if err != nil {
			return gameRow{}, err
		}
		if payload.Current {
			_, err = tx.Exec(`INSERT INTO meta (key, value) VALUES ('current_game_id', ?)
				ON CONFLICT (key) DO UPDATE SET value = excluded.value`, id)
			if err != nil {
				return gameRow{}, err
			}
		}
		return gameRow{ID: id, CreatedAt: created, UpdatedAt: now, UserColor: payload.UserColor,
			EloMaia: *payload.EloMaia, EloUser: *payload.EloUser, Model: payload.Model, Moves: payload.Moves, Temperature: payload.Temperature, Result: payload.Result}, nil
	})
}

type gameScanner interface {
	Scan(...any) error
}

func scanGame(scanner gameScanner) (gameRow, error) {
	var game gameRow
	var moves string
	if err := scanner.Scan(&game.ID, &game.CreatedAt, &game.UpdatedAt, &game.UserColor,
		&game.EloMaia, &game.EloUser, &game.Model, &moves, &game.Temperature, &game.Result); err != nil {
		return gameRow{}, err
	}
	decoded, err := decodeMovesColumn(moves)
	if err != nil {
		return gameRow{}, err
	}
	game.Moves = decoded
	return game, nil
}

func (s *GameStore) Get(id string) (gameRow, error) {
	game, err := scanGame(s.db.QueryRow(`SELECT id, created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result
		FROM games WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return gameRow{}, sql.ErrNoRows
	}
	return game, err
}

func (s *GameStore) List(limit int, offsets ...int) ([]gameRow, int, error) {
	offset := 0
	if len(offsets) > 0 {
		offset = offsets[0]
	}
	var total int
	total, err := countRows(s.db, `SELECT COUNT(*) FROM games`)
	if err != nil {
		return nil, 0, err
	}
	rows, err := s.db.Query(`SELECT id, created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result
		FROM games ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	games := []gameRow{}
	for rows.Next() {
		game, err := scanGame(rows)
		if err != nil {
			return nil, 0, err
		}
		games = append(games, game)
	}
	return games, total, rows.Err()
}

func (s *GameStore) CurrentID() string {
	var id string
	if err := s.db.QueryRow(`SELECT value FROM meta WHERE key = 'current_game_id'`).Scan(&id); err != nil {
		return ""
	}
	return id
}

// Delete removes a game and clears the current-game marker when it points there.
// Deleting an unknown id still succeeds, keeping client retries idempotent.
func (s *GameStore) Delete(id string) error {
	_, err := withTx(s.db, func(tx *sql.Tx) (struct{}, error) {
		if _, err := tx.Exec(`DELETE FROM games WHERE id = ?`, id); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(`DELETE FROM meta WHERE key = 'current_game_id' AND value = ?`, id); err != nil {
			return struct{}{}, err
		}
		return struct{}{}, nil
	})
	return err
}

func (s *server) games(w http.ResponseWriter, r *http.Request) {
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
		var current *gameRow
		if currentID != "" {
			row, err := s.store.Get(currentID)
			if err == nil {
				current = &row
			} else if !errors.Is(err, sql.ErrNoRows) {
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
		payload, ok := decodeSingle[gamePayload](w, r, 64*1024)
		if !ok {
			return
		}
		if err := validateGamePayload(&payload); err != nil {
			writeAPIError(w, http.StatusBadRequest, err.Code, err.Message)
			return
		}
		game, err := s.store.Save(payload)
		if err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			return
		}
		writeJSON(w, http.StatusOK, game)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or POST is required")
	}
}

func (s *server) gameByID(w http.ResponseWriter, r *http.Request) {
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
		if err := s.store.Delete(id); err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			return
		}
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
