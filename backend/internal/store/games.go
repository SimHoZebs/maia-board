package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/chess"
)

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
	// Source names the origin: `local` for engine games, `lichess:<gameId>`
	// for idempotent re-imports. Never empty: single saves stamp `local`,
	// bulk import stamps `lichess:<gameId>` and rejects empties.
	Source string `json:"source,omitempty"`
	// Opponent names the other side: a Lichess username for imports, Maia
	// plus Elo for engine games. Never empty on rows written after the
	// strict-source migration; older rows carry the 'Unknown' default.
	Opponent string `json:"opponent,omitempty"`
	// RatingDiff is the user's Lichess rating change for this game
	// (players.<color>.ratingDiff). Nil when unknown: local games and
	// rows imported before the field existed. Server-trusted like
	// Opponent: bulk import stamps it, single saves leave it empty.
	RatingDiff *int `json:"rating_diff,omitempty"`
	// TimeControl is the canonical clock setting (`600+5`, `180+0`, `3d`
	// for correspondence days, `-` for untimed). Nil means unlimited:
	// local engine games and rows imported before the field existed.
	// Server-trusted like Opponent: bulk import stamps it, single saves
	// leave it empty.
	TimeControl *string `json:"time_control,omitempty"`
	// Speed is the Lichess speed pool (`bullet`, `blitz`, `rapid`,
	// `classical`, `correspondence`, ...). Nil when unknown: local games
	// and rows imported before the field existed. Server-trusted like
	// Opponent: bulk import stamps it, single saves leave it empty.
	Speed *string `json:"speed,omitempty"`
	// Clocks holds per-ply remaining time in centiseconds, one entry per
	// move for the side that just moved (Lichess `clocks` field). Nil when
	// unknown: local games, correspondence/untimed imports, and rows
	// imported before clocks were requested. Server-trusted like Opponent:
	// bulk import stamps it, single saves leave it empty.
	Clocks []int `json:"clocks,omitempty"`
	// OwnerID scopes the row to one user. Empty means an unowned row.
	OwnerID string `json:"owner_id,omitempty"`
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
	// The remaining fields are server-owned (see GameRow): handlers stamp or
	// clear them and ignore client values, so the store keeps one save path
	// for unowned ('') and owned rows.
	Source      string  `json:"source,omitempty"`
	Opponent    string  `json:"opponent,omitempty"`
	RatingDiff  *int    `json:"rating_diff,omitempty"`
	TimeControl *string `json:"time_control,omitempty"`
	Clocks      []int   `json:"clocks,omitempty"`
	Speed       *string `json:"speed,omitempty"`
	// OwnerID is server-owned: handlers overwrite it from the session. It
	// stays in the payload so the store has one save path for unowned ('')
	// and owned rows.
	OwnerID string `json:"owner_id,omitempty"`
}

// ValidateGamePayload checks a game save before it reaches the store.
func ValidateTimeControl(value *string) *apierror.RequestError {
	if value == nil {
		return nil
	}
	raw := *value
	if raw == "-" {
		return nil
	}
	if len(raw) > 32 {
		return &apierror.RequestError{Code: "invalid_time_control", Message: "time_control must be like 600+5, 3d, or -"}
	}
	if strings.HasSuffix(raw, "d") {
		days, err := strconv.Atoi(strings.TrimSuffix(raw, "d"))
		if err != nil || days < 1 || days > 14 {
			return &apierror.RequestError{Code: "invalid_time_control", Message: "time_control must be like 600+5, 3d, or -"}
		}
		return nil
	}
	parts := strings.Split(raw, "+")
	if len(parts) != 2 {
		return &apierror.RequestError{Code: "invalid_time_control", Message: "time_control must be like 600+5, 3d, or -"}
	}
	initial, err := strconv.Atoi(parts[0])
	if err != nil || initial < 0 || initial > 1209600 {
		return &apierror.RequestError{Code: "invalid_time_control", Message: "time_control must be like 600+5, 3d, or -"}
	}
	increment, err := strconv.Atoi(parts[1])
	if err != nil || increment < 0 || increment > 3600 {
		return &apierror.RequestError{Code: "invalid_time_control", Message: "time_control must be like 600+5, 3d, or -"}
	}
	return nil
}

