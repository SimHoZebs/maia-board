package store

import "database/sql"

// Games table DDL. One shot: fresh databases get the full schema with
// CHECKs from CREATE TABLE; there are no migrations (SQLite cannot ADD a
// CHECK to a live table). Go Validate* functions mirror these bounds with
// API error codes before writes reach the store.

func ensureGamesBaseTable(db *sql.DB) error {
	schema := `
	CREATE TABLE IF NOT EXISTS games (
		id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
		created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64),
		updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64 AND updated_at >= created_at),
		user_color TEXT NOT NULL CHECK (user_color IN ('white', 'black')),
		elo_maia INTEGER NOT NULL CHECK (elo_maia BETWEEN 0 AND 5000),
		elo_user INTEGER NOT NULL CHECK (elo_user BETWEEN 0 AND 5000),
		model TEXT NOT NULL CHECK (model IN ('79m', '5m')),
		moves TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(moves)),
		result TEXT NOT NULL DEFAULT '' CHECK (result IN ('', 'resigned')),
		temperature REAL NOT NULL DEFAULT 0 CHECK (temperature BETWEEN 0 AND 2),
		rating_diff INTEGER CHECK (rating_diff IS NULL OR (rating_diff BETWEEN -1000 AND 1000)),
		time_control TEXT CHECK (time_control IS NULL OR (length(time_control) BETWEEN 1 AND 32)),
		speed TEXT CHECK (speed IS NULL OR speed IN ('ultrabullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unlimited')),
		clocks TEXT CHECK (clocks IS NULL OR json_valid(clocks)),
		owner_id TEXT NOT NULL DEFAULT '' CHECK (owner_id = '' OR length(owner_id) BETWEEN 1 AND 128),
		source TEXT NOT NULL DEFAULT 'local' CHECK (length(source) BETWEEN 1 AND 32 AND (source = 'local' OR source LIKE 'lichess:%')),
		opponent TEXT NOT NULL DEFAULT 'Unknown' CHECK (length(opponent) BETWEEN 1 AND 64)
	);
	CREATE INDEX IF NOT EXISTS idx_games_updated ON games(updated_at DESC);
	CREATE INDEX IF NOT EXISTS idx_games_owner ON games(owner_id, updated_at DESC);
	CREATE UNIQUE INDEX IF NOT EXISTS idx_games_owner_source ON games(owner_id, source) WHERE source LIKE 'lichess:%';`
	if _, err := db.Exec(schema); err != nil {
		return err
	}
	return nil
}
