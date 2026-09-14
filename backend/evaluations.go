package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Server-owned v2 identities share storage with read-only legacy cache rows.
var (
	evalCacheMaxRows       = 25000
	evalCacheMaxKeyBytes   = 4096
	evalCacheMaxValueBytes = 65536
	evalHashPattern        = regexp.MustCompile(`^([0-9a-f]{1,16}|[0-9a-f]{64})$`)
	coverageMaxHashes      = 1024
)

type cachedEvaluation struct {
	KeyHash   string `json:"key_hash"`
	Engine    string `json:"engine"`
	Key       string `json:"key"`
	Value     any    `json:"value"`
	CreatedAt string `json:"created_at"`
}

type cachePut struct {
	Engine string `json:"engine"`
	Key    string `json:"key"`
	Value  any    `json:"value"`
}

func validCachePut(put *cachePut) *requestError {
	if put.Engine != "sf" && put.Engine != "maia" {
		return &requestError{"invalid_request", "engine must be sf or maia"}
	}
	if put.Key == "" || len(put.Key) > evalCacheMaxKeyBytes {
		return &requestError{"invalid_request", "key must be non-empty and short"}
	}
	if put.Value == nil {
		return &requestError{"invalid_request", "value must be a JSON document"}
	}
	encoded, err := json.Marshal(put.Value)
	if err != nil || len(encoded) > evalCacheMaxValueBytes || !json.Valid(encoded) {
		return &requestError{"invalid_request", "value must be a JSON document"}
	}
	object, ok := put.Value.(map[string]any)
	if !ok || len(object) == 0 {
		return &requestError{"invalid_request", "value must be a JSON object"}
	}
	return nil
}

func (s *GameStore) cacheStats() (count, bytes int, err error) {
	var exists int
	err = s.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='evaluations_v2'`).Scan(&exists)
	if err != nil {
		return
	}
	if exists == 0 {
		err = s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(LENGTH(value)),0) FROM evaluations`).Scan(&count, &bytes)
		return
	}
	err = s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(LENGTH(value)), 0) FROM
		(SELECT value FROM evaluations UNION ALL SELECT value FROM evaluations_v2)`).Scan(&count, &bytes)
	return count, bytes, err
}

// The cache owns its disposable schema separately from game migrations. A
// distinct table keeps legacy rows physically intact and lets SQLite count the
// bounded active cache directly, without scanning or filtering legacy values.
func (s *GameStore) ensureV2Cache() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS evaluations_v2 (
		key_hash TEXT PRIMARY KEY, engine TEXT NOT NULL, cache_key TEXT NOT NULL,
		value TEXT NOT NULL, created_at TEXT NOT NULL)`)
	return err
}