// ValidateSpeed checks a Lichess speed pool label before it reaches the store.
func ValidateSpeed(value *string) *apierror.RequestError {
	if value == nil || *value == "" {
		return nil
	}
	switch *value {
	case "ultrabullet", "bullet", "blitz", "rapid", "classical", "correspondence", "unlimited":
		return nil
	default:
		return &apierror.RequestError{Code: "invalid_speed", Message: "speed must be a Lichess pool"}
	}
}

// maxClockCentiseconds bounds one per-ply reading: 14 days in
// centiseconds. Correspondence games carry no readings at all.
const maxClockCentiseconds = 14 * 86400 * 100

// ValidateClocks checks per-ply remaining centiseconds before they reach
// the store. Length is checked against the move list by ValidateGamePayload.
func ValidateClocks(value []int) *apierror.RequestError {
	if value == nil {
		return nil
	}
	if len(value) > 4096 {
		return &apierror.RequestError{Code: "invalid_clocks", Message: "clocks must hold one entry per ply"}
	}
	for _, reading := range value {
		if reading < 0 || reading > maxClockCentiseconds {
			return &apierror.RequestError{Code: "invalid_clocks", Message: "clocks must hold one entry per ply"}
		}
	}
	return nil
}

// ValidateSource checks the server-owned origin stamp when present.
// Empty is allowed here because single saves stamp after validation;
// the import handler rejects empties before they reach the store, and the
// DB trigger rejects any empty that slips through.
func ValidateSource(value string) *apierror.RequestError {
	if value == "" {
		return nil
	}
	if value == "local" {
		return nil
	}
	if len(value) > 32 {
		return &apierror.RequestError{Code: "invalid_source", Message: "game source must be local or lichess:<gameId>"}
	}
	if len(value) < 12 || len(value) > 24 || !strings.HasPrefix(value, "lichess:") {
		return &apierror.RequestError{Code: "invalid_source", Message: "game source must be local or lichess:<gameId>"}
	}
	gameID := strings.TrimPrefix(value, "lichess:")
	if len(gameID) < 4 || len(gameID) > 16 {
		return &apierror.RequestError{Code: "invalid_source", Message: "game source must be local or lichess:<gameId>"}
	}
	for _, c := range gameID {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			return &apierror.RequestError{Code: "invalid_source", Message: "game source must be local or lichess:<gameId>"}
		}
	}
	return nil
}

