package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Server-owned v2 identities live in evaluations_v2, the only cache table.
var (
	evalCacheMaxRows       = 25000
	evalCacheMaxKeyBytes   = 4096
	evalCacheMaxValueBytes = 65536
	evalHashPattern        = regexp.MustCompile(`^([0-9a-f]{1,16}|[0-9a-f]{64})$`)
)

type cachedEvaluation struct {
	KeyHash   string          `json:"key_hash"`
	Engine    string          `json:"engine"`
	Key       string          `json:"key"`
	Value     json.RawMessage `json:"value"`
	CreatedAt string          `json:"created_at"`
}

// validCacheValueBytes is the generic cache-shape gate on raw bytes (engine,
// key bounds, size, JSON validity). Strict shape + ownership stay in
// validOwnedCacheValue; the strict decode there already requires a non-empty
// JSON object with the engine's required fields.
func validCacheValueBytes(engine, key string, encoded []byte) *requestError {
	if engine != "sf" && engine != "maia" {
		return &requestError{"invalid_request", "engine must be sf or maia"}
	}
	if key == "" || len(key) > evalCacheMaxKeyBytes {
		return &requestError{"invalid_request", "key must be non-empty and short"}
	}
	if len(encoded) == 0 || len(encoded) > evalCacheMaxValueBytes || !json.Valid(encoded) {
		return &requestError{"invalid_request", "value must be a JSON document"}
	}
	return nil
}

func (s *GameStore) cacheStats() (count, bytes int, err error) {
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

func (s *GameStore) cachePut(hash, engine, key, value string) (cachedEvaluation, error) {
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
		if count > evalCacheMaxRows {
			if err := evictOldestRows(tx, "evaluations_v2", count-evalCacheMaxRows); err != nil {
				return struct{}{}, err
			}
			log.Printf("evaluation cache eviction rows=%d", count-evalCacheMaxRows)
		}
		return struct{}{}, nil
	})
	if err != nil {
		return cachedEvaluation{}, err
	}
	return cachedEvaluation{KeyHash: hash, Engine: engine, Key: key, CreatedAt: now}, nil
}

func (s *GameStore) cacheGet(hash string) (cachedEvaluation, error) {
	var entry cachedEvaluation
	var value string
	err := s.db.QueryRow(`SELECT key_hash, engine, cache_key, value, created_at
		FROM evaluations_v2 WHERE key_hash = ? AND LENGTH(value) <= ? AND LENGTH(cache_key) <= ?`, hash, evalCacheMaxValueBytes, evalCacheMaxKeyBytes).Scan(
		&entry.KeyHash, &entry.Engine, &entry.Key, &value, &entry.CreatedAt)
	if err != nil {
		return cachedEvaluation{}, err
	}
	// Thread raw bytes: no decode/re-marshal here. Strict readers validate
	// the bytes once via decodeStrictValue; the GET handler serves them
	// verbatim. Corrupt rows still error instead of serving garbage.
	if !json.Valid([]byte(value)) {
		return cachedEvaluation{}, errors.New("evaluation cache decode failed")
	}
	entry.Value = json.RawMessage(value)
	return entry, nil
}

// cacheGetMany fetches up to len(hashes) rows in bulk order-independent:
// one SELECT per 500-hash chunk with the same size guards as cacheGet.
// Corrupt rows are skipped (misses), never served. A query failure aborts
// the whole fetch with an error so callers can treat it as all-miss, the
// same outcome as N failing point reads.
func (s *GameStore) cacheGetMany(hashes []string) (map[string]cachedEvaluation, error) {
	out := make(map[string]cachedEvaluation, len(hashes))
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
			append(queryArgs(chunk), evalCacheMaxValueBytes, evalCacheMaxKeyBytes)...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var entry cachedEvaluation
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

// The full canonical key is compared as well as its digest.
func validCacheRef(hash, key string) bool {
	return evalHashPattern.MatchString(hash) && key != "" && len(key) <= evalCacheMaxKeyBytes
}

func (s *server) lookupCache(hash, engine, key string) (cachedEvaluation, bool) {
	if s.store == nil || !validCacheRef(hash, key) {
		return cachedEvaluation{}, false
	}
	entry, err := s.store.cacheGet(hash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
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
	// Single strict entry on raw bytes: generic shape gate first, then the
	// ownership + typed + semantic gate. No intermediate any document and no
	// re-marshal.
	if validCacheValueBytes(engine, key, encoded) != nil {
		log.Printf("evaluation cache rejected engine=%s", engine)
		return
	}
	if !validOwnedCacheValue(hash, engine, key, encoded) {
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

// Eval-content log lines: one per served evaluation — fresh inference or
// cache hit — so any number on screen traces to a server-log line. WDL
// triples print loss/draw/win (mover-relative, three decimals); exp is
// win+draw/2 in percent, the same math the UI renders.
func wdlTriple(w [3]float64) string {
	return fmt.Sprintf("%.3f/%.3f/%.3f", w[0], w[1], w[2])
}

func wdlExpected(w [3]float64) float64 {
	return (w[2] + w[1]/2) * 100
}

func eloOrQ(elo *int) string {
	if elo == nil {
		return "?"
	}
	return fmt.Sprintf("%d", *elo)
}

func eloPair(a, b *int) string {
	return eloOrQ(a) + "/" + eloOrQ(b)
}

func valueEloPair(a, b *int) string {
	if a == nil && b == nil {
		return "-"
	}
	return eloPair(a, b)
}

func orDash(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func maiaContentFields(resp moveResponse) string {
	tops := make([]string, 0, len(resp.TopMoves))
	for _, t := range resp.TopMoves {
		tops = append(tops, fmt.Sprintf("%s:%.1f%%:%s", t.Move, t.Prob*100, wdlTriple(t.WDL)))
	}
	delta := "-"
	if resp.DeltaBaseline != nil {
		delta = fmt.Sprintf("%.1f:%s", resp.DeltaBaseline.Value, resp.DeltaBaseline.Kind)
	}
	return fmt.Sprintf("move=%s wdl=%s exp=%.1f used=%s degraded=%t top=%s baseline=%s",
		resp.Move, wdlTriple(resp.WDL), wdlExpected(resp.WDL), resp.ModelUsed, resp.Degraded, strings.Join(tops, ","), delta)
}

func sfScoreText(score evaluationScore) string {
	if score.Type == "mate" {
		return fmt.Sprintf("mate:%d:%s", score.Value, score.WinningSide)
	}
	return fmt.Sprintf("cp:%d", score.Value)
}

func sfContentFields(resp *evaluationResponse) string {
	terminal := "-"
	if resp.Terminal != nil {
		terminal = *resp.Terminal
	}
	best := "-"
	if resp.BestMove != nil {
		best = *resp.BestMove
	}
	lines := make([]string, 0, len(resp.Lines))
	for _, line := range resp.Lines {
		lines = append(lines, line.Move+":"+sfScoreText(line.Score))
	}
	return fmt.Sprintf("score=%s best=%s depth=%d terminal=%s policy=%s lines=%s",
		sfScoreText(resp.Score), best, resp.Depth, terminal, resp.SearchPolicy, strings.Join(lines, ","))
}
