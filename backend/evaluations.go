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
	evalCacheMaxRows       = 5000
	evalCacheMaxKeyBytes   = 4096
	evalCacheMaxValueBytes = 65536
	evalHashPattern        = regexp.MustCompile(`^[0-9a-f]{1,16}$`)
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
	if _, err := tx.Exec(`INSERT INTO evaluations (key_hash, engine, cache_key, value, created_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (key_hash) DO UPDATE SET engine = excluded.engine, cache_key = excluded.cache_key,
			value = excluded.value, created_at = excluded.created_at`,
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