// ValidateOpponent checks the server-owned opponent name when present.
// Empty is allowed here for the same stamping reason as ValidateSource.
func ValidateOpponent(value string) *apierror.RequestError {
	if value == "" {
		return nil
	}
	if len(value) < 1 || len(value) > 64 {
		return &apierror.RequestError{Code: "invalid_opponent", Message: "game opponent must be 1-64 printable characters"}
	}
	for _, c := range value {
		if c < 0x20 || c == 0x7f {
			return &apierror.RequestError{Code: "invalid_opponent", Message: "game opponent must be 1-64 printable characters"}
		}
	}
	return nil
}

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
	if payload.RatingDiff != nil && (*payload.RatingDiff < -1000 || *payload.RatingDiff > 1000) {
		return &apierror.RequestError{Code: "invalid_rating_diff", Message: "rating_diff must be between -1000 and 1000"}
	}
	if err := ValidateTimeControl(payload.TimeControl); err != nil {
		return err
	}
	if err := ValidateSpeed(payload.Speed); err != nil {
		return err
	}
	if err := ValidateClocks(payload.Clocks); err != nil {
		return err
	}
	if err := ValidateSource(payload.Source); err != nil {
		return err
	}
	if err := ValidateOpponent(payload.Opponent); err != nil {
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
	if payload.Clocks != nil && len(payload.Clocks) != len(payload.Moves) {
		return &apierror.RequestError{Code: "invalid_clocks", Message: "clocks must hold one entry per ply"}
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
// always becomes now. When current is true the per-user current-game marker
// moves too (only when OwnerID is set; unscoped saves track no marker).
// It reports isNew=true when the id was absent (a genuinely new game row),
// false for updates and unchanged re-saves.
func (s *GameStore) Save(payload GamePayload) (GameRow, bool, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	id := payload.ID
	if id == "" {
		generated, err := NewHexID()
		if err != nil {
			return GameRow{}, false, err
		}
		id = generated
	}
	moves, err := encodeJSONColumn(payload.Moves)
	if err != nil {
		return GameRow{}, false, err
	}
	type saveResult struct {
		game  GameRow
		isNew bool
	}
	res, err := withTx(s.db, func(tx *sql.Tx) (saveResult, error) {
		var created, updated, stored, storedOwner, storedSource, storedOpponent string
		var storedColor, storedModel, storedResult string
		var storedMaia, storedUser int
		var storedTemperature float64
		var storedRatingDiff sql.NullInt64
		var storedTimeControl, storedSpeed, storedClocks sql.NullString
		err := tx.QueryRow(`SELECT created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result, owner_id, source, opponent, rating_diff, time_control, speed, clocks
			FROM games WHERE id = ?`, id).Scan(&created, &updated, &storedColor, &storedMaia, &storedUser, &storedModel, &stored, &storedTemperature, &storedResult, &storedOwner, &storedSource, &storedOpponent, &storedRatingDiff, &storedTimeControl, &storedSpeed, &storedClocks)
		isNew := false
		switch {
		case errors.Is(err, sql.ErrNoRows):
			isNew = true
			created = payload.CreatedAt
			if created == "" {
				created = now
			}
		case err != nil:
			return saveResult{}, err
		default:
			// Ownership is load-bearing: one user must not overwrite another's
			// row (including unowned '' rows) by reusing its id.
			if storedOwner != payload.OwnerID {
				return saveResult{}, ErrOwnerMismatch
			}
			// Resuming or re-saving unchanged content must not churn recency order.
			// Source rides along: imports re-saving the same external game
			// must not churn either, and a conflicting source never rewrites.
			if storedColor == payload.UserColor && storedMaia == *payload.EloMaia && storedUser == *payload.EloUser &&
				storedModel == payload.Model && stored == moves && storedTemperature == payload.Temperature && storedResult == payload.Result &&
				storedSource == payload.Source && storedOpponent == payload.Opponent && ratingDiffEqual(storedRatingDiff, payload.RatingDiff) &&
				nullableStringEqual(storedTimeControl, payload.TimeControl) && nullableStringEqual(storedSpeed, payload.Speed) &&
				clocksEqual(storedClocks, payload.Clocks) {
				if payload.Current {
					if err := setCurrentTx(tx, payload.OwnerID, id); err != nil {
						return saveResult{}, err
					}
				}
				return saveResult{game: GameRow{ID: id, CreatedAt: created, UpdatedAt: updated, UserColor: payload.UserColor,
					EloMaia: *payload.EloMaia, EloUser: *payload.EloUser, Model: payload.Model, Moves: payload.Moves, Temperature: payload.Temperature, Result: payload.Result, OwnerID: payload.OwnerID, Source: payload.Source, Opponent: payload.Opponent, RatingDiff: payload.RatingDiff, TimeControl: payload.TimeControl, Speed: payload.Speed, Clocks: payload.Clocks}}, nil
			}
		}
		var ratingDiff any
		if payload.RatingDiff != nil {
			ratingDiff = *payload.RatingDiff
		}
		var timeControl any
		if payload.TimeControl != nil {
			timeControl = *payload.TimeControl
		}
		var speed any
		if payload.Speed != nil {
			speed = *payload.Speed
		}
		var clocks any
		if payload.Clocks != nil {
			encoded, err := encodeJSONColumn(payload.Clocks)
			if err != nil {
				return saveResult{}, err
			}
			clocks = encoded
		}
		_, err = tx.Exec(`INSERT INTO games (id, created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result, owner_id, source, opponent, rating_diff, time_control, speed, clocks)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at, user_color = excluded.user_color,
				elo_maia = excluded.elo_maia, elo_user = excluded.elo_user, model = excluded.model, moves = excluded.moves, temperature = excluded.temperature, result = excluded.result, owner_id = excluded.owner_id, source = excluded.source, opponent = excluded.opponent, rating_diff = excluded.rating_diff, time_control = excluded.time_control, speed = excluded.speed, clocks = excluded.clocks`,
			id, created, now, payload.UserColor, *payload.EloMaia, *payload.EloUser, payload.Model, moves, payload.Temperature, payload.Result, payload.OwnerID, payload.Source, payload.Opponent, ratingDiff, timeControl, speed, clocks)
		if err != nil {
			return saveResult{}, err
		}
		if payload.Current {
			if err := setCurrentTx(tx, payload.OwnerID, id); err != nil {
				return saveResult{}, err
			}
		}
		return saveResult{game: GameRow{ID: id, CreatedAt: created, UpdatedAt: now, UserColor: payload.UserColor,
			EloMaia: *payload.EloMaia, EloUser: *payload.EloUser, Model: payload.Model, Moves: payload.Moves, Temperature: payload.Temperature, Result: payload.Result, OwnerID: payload.OwnerID, Source: payload.Source, Opponent: payload.Opponent, RatingDiff: payload.RatingDiff, TimeControl: payload.TimeControl, Speed: payload.Speed, Clocks: payload.Clocks}, isNew: isNew}, nil
	})
	if err != nil {
		return GameRow{}, false, err
	}
	return res.game, res.isNew, nil
}

func setCurrentTx(tx *sql.Tx, ownerID, gameID string) error {
	if ownerID == "" {
		return nil
	}
	_, err := tx.Exec(`INSERT INTO user_current (user_id, game_id) VALUES (?, ?)
		ON CONFLICT (user_id) DO UPDATE SET game_id = excluded.game_id`, ownerID, gameID)
	return err
}

type gameScanner interface {
	Scan(...any) error
}

func ratingDiffEqual(stored sql.NullInt64, payload *int) bool {
	if payload == nil {
		return !stored.Valid
	}
	return stored.Valid && stored.Int64 == int64(*payload)
}

func nullableStringEqual(stored sql.NullString, payload *string) bool {
	if payload == nil {
		return !stored.Valid
	}
	return stored.Valid && stored.String == *payload
}

// clocksEqual compares the stored per-ply readings JSON against the payload.
// Nil means unknown (local games, untimed imports); an empty slice never
// occurs (validation and the importer drop empties).
func clocksEqual(stored sql.NullString, payload []int) bool {
	if payload == nil {
		return !stored.Valid
	}
	if !stored.Valid {
		return false
	}
	var readings []int
	if err := json.Unmarshal([]byte(stored.String), &readings); err != nil {
		return false
	}
	return slices.Equal(readings, payload)
}

func scanGame(scanner gameScanner) (GameRow, error) {
	var game GameRow
	var moves string
	var ratingDiff sql.NullInt64
	var timeControl, speed, clocks sql.NullString
	if err := scanner.Scan(&game.ID, &game.CreatedAt, &game.UpdatedAt, &game.UserColor,
		&game.EloMaia, &game.EloUser, &game.Model, &moves, &game.Temperature, &game.Result, &game.OwnerID, &game.Source, &game.Opponent, &ratingDiff, &timeControl, &speed, &clocks); err != nil {
		return GameRow{}, err
	}
	if ratingDiff.Valid {
		value := int(ratingDiff.Int64)
		game.RatingDiff = &value
	}
	if timeControl.Valid {
		value := timeControl.String
		game.TimeControl = &value
	}
	if speed.Valid {
		value := speed.String
		game.Speed = &value
	}
	if clocks.Valid {
		var readings []int
		if err := json.Unmarshal([]byte(clocks.String), &readings); err != nil {
			return GameRow{}, err
		}
		game.Clocks = readings
	}
	decoded, err := decodeMovesColumn(moves)
	if err != nil {
		return GameRow{}, err
	}
	game.Moves = decoded
	return game, nil
}

// ErrOwnerMismatch signals a cross-owner id reuse. Handlers map it to
// 403/404 without leaking the other owner's row.
var ErrOwnerMismatch = errors.New("game owned by another user")

func (s *GameStore) Get(id string) (GameRow, error) {
	game, err := scanGame(s.db.QueryRow(`SELECT id, created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result, owner_id, source, opponent, rating_diff, time_control, speed, clocks
		FROM games WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return GameRow{}, sql.ErrNoRows
	}
	return game, err
}

// GetForUser returns the row only when it belongs to ownerID; otherwise
// ErrNoRows (404, no existence leak) or ErrOwnerMismatch when callers need
// to distinguish a forbidden cross-owner access.
func (s *GameStore) GetForUser(id, ownerID string) (GameRow, error) {
	game, err := s.Get(id)
	if err != nil {
		return GameRow{}, err
	}
	if game.OwnerID != ownerID {
		return GameRow{}, ErrOwnerMismatch
	}
	return game, nil
}

// ListForUser scopes history to one owner. Empty ownerID matches unowned
// rows (and unscoped test fixtures).
func (s *GameStore) ListForUser(limit int, ownerID string, offsets ...int) ([]GameRow, int, error) {
	offset := 0
	if len(offsets) > 0 {
		offset = offsets[0]
	}
	var total int
	var err error
	var rows *sql.Rows
	if ownerID == "" {
		total, err = countRows(s.db, `SELECT COUNT(*) FROM games`)
		if err != nil {
			return nil, 0, err
		}
		rows, err = s.db.Query(`SELECT id, created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result, owner_id, source, opponent, rating_diff, time_control, speed, clocks
			FROM games ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`, limit, offset)
	} else {
		total, err = countRows(s.db, `SELECT COUNT(*) FROM games WHERE owner_id = ?`, ownerID)
		if err != nil {
			return nil, 0, err
		}
		rows, err = s.db.Query(`SELECT id, created_at, updated_at, user_color, elo_maia, elo_user, model, moves, temperature, result, owner_id, source, opponent, rating_diff, time_control, speed, clocks
			FROM games WHERE owner_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`, ownerID, limit, offset)
	}
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

// CurrentIDForUser reads one user's current-game marker ("" when unset).
// Unscoped saves never set a marker, so "" always reads "".
func (s *GameStore) CurrentIDForUser(ownerID string) string {
	if ownerID == "" {
		return ""
	}
	return s.GetUserCurrent(ownerID)
}

// Delete removes a game and clears the current-game marker when it points there.
// Deleting an unknown id still succeeds, keeping client retries idempotent.
func (s *GameStore) Delete(id string) error {
	return s.DeleteForUser(id, "")
}

// DeleteForUser deletes only when the row belongs to ownerID. Unknown ids
// and cross-owner ids both succeed silently at the store layer (handlers
// decide 404 vs 403); the per-user marker clears when matched.
func (s *GameStore) DeleteForUser(id, ownerID string) error {
	_, err := withTx(s.db, func(tx *sql.Tx) (struct{}, error) {
		if ownerID == "" {
			if _, err := tx.Exec(`DELETE FROM games WHERE id = ?`, id); err != nil {
				return struct{}{}, err
			}
			return struct{}{}, nil
		}
		var storedOwner string
		err := tx.QueryRow(`SELECT owner_id FROM games WHERE id = ?`, id).Scan(&storedOwner)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			return struct{}{}, nil
		case err != nil:
			return struct{}{}, err
		case storedOwner != ownerID:
			return struct{}{}, nil
		}
		if _, err := tx.Exec(`DELETE FROM games WHERE id = ?`, id); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(`DELETE FROM user_current WHERE user_id = ? AND game_id = ?`, ownerID, id); err != nil {
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
