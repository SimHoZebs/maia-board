package store

import "database/sql"

func ensureImportSchema(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS import_runs (
		id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
		user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE CHECK (length(user_id) BETWEEN 1 AND 128),
		provider TEXT NOT NULL CHECK (provider IN ('lichess')),
		username TEXT NOT NULL CHECK (length(username) BETWEEN 0 AND 64),
		requested INTEGER NOT NULL CHECK (requested >= 0),
		saved INTEGER NOT NULL CHECK (saved >= 0),
		skipped INTEGER NOT NULL CHECK (skipped >= 0),
		created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
		CHECK (saved <= requested AND skipped <= requested)
	);
	CREATE INDEX IF NOT EXISTS idx_import_runs_user ON import_runs(user_id, provider, created_at DESC)`)
	return err
}
