package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/evalcache"
	"maia-board/backend/internal/store"
)

func (s *Server) lookupCache(hash, eng, key string) (store.CachedEvaluation, bool) {
	if s.store == nil || !evalcache.ValidCacheRef(hash, key) {
		return store.CachedEvaluation{}, false
	}
	entry, err := s.store.CacheGet(hash)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		log.Printf("evaluation cache read failed engine=%s error=%v", eng, err)
	}
	if err != nil || entry.Engine != eng || entry.Key != key {
		return store.CachedEvaluation{}, false
	}
	return entry, true
}

// Best-effort write-through: store failures never fail the live request.
func (s *Server) storeCache(hash, eng, key string, value any) {
	if s.store == nil || !evalcache.ValidCacheRef(hash, key) {
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
	if evalcache.ValidCacheValueBytes(eng, key, encoded) != nil {
		log.Printf("evaluation cache rejected engine=%s", eng)
		return
	}
	if !engine.ValidOwnedCacheValue(hash, eng, key, encoded) {
		log.Printf("evaluation cache rejected untrusted output engine=%s", eng)
		return
	}
	started := time.Now()
	_, err = s.store.CachePut(hash, eng, key, string(encoded))
	log.Printf("evaluation cache write engine=%s bytes=%d duration_us=%d error=%v", eng, len(encoded), time.Since(started).Microseconds(), err)
}

func (s *Server) evaluations(w http.ResponseWriter, r *http.Request) {
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
		count, bytes, err := s.store.CacheStats()
		if err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"count": count, "bytes": bytes, "max_rows": evalcache.MaxRows})
		return
	}
	if !evalcache.ValidHash(id) {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "evaluation key must be hex")
		return
	}
	entry, err := s.store.CacheGet(id)
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

func maiaContentFields(resp engine.MoveResponse) string {
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

func sfScoreText(score engine.EvaluationScore) string {
	if score.Type == "mate" {
		return fmt.Sprintf("mate:%d:%s", score.Value, score.WinningSide)
	}
	return fmt.Sprintf("cp:%d", score.Value)
}

func sfContentFields(resp *engine.EvaluationResponse) string {
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
