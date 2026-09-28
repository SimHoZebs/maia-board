package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/chess"

	_ "modernc.org/sqlite"
)

// GameStore persists game history in SQLite. All games start from the standard
// position, so only the UCI move history is stored. Terminal resignation is
// stored in result; other endings derive from replaying moves.
type GameStore struct {
	db *sql.DB
}

type GameRow struct {
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

type GamePayload struct {
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

// Close releases the SQLite pool. Tests use it; the server process exits.
func (s *GameStore) Close() error { return s.db.Close() }

// NewHexID mints a 32-hex-digit identifier for games and batch jobs.
func NewHexID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}

// ValidateGamePayload checks a game save before it reaches the store.
func ValidateGamePayload(payload *GamePayload) *apierror.RequestError {
	if !chess.ValidTemperature(payload.Temperature) {
		return &apierror.RequestError{Code: "invalid_request", Message: "temperature must be between 0 and 2"}
	}
	if payload.Result != "" && payload.Result != "resigned" {
		return &apierror.RequestError{Code: "invalid_result", Message: "result must be empty or resigned"}
	}
	if payload.UserColor != "white" && payload.UserColor != "black" {
		return &apierror.RequestError{Code: "invalid_user_color", Message: "user_color must be white or black"}
	}
	if err := chess.ValidateElo(payload.EloMaia, payload.EloUser); err != nil {
		return err
	}
	if payload.Model != "79m" && payload.Model != "5m" {
		return &apierror.RequestError{Code: "invalid_model", Message: "model must be lowercase 79m or 5m"}
	}
	if payload.Moves == nil {
		payload.Moves = []string{}
	}
	if len(payload.Moves) > 4096 {
		return &apierror.RequestError{Code: "history_too_long", Message: "moves may contain at most 4096 plies"}
	}
	if err := chess.ValidateUCIMoves(payload.Moves); err != nil {
		return err
	}
	if payload.CreatedAt != "" {
		if _, err := time.Parse(time.RFC3339, payload.CreatedAt); err != nil {
			return &apierror.RequestError{Code: "invalid_created_at", Message: "created_at must be RFC3339"}
		}
	}
	return nil
}

// Save inserts or updates a game. created_at is immutable once set; updated_at
// always becomes now. When current is true the current-game marker moves too.
func (s *GameStore) Save(payload GamePayload) (GameRow, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	id := payload.ID
	if id == "" {
		generated, err := NewHexID()
		if err != nil {
			return GameRow{}, err
		}
		id = generated
	}
	moves, err := encodeJSONColumn(payload.Moves)
	if err != nil {
		return GameRow{}, err
	}
	return withTx(s.db, func(tx *sql.Tx) (GameRow, error) {
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
			return GameRow{}, err
		default:
			// Resuming or re-saving unchanged content must not churn recency order.
			if storedColor == payload.UserColor && storedMaia == *payload.EloMaia && storedUser == *payload.EloUser &&
				storedModel == payload.Model && stored == moves && storedTemperature == payload.Temperature && storedResult == payload.Result {
				if payload.Current {
					if _, err := tx.Exec(`INSERT INTO meta (key, value) VALUES ('current_game_id', ?)
						ON CONFLICT (key) DO UPDATE SET value = excluded.value`, id); err != nil {
						return GameRow{}, err
					}
				}
				return GameRow{ID: id, CreatedAt: created, UpdatedAt: updated, UserColor: payload.UserColor,
					EloMaia: *payload.EloMaia, EloUser: *payload.EloUser, Model: payload.Model, Moves: payload.Moves, Temperature: payload.Temperature, Result: payload.Result}, nil
			}
		}
		_, err = tx.Exec(`INSERT INTO games (id, created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, user_color = excluded.user_color,
				elo_maia = excluded.elo_maia, elo_user = excluded.elo_user, model = excluded.model, moves = excluded.moves, temperature = excluded.temperature, result = excluded.result`,
			id, created, now, payload.UserColor, *payload.EloMaia, *payload.EloUser, payload.Model, moves, payload.Temperature, payload.Result)
		if err != nil {
			return GameRow{}, err
		}
		if payload.Current {
			_, err = tx.Exec(`INSERT INTO meta (key, value) VALUES ('current_game_id', ?)
				ON CONFLICT (key) DO UPDATE SET value = excluded.value`, id)
			if err != nil {
				return GameRow{}, err
			}
		}
		return GameRow{ID: id, CreatedAt: created, UpdatedAt: now, UserColor: payload.UserColor,
			EloMaia: *payload.EloMaia, EloUser: *payload.EloUser, Model: payload.Model, Moves: payload.Moves, Temperature: payload.Temperature, Result: payload.Result}, nil
	})
}

type gameScanner interface {
	Scan(...any) error
}

func scanGame(scanner gameScanner) (GameRow, error) {
	var game GameRow
	var moves string
	if err := scanner.Scan(&game.ID, &game.CreatedAt, &game.UpdatedAt, &game.UserColor,
		&game.EloMaia, &game.EloUser, &game.Model, &moves, &game.Temperature, &game.Result); err != nil {
		return GameRow{}, err
	}
	decoded, err := decodeMovesColumn(moves)
	if err != nil {
		return GameRow{}, err
	}
	game.Moves = decoded
	return game, nil
}

func (s *GameStore) Get(id string) (GameRow, error) {
	game, err := scanGame(s.db.QueryRow(`SELECT id, created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result
		FROM games WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return GameRow{}, sql.ErrNoRows
	}
	return game, err
}

func (s *GameStore) List(limit int, offsets ...int) ([]GameRow, int, error) {
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
	games := []GameRow{}
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

// DeleteGameRowForTest removes a game row without touching the current-game
// marker, simulating a marker/game race. Test seam; production uses Delete.
func (s *GameStore) DeleteGameRowForTest(id string) error {
	_, err := s.db.Exec(`DELETE FROM games WHERE id = ?`, id)
	return err
}
