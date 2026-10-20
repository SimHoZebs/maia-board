package store

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

// ErrInvalidDisplayName signals a display name outside 1-40 printable chars.
// Handlers map it to 400; the DB CHECK enforces the same bound.
var ErrInvalidDisplayName = errors.New("display_name must be 1-40 printable characters")

// User is the account primitive. Games, current markers, batch-review jobs,
// and engine calls scope to User.ID. Lichess linkage is optional: local users
// exist first, Lichess OAuth links later.
type User struct {
	ID              string `json:"id"`
	CreatedAt       string `json:"created_at"`
	DisplayName     string `json:"display_name"`
	LichessUsername string `json:"lichess_username,omitempty"`
	LichessID       string `json:"lichess_id,omitempty"`
}

// Session is an opaque bearer token stored hashed-side plain (32 hex chars).
// Transport is an HttpOnly SameSite=Lax cookie; the token itself authorizes.
type Session struct {
	ID        string `json:"id"`
	UserID    string `json:"user_id"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
}

// OAuthState holds a pending Lichess PKCE flow between /start and /callback.
type OAuthState struct {
	State       string `json:"state"`
	Verifier    string `json:"verifier"`
	RedirectURI string `json:"redirect_uri"`
	CreatedAt   string `json:"created_at"`
	ExpiresAt   string `json:"expires_at"`
}

// normalizeLichessUsername canonicalizes a Lichess username for storage and
// lookup: trim surrounding space, lowercase. Lichess names are
// case-insensitive for identity; display case lives in display_name.
func normalizeLichessUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// ValidateDisplayName checks a local display name before it reaches the store.
func ValidateDisplayName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return nil // callers map empty to the 'Player' fallback
	}
	if len([]rune(trimmed)) < 1 || len([]rune(trimmed)) > 40 {
		return ErrInvalidDisplayName
	}
	for _, c := range trimmed {
		if c < 0x20 || c == 0x7f {
			return ErrInvalidDisplayName
		}
	}
	return nil
}

func scanUser(scanner gameScanner) (User, error) {
	var user User
	var lichessUsername, lichessID sql.NullString
	if err := scanner.Scan(&user.ID, &user.CreatedAt, &user.DisplayName, &lichessUsername, &lichessID); err != nil {
		return User{}, err
	}
	if lichessUsername.Valid {
		user.LichessUsername = lichessUsername.String
	}
	if lichessID.Valid {
		user.LichessID = lichessID.String
	}
	return user, nil
}

// CreateLocalUser mints a display-named user with no Lichess link.
// Empty names fall back to the documented `Player` default; over-long or
// control-char names fail clearly instead of reaching the DB CHECK.
func (s *GameStore) CreateLocalUser(displayName string) (User, error) {
	id, err := NewHexID()
	if err != nil {
		return User{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	trimmed := strings.TrimSpace(displayName)
	if trimmed == "" {
		trimmed = "Player"
	}
	if err := ValidateDisplayName(trimmed); err != nil {
		return User{}, err
	}
	if _, err := s.db.Exec(`INSERT INTO users (id, created_at, display_name) VALUES (?, ?, ?)`, id, now, trimmed); err != nil {
		return User{}, err
	}
	return User{ID: id, CreatedAt: now, DisplayName: trimmed}, nil
}

// GetUser fetches one user by id.
func (s *GameStore) GetUser(id string) (User, error) {
	user, err := scanUser(s.db.QueryRow(`SELECT id, created_at, display_name, lichess_username, lichess_id FROM users WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, sql.ErrNoRows
	}
	return user, err
}

// GetUserByLichessName finds a user by linked Lichess username.
// Names are canonical lowercase in storage; lookups normalize the same way.
func (s *GameStore) GetUserByLichessName(username string) (User, error) {
	canonical := normalizeLichessUsername(username)
	user, err := scanUser(s.db.QueryRow(`SELECT id, created_at, display_name, lichess_username, lichess_id FROM users WHERE lichess_username = ?`, canonical))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, sql.ErrNoRows
	}
	return user, err
}

