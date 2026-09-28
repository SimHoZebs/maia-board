package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"time"

	"maia-board/backend/internal/evalcache"
)

// CachedEvaluation is one disposable v2 cache row. Values are raw engine
// documents; strict validation happens at the read/write boundary, not here.
type CachedEvaluation struct {
	KeyHash   string          `json:"key_hash"`
	Engine    string          `json:"engine"`
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	CreatedAt string          `json:"created_at"`
}

func (s *GameStore) CacheStats() (count, bytes int, err error) {
	err = s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(LENGTH(value)), 0) FROM evaluations_v2`).Scan(&count, &bytes)
	return count, bytes, err
}

// The cache owns its disposable schema separately from game migrations.
// The table is created at store open; eviction below bounds it without
// touching games.
func ensureV2Cache(db *sql.DB) error {
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS evaluations_v2 (
		key_hash TEXT PRIMARY KEY, engine TEXT NOT NULL, cache_key TEXT NOT NULL,
		value TEXT NOT NULL, created_at TEXT NOT NULL)`)
	return err
}

func (s *GameStore) CachePut(hash, engine, key, value string) (CachedEvaluation, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := withTx(s.db, func(tx *sql.Tx) (struct{}, error) {
		// DELETE then INSERT (rather than ON CONFLICT DO UPDATE) so the row gets
		// a fresh rowid: eviction below orders by rowid, making it
		// least-recently-written-first. An upsert would keep the original rowid
		// and let refreshed openings age out as if never rewritten. Reads do not
		// touch rank: a read-touch would double write load on this
		// single-connection database for a recency signal the current working
		// set (recent games, re-touched on every visit) does not need.
		if _, err := tx.Exec(`DELETE FROM evaluations_v2 WHERE key_hash = ?`, hash); err != nil {
			return struct{}{}, err
		}
		if _, err := tx.Exec(`INSERT INTO evaluations_v2 (key_hash, engine, cache_key, value, created_at)
			VALUES (?, ?, ?, ?, ?)`,
			hash, engine, key, value, now); err != nil {
			return struct{}{}, err
		}
		// SQLite optimizes unfiltered COUNT(*) with its b-tree count operation.
		// Delete only overflow rows using rowid order.
		count, err := countRows(tx, `SELECT COUNT(*) FROM evaluations_v2`)
		if err != nil {
			return struct{}{}, err
		}
		if count > evalcache.MaxRows {
			if err := evictOldestRows(tx, "evaluations_v2", count-evalcache.MaxRows); err != nil {
				return struct{}{}, err
			}
			log.Printf("evaluation cache eviction rows=%d", count-evalcache.MaxRows)
		}
		return struct{}{}, nil
	})
	if err != nil {
		return CachedEvaluation{}, err
	}
	return CachedEvaluation{KeyHash: hash, Engine: engine, Key: key, CreatedAt: now}, nil
}

func (s *GameStore) CacheGet(hash string) (CachedEvaluation, error) {
	var entry CachedEvaluation
	var value string
	err := s.db.QueryRow(`SELECT key_hash, engine, cache_key, value, created_at
		FROM evaluations_v2 WHERE key_hash = ? AND LENGTH(value) <= ? AND LENGTH(cache_key) <= ?`, hash, evalcache.MaxValueBytes, evalcache.MaxKeyBytes).Scan(
		&entry.KeyHash, &entry.Engine, &entry.Key, &value, &entry.CreatedAt)
	if err != nil {
		return CachedEvaluation{}, err
	}
	// Thread raw bytes: no decode/re-marshal here. Strict readers validate
	// the bytes once via strict decode; the GET handler serves them
	// verbatim. Corrupt rows still error instead of serving garbage.
	if !json.Valid([]byte(value)) {
		return CachedEvaluation{}, errors.New("evaluation cache decode failed")
	}
	entry.Value = json.RawMessage(value)
	return entry, nil
}

// CacheGetMany fetches up to len(hashes) rows in bulk order-independent:
// one SELECT per 500-hash chunk with the same size guards as CacheGet.
// Corrupt rows are skipped (misses), never served. A query failure aborts
// the whole fetch with an error so callers can treat it as all-miss, the
// same outcome as N failing point reads.
func (s *GameStore) CacheGetMany(hashes []string) (map[string]CachedEvaluation, error) {
	out := make(map[string]CachedEvaluation, len(hashes))
	seen := make(map[string]bool, len(hashes))
	unique := make([]string, 0, len(hashes))
	for _, hash := range hashes {
		if hash == "" || seen[hash] {
			continue
		}
		seen[hash] = true
		unique = append(unique, hash)
	}
	for at := 0; at < len(unique); at += 500 {
		end := min(at+500, len(unique))
		chunk := unique[at:end]
		placeholders := strings.Repeat("?,", len(chunk)-1) + "?"
		rows, err := s.db.Query(`SELECT key_hash, engine, cache_key, value, created_at
			FROM evaluations_v2 WHERE key_hash IN (`+placeholders+`) AND LENGTH(value) <= ? AND LENGTH(cache_key) <= ?`,
			append(queryArgs(chunk), evalcache.MaxValueBytes, evalcache.MaxKeyBytes)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var entry CachedEvaluation
			var value string
			if err := rows.Scan(&entry.KeyHash, &entry.Engine, &entry.Key, &value, &entry.CreatedAt); err != nil {
				rows.Close()
				return nil, err
			}
			if !json.Valid([]byte(value)) {
				continue
			}
			entry.Value = json.RawMessage(value)
			out[entry.KeyHash] = entry
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return out, nil
}

func queryArgs(hashes []string) []any {
	args := make([]any, 0, len(hashes)+2)
	for _, hash := range hashes {
		args = append(args, hash)
	}
	return args
}
