package store

import "database/sql"

// Games table DDL plus the additive game-column migrations. Fresh databases
// get the base CHECKs from CREATE TABLE; existing databases gain newer
// columns via ensureGameColumn below (SQLite cannot ADD a CHECK to a live
// table — see schema_triggers.go for the trigger parity).

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
		temperature REAL NOT NULL DEFAULT 0 CHECK (temperature BETWEEN 0 AND 2)
	);
	CREATE INDEX IF NOT EXISTS idx_games_updated ON games(updated_at DESC);`
	if _, err := db.Exec(schema); err != nil {
		return err
	}
	// The legacy evaluations table is disposable cache, not user data: drop
	// it once on open. Misses recompute through the engine endpoints.
	if _, err := db.Exec(`DROP TABLE IF EXISTS evaluations`); err != nil {
		return err
	}
	// The legacy meta KV table held the pre-user global current-game marker.
	// Per-user markers live in user_current now; drop it once on open.
	_, err := db.Exec(`DROP TABLE IF EXISTS meta`)
	return err
}

func migrateGameSchema(db *sql.DB) error {
	if err := ensureGameColumn(db, "temperature", "ALTER TABLE games ADD COLUMN temperature REAL NOT NULL DEFAULT 0 CHECK (temperature BETWEEN 0 AND 2)"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "result", "ALTER TABLE games ADD COLUMN result TEXT NOT NULL DEFAULT '' CHECK (result IN ('', 'resigned'))"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "rating_diff", "ALTER TABLE games ADD COLUMN rating_diff INTEGER CHECK (rating_diff IS NULL OR (rating_diff BETWEEN -1000 AND 1000))"); err != nil {
		return err
	}
	return migrateGameTimeColumns(db)
}

func migrateGameTimeColumns(db *sql.DB) error {
	if err := ensureGameColumn(db, "time_control", "ALTER TABLE games ADD COLUMN time_control TEXT CHECK (time_control IS NULL OR (length(time_control) BETWEEN 1 AND 32))"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "speed", "ALTER TABLE games ADD COLUMN speed TEXT CHECK (speed IS NULL OR speed IN ('ultrabullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unlimited'))"); err != nil {
		return err
	}
	return ensureGameColumn(db, "clocks", "ALTER TABLE games ADD COLUMN clocks TEXT CHECK (clocks IS NULL OR json_valid(clocks))")
}

func ensureGameColumn(db *sql.DB, column, alter string) error {
	rows, err := db.Query("PRAGMA table_info(games)")
	if err != nil {
		return err
	}
	found := false
	for rows.Next() {
		var id, notNull, primary int
		var name, kind string
		var fallback any
		if err := rows.Scan(&id, &name, &kind, &notNull, &fallback, &primary); err != nil {
			rows.Close()
			return err
		}
		if name == column {
			found = true
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if !found {
		_, err = db.Exec(alter)
	}
	return err
}

func ensureGameOwnerColumn(db *sql.DB) error {
	if err := ensureGameColumn(db, "owner_id", "ALTER TABLE games ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if _, err := db.Exec(`CREATE INDEX IF NOT EXISTS idx_games_owner ON games(owner_id, updated_at DESC)`); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "source", "ALTER TABLE games ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK (length(source) BETWEEN 1 AND 32 AND (source = 'local' OR source LIKE 'lichess:%'))"); err != nil {
		return err
	}
	if err := ensureGameColumn(db, "opponent", "ALTER TABLE games ADD COLUMN opponent TEXT NOT NULL DEFAULT 'Unknown' CHECK (length(opponent) BETWEEN 1 AND 64)"); err != nil {
		return err
	}
	// External imports dedupe per owner: re-running the same Lichess import
	// skips rows instead of duplicating them. Only `lichess:<id>` rows
	// participate; local games carry `local` and never collide.
	// DROP first: pre-strict DBs already have this name with the old
	// `WHERE source <> ''` predicate, and CREATE IF NOT EXISTS would keep
	// the stale index live — then backfilling 26x (owner, local) collides
	// and NewGameStore fails open. The drop runs before backfill via
	// initSchema order (ensureGameOwnerColumn -> ensureStrictConstraints).
	if _, err := db.Exec(`DROP INDEX IF EXISTS idx_games_owner_source`); err != nil {
		return err
	}
	_, err := db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_games_owner_source ON games(owner_id, source) WHERE source LIKE 'lichess:%'`)
	return err
}
