package engine

import (
	"encoding/json"
	"math"
	"strings"

	"maia-board/backend/internal/chess"
	"maia-board/backend/internal/evalcache"
)

// Required document fields for the single strict-decode path.
var (
	DocAllowNull         = map[string]bool{"terminal": true, "best_move": true, "actual_settings": true, "winning_side": true}
	EvalRequired         = []string{"engine", "search_policy", "depth", "score", "lines", "terminal", "best_move"}
	MoveRequired         = []string{"move", "top_moves", "wdl", "model_used", "degraded"}
	EngineResultRequired = []string{"move", "candidates", "wdl"}
)

// TopMove is one ranked Maia candidate with its policy probability and
// mover-relative win/draw/loss. Delta is the candidate's expected winrate
// minus the served baseline, attached at read time (never stored). Absent on
// rows served before the baseline existed or when no baseline applied.
type TopMove struct {
	Move  string     `json:"move"`
	Prob  float64    `json:"prob"`
	WDL   [3]float64 `json:"wdl"`
	Delta *float64   `json:"delta,omitempty"`
}

// MoveResponse is a Maia inference result: the selected move, ranked
// candidates, normalized [loss, draw, win] for the first candidate, and the
// model actually used (79M-to-5M fallback reports degraded).
type MoveResponse struct {
	Move      string     `json:"move"`
	TopMoves  []TopMove  `json:"top_moves"`
	WDL       [3]float64 `json:"wdl"`
	ModelUsed string     `json:"model_used"`
	Degraded  bool       `json:"degraded"`
	// DeltaBaseline is the before-position 2400 point the deltas above
	// were computed against, attached at read time (never stored).
	DeltaBaseline *DeltaBaseline `json:"delta_baseline,omitempty"`
	// WaitMs is admission queue wait in ms. Internal only (never
	// serialized to clients or the cache); -1 means admission was
	// never reached (cache hit or pre-admission error).
	WaitMs int64 `json:"-"`
}

// DeltaBaseline names the baseline a served Maia row's deltas compare
// against. Only "before" is emitted today: the before-position 2400 point.
// "best" stays in the contract for the list-max fallback the client applies
// when no baseline is attached.
type DeltaBaseline struct {
	Value float64 `json:"value"`
	Kind  string  `json:"kind"`
}

// ValidMoveValue checks a Maia document's semantic ranges.
func ValidMoveValue(v MoveResponse, model string, deterministic bool) bool {
	if !chess.UCIMovePattern.MatchString(v.Move) || !evalcache.ValidWDL(v.WDL) || (v.ModelUsed != "79m" && v.ModelUsed != "5m") || len(v.TopMoves) < 1 || len(v.TopMoves) > 5 {
		return false
	}
	if v.ModelUsed != model && !(model == "79m" && v.ModelUsed == "5m" && v.Degraded) {
		return false
	}
	if v.Degraded != (v.ModelUsed != model) {
		return false
	}
	seen, sum, previous := map[string]bool{}, 0.0, 1.0
	for _, m := range v.TopMoves {
		if !chess.UCIMovePattern.MatchString(m.Move) || seen[m.Move] || math.IsNaN(m.Prob) || math.IsInf(m.Prob, 0) || m.Prob < 0 || m.Prob > 1 || m.Prob > previous+1e-7 || !evalcache.ValidWDL(m.WDL) {
			return false
		}
		seen[m.Move], previous, sum = true, m.Prob, sum+m.Prob
	}
	if sum <= 0 || sum > 1.000001 {
		return false
	}
	if !deterministic {
		return true
	}
	// Upstream argmax and topk may order equal logits differently. Preserve its
	// selected move when the highest policies tie, including ties across rank 5.
	for _, candidate := range v.TopMoves {
		if candidate.Move == v.Move {
			return math.Abs(candidate.Prob-v.TopMoves[0].Prob) <= 1e-7
		}
	}
	return len(v.TopMoves) == maxMultiPV && math.Abs(v.TopMoves[maxMultiPV-1].Prob-v.TopMoves[0].Prob) <= 1e-7
}

// ValidOwnedCacheValue is the write-path ownership gate on raw bytes: the key
// must carry a v2 identity matching this engine/hash, and the value must
// strictly decode to that identity's document shape with valid semantics.
// Inconsistent triples are never filed: empty histories must root at fen.
func ValidOwnedCacheValue(hash, engine, key string, encoded []byte) bool {
	if !strings.HasPrefix(key, "v2:") {
		return false
	}
	var identity evalcache.Identity
	if json.Unmarshal([]byte(strings.TrimPrefix(key, "v2:")), &identity) != nil || identity.Engine != engine || identity.Version != 2 {
		return false
	}
	if len(identity.Moves) == 0 && identity.InitialFEN != identity.FEN {
		return false
	}
	wantHash, wantKey := identity.Coordinates()
	if hash != wantHash || key != wantKey {
		return false
	}
	switch engine {
	case "sf":
		// Nil settings decode to the legacy timed policy, mirroring the nil
		// (*StockfishSettings).Policy/Validate receiver behavior.
		var settings *StockfishSettings
		if len(identity.Settings) > 0 {
			decoded, err := evalcache.DecodeStrict[StockfishSettings](identity.Settings, []string{"time_ms", "lines", "depth"}, nil)
			if err != nil {
				return false
			}
			settings = &decoded
		}
		policy := SearchPolicy
		if settings != nil {
			policy = settings.Policy()
		}
		response, ok := evalcache.DecodeStrictValue[EvaluationResponse](encoded, EvalRequired, DocAllowNull)
		return ok && identity.Revision == "Stockfish-19" && identity.Policy == policy &&
			(settings == nil || settings.Validate() == nil) && ValidEvaluationValue(response, settings)
	case "maia":
		response, ok := evalcache.DecodeStrictValue[MoveResponse](encoded, MoveRequired, nil)
		return ok && identity.Revision == maiaRevision && !response.Degraded && ValidMoveValue(response, identity.Model, true)
	}
	return false
}