// UpsertLichessUser creates or refreshes the user for a verified Lichess identity.
// The linkage column stores the canonical lowercase name; display_name keeps
// the provider's display case for the UI.
func (s *GameStore) UpsertLichessUser(lichessID, username string) (User, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	canonical := normalizeLichessUsername(username)
	if canonical == "" {
		return User{}, ErrInvalidDisplayName
	}
	if existing, err := scanUser(s.db.QueryRow(`SELECT id, created_at, display_name, lichess_username, lichess_id FROM users WHERE lichess_id = ?`, lichessID)); err == nil {
		if _, err := s.db.Exec(`UPDATE users SET lichess_username = ? WHERE id = ?`, canonical, existing.ID); err != nil {
			return User{}, err
		}
		existing.LichessUsername = canonical
		existing.LichessID = lichessID
		return existing, nil
	}
	id, err := NewHexID()
	if err != nil {
		return User{}, err
	}
	if _, err := s.db.Exec(`INSERT INTO users (id, created_at, display_name, lichess_username, lichess_id) VALUES (?, ?, ?, ?, ?)`,
		id, now, username, canonical, lichessID); err != nil {
		// A racing link for the same username resolves to the winner.
		if existing, err2 := s.GetUserByLichessName(canonical); err2 == nil {
			return existing, nil
		}
		return User{}, err
	}
	return User{ID: id, CreatedAt: now, DisplayName: username, LichessUsername: canonical, LichessID: lichessID}, nil
}

// LinkLichess attaches a verified Lichess identity to an existing user.
func (s *GameStore) LinkLichess(userID, lichessID, username string) (User, error) {
	canonical := normalizeLichessUsername(username)
	if _, err := s.db.Exec(`UPDATE users SET lichess_username = ?, lichess_id = ? WHERE id = ?`, canonical, lichessID, userID); err != nil {
		return User{}, err
	}
	return s.GetUser(userID)
}

// CreateSession mints a bearer session with the given TTL.
func (s *GameStore) CreateSession(userID string, ttl time.Duration) (Session, error) {
	id, err := NewHexID()
	if err != nil {
		return Session{}, err
	}
	now := time.Now().UTC()
	session := Session{
		ID:        id,
		UserID:    userID,
		CreatedAt: now.Format(time.RFC3339Nano),
		ExpiresAt: now.Add(ttl).Format(time.RFC3339Nano),
	}
	if _, err := s.db.Exec(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
		session.ID, session.UserID, session.CreatedAt, session.ExpiresAt); err != nil {
		return Session{}, err
	}
	return session, nil
}

// SessionUser resolves a session token to its user, rejecting expired rows.
func (s *GameStore) SessionUser(token string) (User, error) {
	var userID, expiresAt string
	if err := s.db.QueryRow(`SELECT user_id, expires_at FROM sessions WHERE id = ?`, token).Scan(&userID, &expiresAt); err != nil {
		return User{}, err
	}
	expiry, err := time.Parse(time.RFC3339Nano, expiresAt)
	if err != nil {
		if expiry, err = time.Parse(time.RFC3339, expiresAt); err != nil {
			return User{}, err
		}
	}
	if time.Now().UTC().After(expiry) {
		_, _ = s.db.Exec(`DELETE FROM sessions WHERE id = ?`, token)
		return User{}, sql.ErrNoRows
	}
	return s.GetUser(userID)
}

// DeleteSession revokes one token; unknown tokens still succeed.
func (s *GameStore) DeleteSession(token string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE id = ?`, token)
	return err
}

// StoreOAuthState records a pending PKCE flow (10-minute TTL enforced by callers).
func (s *GameStore) StoreOAuthState(state OAuthState) error {
	_, err := s.db.Exec(`INSERT INTO oauth_state (state, verifier, redirect_uri, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		state.State, state.Verifier, state.RedirectURI, state.CreatedAt, state.ExpiresAt)
	return err
}

