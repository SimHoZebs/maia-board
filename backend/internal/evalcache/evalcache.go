// Package evalcache owns the pure core of the disposable evaluation cache:
// server-owned v2 identities, the single strict-decode entry, and the
// byte-level shape gates. It performs no I/O: the store package owns rows,
// the engine package derives per-engine identities, and the server package
// orchestrates reads and write-through.
package evalcache

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"

	"maia-board/backend/internal/apierror"
)

// Cache bounds: the table evicts oldest-first beyond MaxRows; keys and
// values beyond their byte bounds are never filed nor served.
const (
	MaxKeyBytes   = 4096
	MaxValueBytes = 65536
)

// MaxRows bounds the disposable table. A var (not const) so tests shrink it
// without touching the production bound.
var MaxRows = 25000

var hashPattern = regexp.MustCompile(`^([0-9a-f]{1,16}|[0-9a-f]{64})$`)

// standardInitialFEN roots history reconstruction when callers omit it.
const standardInitialFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

// Identity includes both the claimed board and the complete reconstruction.
// Inconsistent triples are rejected at validation and never filed: empty
// histories must root at fen, and non-empty histories are replayed by the
// worker (position_mismatch) whose failure never writes a row.
//
// Settings stays raw bytes (not a typed struct) so this package never
// imports the engine types: the marshaled form is byte-identical to the
// typed struct, keeping coordinates stable across the split.
type Identity struct {
	Version      int             `json:"version"`
	Engine       string          `json:"engine"`
	Revision     string          `json:"revision"`
	FEN          string          `json:"fen"`
	InitialFEN   string          `json:"initial_fen"`
	Moves        []string        `json:"moves"`
	Settings     json.RawMessage `json:"settings,omitempty"`
	Policy       string          `json:"policy,omitempty"`
	SelfElo      int             `json:"self_elo,omitempty"`
	OppoElo      int             `json:"oppo_elo,omitempty"`
	ValueSelfElo *int            `json:"value_self_elo,omitempty"`
	ValueOppoElo *int            `json:"value_oppo_elo,omitempty"`
	Model        string          `json:"model,omitempty"`
	// ValueRev versions the Maia value shape (per-candidate WDL arrived in
	// v1; split policy/value Elos arrive in v2). Old Maia rows miss by key
	// instead of failing validation on read; Stockfish rows never set it,
	// so their keys — and cache — are untouched.
	ValueRev int `json:"value_rev,omitempty"`
}

// BaseIdentity defaults an empty initial position to the standard start
// (or to fen itself for empty histories) and stamps version 2.
func BaseIdentity(engine, fen, initial string, moves []string) Identity {
	if initial == "" {
		initial = standardInitialFEN
		if len(moves) == 0 {
			initial = fen
		}
	}
	return Identity{Version: 2, Engine: engine, FEN: fen, InitialFEN: initial, Moves: append([]string{}, moves...)}
}

// Coordinates derives the (hash, key) pair filed in evaluations_v2.
func (i Identity) Coordinates() (string, string) {
	data, err := json.Marshal(i)
	if err != nil {
		panic(err)
	} // This type contains only JSON-safe validated fields.
	key := "v2:" + string(data)
	hash := sha256.Sum256([]byte(key))
	return hex.EncodeToString(hash[:]), key
}

// walkShape is the single recursive poisoning-defense pass. It rejects JSON
// nulls except for explicitly optional keys — Go decodes null into zero
// values without error, so without this a missing degraded flag or a null
// prob would silently become false/0 — and enforces exactly three numeric
// entries for every wdl array (encoding/json silently pads or truncates when
// decoding into [3]float64, so length must be checked on the raw document
// before typed decoding).
func walkShape(value any, allow map[string]bool) bool {
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
			if item == nil && !allow[key] {
				return false
			}
			if key == "wdl" {
				items, ok := item.([]any)
				if !ok || len(items) != 3 {
					return false
				}
				for _, entry := range items {
					if _, ok := entry.(float64); !ok {
						return false
					}
				}
			}
			if !walkShape(item, allow) {
				return false
			}
		}
		return true
	case []any:
		for _, item := range v {
			if !walkShape(item, allow) {
				return false
			}
		}
		return true
	default:
		return true
	}
}

func checkShapeAny(value any, required []string, allowNull map[string]bool) bool {
	m, ok := value.(map[string]any)
	if !ok {
		return false
	}
	for _, key := range required {
		item, ok := m[key]
		if !ok {
			return false
		}
		if item == nil && !allowNull[key] {
			return false
		}
	}
	if allowNull == nil {
		allowNull = map[string]bool{}
	}
	return walkShape(value, allowNull)
}

// DecodeStrict is the one generic strict decoder shared by UnmarshalJSON
// implementations (via plain aliases to avoid recursion) and document
// validation (via DecodeStrictValue). It enforces required presence, null
// rejection, wdl lengths, DisallowUnknownFields, and trailing-data rejection.
func DecodeStrict[T any](data []byte, required []string, allowNull map[string]bool) (T, error) {
	var zero T
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return zero, err
	}
	if !checkShapeAny(value, required, allowNull) {
		return zero, fmt.Errorf("invalid shape")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	var decoded T
	if err := d.Decode(&decoded); err != nil {
		return zero, err
	}
	var trailing any
	if err := d.Decode(&trailing); err != io.EOF {
		return zero, fmt.Errorf("trailing data")
	}
	return decoded, nil
}

// DecodeStrictValue is the single strict typed decode entry for cached and
// worker documents: raw bytes → one shape walk → one typed strict decode.
// Required presence, null rejection, wdl lengths, size bound,
// DisallowUnknownFields, and trailing-data rejection live here; semantic
// ranges stay in the valid* validators. Callers thread []byte (cache rows,
// worker replies) so nothing re-marshals just to re-parse.
func DecodeStrictValue[T any](data []byte, required []string, allowNull map[string]bool) (T, bool) {
	var zero T
	if len(data) > MaxValueBytes {
		return zero, false
	}
	decoded, err := DecodeStrict[T](data, required, allowNull)
	if err != nil {
		return zero, false
	}
	return decoded, true
}

func probability(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 1 }

// ValidWDL accepts normalized loss/draw/win triples.
func ValidWDL(w [3]float64) bool {
	return probability(w[0]) && probability(w[1]) && probability(w[2]) && math.Abs(w[0]+w[1]+w[2]-1) <= 1e-6
}

// ValidCacheValueBytes is the generic cache-shape gate on raw bytes (engine,
// key bounds, size, JSON validity). Strict shape + ownership stay with the
// caller; the strict decode there already requires a non-empty JSON object
// with the engine's required fields.
func ValidCacheValueBytes(engine, key string, encoded []byte) *apierror.RequestError {
	if engine != "sf" && engine != "maia" {
		return &apierror.RequestError{Code: "invalid_request", Message: "engine must be sf or maia"}
	}
	if key == "" || len(key) > MaxKeyBytes {
		return &apierror.RequestError{Code: "invalid_request", Message: "key must be non-empty and short"}
	}
	if len(encoded) == 0 || len(encoded) > MaxValueBytes || !json.Valid(encoded) {
		return &apierror.RequestError{Code: "invalid_request", Message: "value must be a JSON document"}
	}
	return nil
}

// ValidCacheRef compares the full canonical key as well as its digest.
func ValidCacheRef(hash, key string) bool {
	return hashPattern.MatchString(hash) && key != "" && len(key) <= MaxKeyBytes
}

// ValidHash accepts bare cache digests (short or full hex) for GET reads.
func ValidHash(hash string) bool { return hashPattern.MatchString(hash) }