func (s *GameStore) cachePut(hash, engine, key, value string) (cachedEvaluation, error) {
	table := "evaluations"
	if strings.HasPrefix(key, "v2:") {
		if err := s.ensureV2Cache(); err != nil {
			return cachedEvaluation{}, err
		}
		table = "evaluations_v2"
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.Begin()
	if err != nil {
		return cachedEvaluation{}, err
	}
	defer tx.Rollback()
	// DELETE then INSERT (rather than ON CONFLICT DO UPDATE) so the row gets
	// a fresh rowid: eviction below orders by rowid, making it
	// least-recently-written-first. An upsert would keep the original rowid
	// and let refreshed openings age out as if never rewritten. Reads do not
	// touch rank: a read-touch would double write load on this
	// single-connection database for a recency signal the current working
	// set (recent games, re-touched on every visit) does not need.
	if _, err := tx.Exec(`DELETE FROM `+table+` WHERE key_hash = ?`, hash); err != nil {
		return cachedEvaluation{}, err
	}
	if _, err := tx.Exec(`INSERT INTO `+table+` (key_hash, engine, cache_key, value, created_at)
		VALUES (?, ?, ?, ?, ?)`,
		hash, engine, key, value, now); err != nil {
		return cachedEvaluation{}, err
	}
	// SQLite optimizes unfiltered COUNT(*) with its b-tree count operation.
	// Delete only overflow rows using rowid order.
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil {
		return cachedEvaluation{}, err
	}
	if table == "evaluations_v2" && count > evalCacheMaxRows {
		if _, err := tx.Exec(`DELETE FROM evaluations_v2 WHERE rowid IN (
		SELECT rowid FROM evaluations_v2 ORDER BY rowid LIMIT ?)`, count-evalCacheMaxRows); err != nil {
			return cachedEvaluation{}, err
		}
		log.Printf("evaluation cache eviction rows=%d", count-evalCacheMaxRows)
	}
	if err := tx.Commit(); err != nil {
		return cachedEvaluation{}, err
	}
	return cachedEvaluation{KeyHash: hash, Engine: engine, Key: key, CreatedAt: now}, nil
}

func (s *GameStore) cacheGet(hash string) (cachedEvaluation, error) {
	table := "evaluations"
	if len(hash) == 64 {
		table = "evaluations_v2"
	}
	var entry cachedEvaluation
	var value string
	err := s.db.QueryRow(`SELECT key_hash, engine, cache_key, value, created_at
		FROM `+table+` WHERE key_hash = ? AND LENGTH(value) <= ? AND LENGTH(cache_key) <= ?`, hash, evalCacheMaxValueBytes, evalCacheMaxKeyBytes).Scan(
		&entry.KeyHash, &entry.Engine, &entry.Key, &value, &entry.CreatedAt)
	if err != nil {
		return cachedEvaluation{}, err
	}
	var decoded any
	if err := json.Unmarshal([]byte(value), &decoded); err != nil {
		return cachedEvaluation{}, err
	}
	entry.Value = decoded
	return entry, nil
}

// The full canonical key is compared as well as its digest.
func validCacheRef(hash, key string) bool {
	return evalHashPattern.MatchString(hash) && key != "" && len(key) <= evalCacheMaxKeyBytes
}

func (s *server) lookupCache(hash, engine, key string) (cachedEvaluation, bool) {
	if s.store == nil || !validCacheRef(hash, key) {
		return cachedEvaluation{}, false
	}
	entry, err := s.store.cacheGet(hash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) && !strings.Contains(err.Error(), "no such table: evaluations_v2") {
		log.Printf("evaluation cache read failed engine=%s error=%v", engine, err)
	}
	if err != nil || entry.Engine != engine || entry.Key != key {
		return cachedEvaluation{}, false
	}
	return entry, true
}

// Best-effort write-through: store failures never fail the live request.
func (s *server) storeCache(hash, engine, key string, value any) {
	if s.store == nil || !validCacheRef(hash, key) {
		return
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		log.Printf("evaluation cache encode failed: %v", err)
		return
	}
	var document any
	if err := json.Unmarshal(encoded, &document); err != nil {
		log.Printf("evaluation cache decode failed: %v", err)
		return
	}
	if validCachePut(&cachePut{Engine: engine, Key: key, Value: document}) != nil {
		log.Printf("evaluation cache rejected engine=%s", engine)
		return
	}
	if !validOwnedCacheValue(hash, engine, key, document) {
		log.Printf("evaluation cache rejected untrusted output engine=%s", engine)
		return
	}
	started := time.Now()
	_, err = s.store.cachePut(hash, engine, key, string(encoded))
	log.Printf("evaluation cache write engine=%s bytes=%d duration_us=%d error=%v", engine, len(encoded), time.Since(started).Microseconds(), err)
}

func (s *server) evaluations(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET is required; evaluation writes are server-owned")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/evaluations/")
	if id == "" {
		writeAPIError(w, http.StatusNotFound, "not_found", "unknown evaluation")
		return
	}
	if r.Method == http.MethodGet && id == "stats" {
		count, bytes, err := s.store.cacheStats()
		if err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"count": count, "bytes": bytes, "max_rows": evalCacheMaxRows})
		return
	}
	if !evalHashPattern.MatchString(id) {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "evaluation key must be hex")
		return
	}
	entry, err := s.store.cacheGet(id)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "not_found", "unknown evaluation")
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

// Bulk coverage probe: one round trip answering "which of these cache rows
// exist" for line restores, replacing hundreds of per-position GETs. Values
// ride along so restores seed memory without a second fan-out. Read-only:
// missing rows stay missing for an explicit, user-gated batch.
//
// Legacy compatibility surface: the current frontend restores through
// POST /evaluations/lookup. Coverage reads both the legacy table and the
// v2 table so older cached lines still restore; it never starts inference.
func (s *GameStore) cacheCoverage(hashes []string) (map[string]cachedEvaluation, error) {
	rows := map[string]cachedEvaluation{}
	for start := 0; start < len(hashes); start += 500 {
		end := start + 500
		if end > len(hashes) {
			end = len(hashes)
		}
		chunk := hashes[start:end]
		placeholders := strings.Repeat("?,", len(chunk)-1) + "?"
		args := make([]any, len(chunk))
		for i, hash := range chunk {
			args[i] = hash
		}
		for _, table := range []string{"evaluations", "evaluations_v2"} {
			queryRows, err := s.db.Query(`SELECT key_hash, engine, cache_key, value, created_at
			FROM `+table+` WHERE key_hash IN (`+placeholders+`)`, args...)
			if err != nil {
				if strings.Contains(err.Error(), "no such table: "+table) {
					continue
				}
				return nil, err
			}
		for queryRows.Next() {
			var entry cachedEvaluation
			var value string
			if err := queryRows.Scan(&entry.KeyHash, &entry.Engine, &entry.Key, &value, &entry.CreatedAt); err != nil {
				queryRows.Close()
				return nil, err
			}
			var decoded any
			if err := json.Unmarshal([]byte(value), &decoded); err != nil {
				// One corrupt row degrades to a miss for its hash, never to a
				// failed bulk: the per-position probe path treats unreadable
				// rows the same way, and the client still validates values.
				continue
			}
			entry.Value = decoded
			rows[entry.KeyHash] = entry
		}
		if err := queryRows.Err(); err != nil {
			queryRows.Close()
			return nil, err
		}
		queryRows.Close()
		}
	}
	return rows, nil
}

func (s *server) coverage(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	if r.Method != http.MethodGet {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET is required")
		return
	}
	hashes := r.URL.Query()["hash"]
	if len(hashes) > coverageMaxHashes {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "at most 1024 hashes per lookup")
		return
	}
	for _, hash := range hashes {
		if !evalHashPattern.MatchString(hash) {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "evaluation key must be hex")
			return
		}
	}
	rows, err := s.store.cacheCoverage(hashes)
	if err != nil {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"rows": rows})
}
