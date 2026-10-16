package store

import (
	"database/sql"
	"errors"
	"time"
)

// User is the account primitive. Games, current markers, review jobs, and
// engine calls scope to User.ID. Lichess linkage is optional: local users
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

func ensureUserSchema(db *sql.DB) error {
	schema := `
	CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		created_at TEXT NOT NULL,
		display_name TEXT NOT NULL DEFAULT '',
		lichess_username TEXT UNIQUE,
		lichess_id TEXT UNIQUE
	);
	CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS user_current (
		user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		game_id TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS oauth_state (
		state TEXT PRIMARY KEY,
		verifier TEXT NOT NULL,
		redirect_uri TEXT NOT NULL,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);
	CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
	CREATE INDEX IF NOT EXISTS idx_users_lichess ON users(lichess_username);`
	if _, err := db.Exec(schema); err != nil {
		return err
	}
	if err := ensureImportSchema(db); err != nil {
		return err
	}
	return ensureGameOwnerColumn(db)
}

func ensureGameOwnerColumn(db *sql.DB) error {
	if err := ensureGameColumn(db, "owner_id", "ALTER TABLE games ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_games_owner ON games(owner_id, updated_at DESC)`); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "source", "ALTER TABLE games ADD COLUMN source TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "opponent", "ALTER TABLE games ADD COLUMN opponent TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	// External imports dedupe per owner: re-running the same Lichess import
	// skips rows instead of duplicating them. Legacy and local games carry
	// source '' and never collide.
	_, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_games_owner_source ON games(owner_id, source) WHERE source <> ''`)
	return err
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
func (s *GameStore) CreateLocalUser(displayName string) (User, error) {
	id, err := NewHexID()
	if err != nil {
		return User{}, err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if displayName == "" {
		displayName = "Player"
	}
	if _, err := s.db.Exec(`INSERT INTO users (id, created_at, display_name) VALUES (?, ?, ?)`, id, now, displayName); err != nil {
		return User{}, err
	}
	return User{ID: id, CreatedAt: now, DisplayName: displayName}, nil
}

// GetUser fetches one user by id.
func (s *GameStore) GetUser(id string) (User, error) {
	user, err := scanUser(s.db.QueryRow(`SELECT id, created_at, display_name, lichess_username, lichess_id FROM users WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, sql.ErrNoRows
	}
	return user, err
}

// GetUserByLichessName finds a user by linked Lichess username (case-sensitive store; callers normalize).
func (s *GameStore) GetUserByLichessName(username string) (User, error) {
	user, err := scanUser(s.db.QueryRow(`SELECT id, created_at, display_name, lichess_username, lichess_id FROM users WHERE lichess_username = ?`, username))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, sql.ErrNoRows
	}
	return user, err
}

// UpsertLichessUser creates or refreshes the user for a verified Lichess identity.
func (s *GameStore) UpsertLichessUser(lichessID, username string) (User, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if existing, err := scanUser(s.db.QueryRow(`SELECT id, created_at, display_name, lichess_username, lichess_id FROM users WHERE lichess_id = ?`, lichessID)); err == nil {
		if _, err := s.db.Exec(`UPDATE users SET lichess_username = ? WHERE id = ?`, username, existing.ID); err != nil {
			return User{}, err
		}
		existing.LichessUsername = username
		existing.LichessID = lichessID
		return existing, nil
	}
	id, err := NewHexID()
	if err != nil {
		return User{}, err
	}
	if _, err := s.db.Exec(`INSERT INTO users (id, created_at, display_name, lichess_username, lichess_id) VALUES (?, ?, ?, ?, ?)`,
		id, now, username, username, lichessID); err != nil {
		// A racing link for the same username resolves to the winner.
		if existing, err2 := s.GetUserByLichessName(username); err2 == nil {
			return existing, nil
		}
		return User{}, err
	}
	return User{ID: id, CreatedAt: now, DisplayName: username, LichessUsername: username, LichessID: lichessID}, nil
}

// LinkLichess attaches a verified Lichess identity to an existing user.
func (s *GameStore) LinkLichess(userID, lichessID, username string) (User, error) {
	if _, err := s.db.Exec(`UPDATE users SET lichess_username = ?, lichess_id = ? WHERE id = ?`, username, lichessID, userID); err != nil {
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

// CountUnowned reports how many pre-user rows await adoption.
func (s *GameStore) CountUnowned() (int, error) {
	return countRows(s.db, `SELECT COUNT(*) FROM games WHERE owner_id = ''`)
}

// UpdateOpponentIfEmpty backfills a missing opponent name on an imported row
// (re-imports refresh names for rows saved before names were stamped).
// Never touches updated_at: a name refresh must not churn recency order.
func (s *GameStore) UpdateOpponentIfEmpty(ownerID, source, opponent string) (bool, error) {
	if ownerID == "" || source == "" || opponent == "" {
		return false, nil
	}
	result, err := s.db.Exec(`UPDATE games SET opponent = ? WHERE owner_id = ? AND source = ? AND (opponent IS NULL OR opponent = '')`,
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

// AdoptLegacyGames claims every unowned (pre-user) game row for ownerID and
// moves the legacy global current marker onto that user's marker when it
// points at an adopted row. It is idempotent: a second caller adopts nothing.
func (s *GameStore) AdoptLegacyGames(ownerID string) (adopted int, err error) {
	if ownerID == "" {
		return 0, nil
	}
	res, err := withTx(s.db, func(tx *sql.Tx) (int, error) {
		result, err := tx.Exec(`UPDATE games SET owner_id = ? WHERE owner_id = ''`, ownerID)
		if err != nil {
			return 0, err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return 0, err
		}
		var legacy string
		if err := tx.QueryRow(`SELECT value FROM meta WHERE key = 'current_game_id'`).Scan(&legacy); err == nil && legacy != "" {
			var owner string
			if err := tx.QueryRow(`SELECT owner_id FROM games WHERE id = ?`, legacy).Scan(&owner); err == nil && owner == ownerID {
				if _, err := tx.Exec(`INSERT INTO user_current (user_id, game_id) VALUES (?, ?)
					ON CONFLICT (user_id) DO NOTHING`, ownerID, legacy); err != nil {
					return 0, err
				}
			}
		}
		return int(count), nil
	})
	if err != nil {
		return 0, err
	}
	return res, nil
}
func (s *GameStore) SetUserCurrent(userID, gameID string) error {
	_, err := s.db.Exec(`INSERT INTO user_current (user_id, game_id) VALUES (?, ?)
		ON CONFLICT (user_id) DO UPDATE SET game_id = excluded.game_id`, userID, gameID)
	return err
}

// GetUserCurrent reads one user's current-game marker ("" when unset).
func (s *GameStore) GetUserCurrent(userID string) string {
	var id string
	if err := s.db.QueryRow(`SELECT game_id FROM user_current WHERE user_id = ?`, userID).Scan(&id); err != nil {
		return ""
	}
	return id
}

// ClearUserCurrentForGame clears every per-user marker pointing at a deleted game.
func (s *GameStore) ClearUserCurrentForGame(gameID string) {
	_, _ = s.db.Exec(`DELETE FROM user_current WHERE game_id = ?`, gameID)
}
