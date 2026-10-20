package store

import "database/sql"

func ensureUserSchema(db *sql.DB) error {
	schema := `
	CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
		created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
		display_name TEXT NOT NULL DEFAULT 'Player' CHECK (length(display_name) BETWEEN 1 AND 40),
		lichess_username TEXT UNIQUE CHECK (lichess_username IS NULL OR (length(lichess_username) BETWEEN 1 AND 64 AND lichess_username = lower(lichess_username))),
		lichess_id TEXT UNIQUE CHECK (lichess_id IS NULL OR length(lichess_id) BETWEEN 1 AND 128),
		CHECK ((lichess_username IS NULL) = (lichess_id IS NULL))
	);
	CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE CHECK (length(user_id) BETWEEN 1 AND 128),
		created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
		expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 1 AND 64)
	);
	CREATE TABLE IF NOT EXISTS user_current (
		user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE CHECK (length(user_id) BETWEEN 1 AND 128),
		game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE CHECK (length(game_id) BETWEEN 1 AND 128)
	);
	CREATE TABLE IF NOT EXISTS oauth_state (
		state TEXT PRIMARY KEY CHECK (length(state) BETWEEN 1 AND 128),
		verifier TEXT NOT NULL CHECK (length(verifier) BETWEEN 1 AND 256),
		redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 512),
		created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
		expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 1 AND 64)
	);
	CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
	CREATE INDEX IF NOT EXISTS idx_users_lichess ON users(lichess_username);
	CREATE INDEX IF NOT EXISTS idx_users_lichess_id ON users(lichess_id);`
	_, err := db.Exec(schema)
	return err
}
