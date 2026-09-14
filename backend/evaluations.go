package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Evaluation cache: opaque key-value rows for analysis results. The frontend
// owns the key format (position, history, ratings, model, search policy), so
// policy or model changes naturally miss instead of poisoning results. Access
// is exact-key lookup only, which is why this lives in SQLite next to games
// rather than in a separate document store.
var (
	evalCacheMaxRows       = 25000
	evalCacheMaxKeyBytes   = 4096
	evalCacheMaxValueBytes = 65536
	evalHashPattern        = regexp.MustCompile(`^[0-9a-f]{1,16}$`)
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
	err = s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(LENGTH(value)), 0) FROM evaluations`).Scan(&count, &bytes)
	return count, bytes, err
}

func (s *GameStore) cachePut(hash, engine, key, value string) (cachedEvaluation, error) {
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
	if _, err := tx.Exec(`DELETE FROM evaluations WHERE key_hash = ?`, hash); err != nil {
		return cachedEvaluation{}, err
	}
	if _, err := tx.Exec(`INSERT INTO evaluations (key_hash, engine, cache_key, value, created_at)
		VALUES (?, ?, ?, ?, ?)`,
		hash, engine, key, value, now); err != nil {
		return cachedEvaluation{}, err
	}
	if _, err := tx.Exec(`DELETE FROM evaluations WHERE key_hash NOT IN (
		SELECT key_hash FROM evaluations ORDER BY rowid DESC LIMIT ?)`, evalCacheMaxRows); err != nil {
		return cachedEvaluation{}, err
	}
	if err := tx.Commit(); err != nil {
		return cachedEvaluation{}, err
	}
	return cachedEvaluation{KeyHash: hash, Engine: engine, Key: key, CreatedAt: now}, nil
}

func (s *GameStore) cacheGet(hash string) (cachedEvaluation, error) {
	var entry cachedEvaluation
	var value string
	err := s.db.QueryRow(`SELECT key_hash, engine, cache_key, value, created_at
		FROM evaluations WHERE key_hash = ?`, hash).Scan(
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

// Read-through helpers for POST /evaluate and POST /move. The cache key
// format stays client-owned and opaque: the server never interprets chess
// positions, it only files values under the hash the client computed. A hit
// additionally requires the stored key to equal the presented key, so a
// colliding or mismatched hash falls through to live inference and
// overwrites the row instead of serving another position's result.
func validCacheRef(hash, key string) bool {
	return evalHashPattern.MatchString(hash) && key != "" && len(key) <= evalCacheMaxKeyBytes
}

func (s *server) lookupCache(hash, engine, key string) (cachedEvaluation, bool) {
	if s.store == nil || !validCacheRef(hash, key) {
		return cachedEvaluation{}, false
	}
	entry, err := s.store.cacheGet(hash)
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
		return
	}
	var document any
	if err := json.Unmarshal(encoded, &document); err != nil {
		return
	}
	if validCachePut(&cachePut{Engine: engine, Key: key, Value: document}) != nil {
		return
	}
	_, _ = s.store.cachePut(hash, engine, key, string(encoded))
}

func (s *server) evaluations(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodPut {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or PUT is required")
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
	if r.Method == http.MethodGet {
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
		return
	}
	var put cachePut
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, int64(evalCacheMaxValueBytes)+1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&put); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must be a valid JSON object")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must contain one JSON object")
		return
	}
	if err := validCachePut(&put); err != nil {
		writeAPIError(w, http.StatusBadRequest, err.Code, err.Message)
		return
	}
	encoded, _ := json.Marshal(put.Value)
	entry, err := s.store.cachePut(id, put.Engine, put.Key, string(encoded))
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
		queryRows, err := s.db.Query(`SELECT key_hash, engine, cache_key, value, created_at
			FROM evaluations WHERE key_hash IN (`+placeholders+`)`, args...)
		if err != nil {
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
