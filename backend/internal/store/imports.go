package store

import (
	"database/sql"
	"strings"
	"time"
)

// ImportRun remembers one bulk history append so the UI can summarize it
// ("87 games from @user, Oct 15") instead of presenting an eternal blank
// form. Runs are per user and provider; details stay in the games table.
type ImportRun struct {
	ID        string `json:"id"`
	UserID    string `json:"user_id"`
	Provider  string `json:"provider"`
	Username  string `json:"username"`
	Requested int    `json:"requested"`
	Saved     int    `json:"saved"`
	Skipped   int    `json:"skipped"`
	CreatedAt string `json:"created_at"`
}

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

// RecordImportRun files one import summary. Zero-request bookkeeping calls
// (e.g. nothing new) are still runs: they refresh the "last checked" date.
func (s *GameStore) RecordImportRun(userID, provider, username string, requested, saved, skipped int) (ImportRun, error) {
	id, err := NewHexID()
	if err != nil {
		return ImportRun{}, err
	}
	run := ImportRun{ID: id, UserID: userID, Provider: provider, Username: username,
		Requested: requested, Saved: saved, Skipped: skipped, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if _, err := s.db.Exec(`INSERT INTO import_runs (id, user_id, provider, username, requested, saved, skipped, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		run.ID, run.UserID, run.Provider, run.Username, run.Requested, run.Saved, run.Skipped, run.CreatedAt); err != nil {
		return ImportRun{}, err
	}
	return run, nil
}

// LastImportRun returns the newest run for one user and provider.
func (s *GameStore) LastImportRun(userID, provider string) (ImportRun, error) {
	var run ImportRun
	err := s.db.QueryRow(`SELECT id, user_id, provider, username, requested, saved, skipped, created_at
		FROM import_runs WHERE user_id = ? AND provider = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
		userID, provider).Scan(&run.ID, &run.UserID, &run.Provider, &run.Username,
		&run.Requested, &run.Saved, &run.Skipped, &run.CreatedAt)
	return run, err
}

// ExistingSources reports which external sources already have rows for one
// owner, so bulk imports skip re-runs instead of duplicating them.
func (s *GameStore) ExistingSources(ownerID string, sources []string) (map[string]bool, error) {
	found := make(map[string]bool, len(sources))
	unique := make([]string, 0, len(sources))
	for _, source := range sources {
		if source == "" || found[source] {
			continue
		}
		found[source] = false
		unique = append(unique, source)
	}
	if ownerID == "" || len(unique) == 0 {
		return found, nil
	}
	for at := 0; at < len(unique); at += 500 {
		end := min(at+500, len(unique))
		chunk := unique[at:end]
		placeholders := strings.Repeat("?,", len(chunk)-1) + "?"
		args := make([]any, 0, len(chunk)+1)
		args = append(args, ownerID)
		for _, source := range chunk {
			args = append(args, source)
		}
		rows, err := s.db.Query(`SELECT source FROM games WHERE owner_id = ? AND source IN (`+placeholders+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var source string
			if err := rows.Scan(&source); err != nil {
				rows.Close()
				return nil, err
			}
			found[source] = true
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return found, nil
}
