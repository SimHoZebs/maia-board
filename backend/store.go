package main

import (
	"database/sql"
	"encoding/json"
)

// withTx runs fn inside a transaction, rolling back on error and committing
// on success. Shared by the games table (update-in-place) and the
// evaluations_v2 cache (delete-then-insert for LRU); tables and their
// opposite write strategies stay separate, only the plumbing is shared.
func withTx[T any](db *sql.DB, fn func(tx *sql.Tx) (T, error)) (T, error) {
	var zero T
	tx, err := db.Begin()
	if err != nil {
		return zero, err
	}
	defer tx.Rollback()
	result, err := fn(tx)
	if err != nil {
		return zero, err
	}
	if err := tx.Commit(); err != nil {
		return zero, err
	}
	return result, nil
}

// encodeJSONColumn marshals a value for a JSON text column.
func encodeJSONColumn(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// decodeMovesColumn decodes the games moves JSON column, normalizing null to
// an empty slice so old rows and fresh writes compare equal.
func decodeMovesColumn(raw string) ([]string, error) {
	var moves []string
	if err := json.Unmarshal([]byte(raw), &moves); err != nil {
		return nil, err
	}
	if moves == nil {
		moves = []string{}
	}
	return moves, nil
}

// countRows returns COUNT(*) for the caller's query (table stays with the
// caller; only the scan plumbing is shared). Accepts *sql.DB or *sql.Tx.
type queryRower interface {
	QueryRow(query string, args ...any) *sql.Row
}

func countRows(q queryRower, query string, args ...any) (int, error) {
	var count int
	if err := q.QueryRow(query, args...).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

// evictOldestRows deletes overflow rows oldest-first by rowid. Used by the
// disposable cache only; games never evict.
func evictOldestRows(tx *sql.Tx, table string, overflow int) error {
	if overflow <= 0 {
		return nil
	}
	_, err := tx.Exec(`DELETE FROM `+table+` WHERE rowid IN (
		SELECT rowid FROM `+table+` ORDER BY rowid LIMIT ?)`, overflow)
	return err
}
