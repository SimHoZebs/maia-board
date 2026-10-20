package store

import "database/sql"

// The cache owns its disposable schema separately from game migrations.
// The table is created at store open; eviction bounds it without
// touching games.
func ensureV2Cache(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS evaluations_v2 (
		key_hash TEXT PRIMARY KEY CHECK (length(key_hash) BETWEEN 1 AND 128),
		engine TEXT NOT NULL CHECK (engine IN ('maia', 'sf')),
		cache_key TEXT NOT NULL CHECK (length(cache_key) BETWEEN 1 AND 4096),
		value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 65536),
		created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 1 AND 64))`)
	return err
}
