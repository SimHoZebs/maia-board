package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

// GameStore persists game history in SQLite. All games start from the standard
// position, so only the UCI move history is stored. Terminal resignation is
// stored in result; other endings derive from replaying moves.
type GameStore struct {
	db *sql.DB
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
	if err := initSchema(db); err != nil {
		db.Close()
		return nil, err
	}
	return &GameStore{db: db}, nil
}

// initSchema creates and migrates every table in open order. The order is
// load-bearing: the owner/source index drop runs before the legacy backfill
// (see ensureGameOwnerColumn), and the strict triggers install last so the
// backfill itself is not rejected.
func initSchema(db *sql.DB) error {
	if err := ensureGamesBaseTable(db); err != nil {
		return err
	}
	if err := ensureV2Cache(db); err != nil {
		return err
	}
	if err := migrateGameSchema(db); err != nil {
		return err
	}
	if err := ensureUserSchema(db); err != nil {
		return err
	}
	if err := ensureImportSchema(db); err != nil {
		return err
	}
	if err := ensureGameOwnerColumn(db); err != nil {
		return err
	}
	return ensureStrictConstraints(db)
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