// ConsumeOAuthState reads and deletes a pending flow; expired rows are rejected.
func (s *GameStore) ConsumeOAuthState(state string) (OAuthState, error) {
	var pending OAuthState
	err := s.db.QueryRow(`SELECT state, verifier, redirect_uri, created_at, expires_at FROM oauth_state WHERE state = ?`, state).
		Scan(&pending.State, &pending.Verifier, &pending.RedirectURI, &pending.CreatedAt, &pending.ExpiresAt)
	if err != nil {
		return OAuthState{}, err
	}
	_, _ = s.db.Exec(`DELETE FROM oauth_state WHERE state = ?`, state)
	expiry, err := time.Parse(time.RFC3339Nano, pending.ExpiresAt)
	if err != nil {
		if expiry, err = time.Parse(time.RFC3339, pending.ExpiresAt); err != nil {
			return OAuthState{}, err
		}
	}
	if time.Now().UTC().After(expiry) {
		return OAuthState{}, sql.ErrNoRows
	}
	return pending, nil
}

// UpdateOpponentIfEmpty fills a missing opponent name on an imported row.
// Never touches updated_at: a refresh must not churn recency.
func (s *GameStore) UpdateOpponentIfEmpty(ownerID, source, opponent string) (bool, error) {
	if ownerID == "" || source == "" || opponent == "" {
		return false, nil
	}
	result, err := s.db.Exec(`UPDATE games SET opponent = ? WHERE owner_id = ? AND source = ? AND (opponent IS NULL OR opponent = '' OR opponent = 'Unknown')`,
		opponent, ownerID, source)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// UpdateRatingDiffIfEmpty fills a missing Lichess ratingDiff on an
// imported row. Never touches updated_at: a refresh must not churn recency.
func (s *GameStore) UpdateRatingDiffIfEmpty(ownerID, source string, ratingDiff *int) (bool, error) {
	if ownerID == "" || source == "" || ratingDiff == nil {
		return false, nil
	}
	result, err := s.db.Exec(`UPDATE games SET rating_diff = ? WHERE owner_id = ? AND source = ? AND rating_diff IS NULL`,
		*ratingDiff, ownerID, source)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// UpdateTimeControlIfEmpty fills a missing clock setting on an imported
// row. Never touches updated_at: a refresh must not churn recency.
func (s *GameStore) UpdateTimeControlIfEmpty(ownerID, source string, timeControl, speed *string) (bool, error) {
	if ownerID == "" || source == "" || (timeControl == nil && speed == nil) {
		return false, nil
	}
	updated := false
	if timeControl != nil {
		result, err := s.db.Exec(`UPDATE games SET time_control = ? WHERE owner_id = ? AND source = ? AND time_control IS NULL`,
			*timeControl, ownerID, source)
		if err != nil {
			return false, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return false, err
		}
		updated = updated || count > 0
	}
	if speed != nil {
		result, err := s.db.Exec(`UPDATE games SET speed = ? WHERE owner_id = ? AND source = ? AND speed IS NULL`,
			*speed, ownerID, source)
		if err != nil {
			return false, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return false, err
		}
		updated = updated || count > 0
	}
	return updated, nil
}

// UpdateClocksIfEmpty fills missing per-ply readings on an imported row.
// Never touches updated_at: a refresh must not churn recency.
func (s *GameStore) UpdateClocksIfEmpty(ownerID, source string, clocks []int) (bool, error) {
	if ownerID == "" || source == "" || clocks == nil {
		return false, nil
	}
	encoded, err := encodeJSONColumn(clocks)
	if err != nil {
		return false, err
	}
	result, err := s.db.Exec(`UPDATE games SET clocks = ? WHERE owner_id = ? AND source = ? AND clocks IS NULL`,
		encoded, ownerID, source)
	if err != nil {
		return false, err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// GetUserCurrent reads one user's current-game marker ("" when unset).
func (s *GameStore) GetUserCurrent(userID string) string {
	var id string
	if err := s.db.QueryRow(`SELECT game_id FROM user_current WHERE user_id = ?`, userID).Scan(&id); err != nil {
		return ""
	}
	return id
}
