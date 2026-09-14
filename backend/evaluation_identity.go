package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
)

const maiaRevision = "1e13597c42d4858b7cfd7cfdae01e297263364b2"
const standardInitialFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

// Identity includes both the claimed board and the complete reconstruction.
// Only an inference worker establishes their semantic consistency. Cache-only
// lookup validates their shape; an inconsistent combination has its own key.
type evaluationIdentity struct {
	Version    int                `json:"version"`
	Engine     string             `json:"engine"`
	Revision   string             `json:"revision"`
	FEN        string             `json:"fen"`
	InitialFEN string             `json:"initial_fen"`
	Moves      []string           `json:"moves"`
	Settings   *stockfishSettings `json:"settings,omitempty"`
	Policy     string             `json:"policy,omitempty"`
	SelfElo    int                `json:"self_elo,omitempty"`
	OppoElo    int                `json:"oppo_elo,omitempty"`
	Model      string             `json:"model,omitempty"`
}

func baseIdentity(engine, fen, initial string, moves []string) evaluationIdentity {
	if initial == "" {
		initial = standardInitialFEN
		if len(moves) == 0 {
			initial = fen
		}
	}
	return evaluationIdentity{Version: 2, Engine: engine, FEN: fen, InitialFEN: initial, Moves: append([]string{}, moves...)}
}

func sfIdentity(r evaluationRequest) evaluationIdentity {
	i := baseIdentity("sf", r.FEN, r.InitialFEN, r.Moves)
	i.Revision, i.Settings, i.Policy = "Stockfish-19", r.Settings, r.Settings.policy()
	return i
}

func maiaIdentity(r EngineRequest, model string) evaluationIdentity {
	i := baseIdentity("maia", r.FEN, r.InitialFEN, r.Moves)
	i.Revision, i.SelfElo, i.OppoElo, i.Model = maiaRevision, r.SelfElo, r.OppoElo, model
	return i
}

func (i evaluationIdentity) coordinates() (string, string) {
	data, err := json.Marshal(i)
	if err != nil {
		panic(err)
	} // This type contains only JSON-safe validated fields.
	key := "v2:" + string(data)
	hash := sha256.Sum256([]byte(key))
	return hex.EncodeToString(hash[:]), key
}

var (
	docAllowNull = map[string]bool{"terminal": true, "best_move": true, "actual_settings": true, "winning_side": true}
	evalRequired = []string{"engine", "search_policy", "depth", "score", "lines", "terminal", "best_move"}
	moveRequired = []string{"move", "top_moves", "wdl", "model_used", "degraded"}
	engineResultRequired = []string{"move", "candidates", "wdl"}
)

// noBadNulls rejects JSON nulls except for explicitly optional keys (terminal,
// best_move, actual_settings, winning_side). Go decodes null into zero values
// without error, so without this a missing degraded flag or a null prob would
// silently become false/0 and could still pass semantic validation.
func noBadNulls(value any, allow map[string]bool) bool {
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
			if item == nil && !allow[key] {
				return false
			}
			if !noBadNulls(item, allow) {
				return false
			}
		}
		return true
	case []any:
		for _, item := range v {
			if !noBadNulls(item, allow) {
				return false
			}
		}
		return true
	default:
		return true
	}
}

// validWDLLens enforces exactly three numeric entries for every wdl array.
// encoding/json silently pads ([0,1] -> [0,1,0]) or truncates ([0,0,1,0] ->
// [0,0,1]) when decoding into [3]float64, so length must be checked on the
// raw document before typed decoding.
func validWDLLens(value any) bool {
	switch v := value.(type) {
	case map[string]any:
		for key, item := range v {
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
			if !validWDLLens(item) {
				return false
			}
		}
		return true
	case []any:
		for _, item := range v {
			if !validWDLLens(item) {
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
	return noBadNulls(value, allowNull) && validWDLLens(value)
}

// decodeStrict is the one generic strict decoder shared by UnmarshalJSON
// implementations (via plain aliases to avoid recursion) and document
// validation (via decodeStrictValue). It enforces required presence, null
// rejection, wdl lengths, DisallowUnknownFields, and trailing-data rejection.
func decodeStrict[T any](data []byte, required []string, allowNull map[string]bool) (T, error) {
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

// decodeStrictValue is the single strict typed decode path for cached/worker
// documents: required presence, null rejection, wdl lengths, size bound,
// DisallowUnknownFields, and trailing-data rejection. Semantic ranges stay in
// valid*.
func decodeStrictValue[T any](value any, required []string, allowNull map[string]bool) (T, bool) {
	var zero T
	if !checkShapeAny(value, required, allowNull) {
		return zero, false
	}
	data, err := json.Marshal(value)
	if err != nil || len(data) > evalCacheMaxValueBytes {
		return zero, false
	}
	decoded, err := decodeStrict[T](data, required, allowNull)
	if err != nil {
		return zero, false
	}
	return decoded, true
}

func strictDocument(value any, target any, required ...string) bool {
	if !checkShapeAny(value, required, docAllowNull) {
		return false
	}
	data, err := json.Marshal(value)
	if err != nil || len(data) > evalCacheMaxValueBytes {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(target) != nil {
		return false
	}
	var trailing any
	return d.Decode(&trailing) == io.EOF
}

func probability(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 1 }
func validWDL(w [3]float64) bool {
	return probability(w[0]) && probability(w[1]) && probability(w[2]) && math.Abs(w[0]+w[1]+w[2]-1) <= 1e-6
}

func validMoveValue(v moveResponse, model string, deterministic bool) bool {
	if !uciMovePattern.MatchString(v.Move) || !validWDL(v.WDL) || (v.ModelUsed != "79m" && v.ModelUsed != "5m") || len(v.TopMoves) < 1 || len(v.TopMoves) > 5 {
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
		if !uciMovePattern.MatchString(m.Move) || seen[m.Move] || !probability(m.Prob) || m.Prob > previous+1e-7 {
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

func validScore(s evaluationScore) bool {
	switch s.Type {
	case "cp":
		return s.Value >= -100000 && s.Value <= 100000 && s.WinningSide == ""
	case "mate":
		return s.Value >= -1000 && s.Value <= 1000 && ((s.WinningSide == "white" && s.Value >= 0) || (s.WinningSide == "black" && s.Value <= 0))
	}
	return false
}

func validEvaluationValue(v evaluationResponse, settings *stockfishSettings) bool {
	limit := 2
	if settings != nil {
		limit = settings.Lines
	}
	if v.Engine != "Stockfish 19" || v.SearchPolicy != settings.policy() || v.Depth < 0 || v.Depth > 256 || !validScore(v.Score) || v.Lines == nil || len(v.Lines) > limit {
		return false
	}
	if v.ActualSettings != nil && (settings == nil || *v.ActualSettings != *settings) {
		return false
	}
	if v.Terminal != nil {
		if len(v.Lines) != 0 || v.BestMove != nil || v.Depth != 0 {
			return false
		}
		return (*v.Terminal == "draw" && v.Score.Type == "cp" && v.Score.Value == 0) || (*v.Terminal == v.Score.WinningSide+"_win" && v.Score.Type == "mate" && v.Score.Value == 0)
	}
	if len(v.Lines) == 0 || v.Depth < 1 || v.BestMove == nil || *v.BestMove != v.Lines[0].Move || v.Score != v.Lines[0].Score {
		return false
	}
	seen := map[string]bool{}
	for _, line := range v.Lines {
		if !uciMovePattern.MatchString(line.Move) || seen[line.Move] || line.Depth != v.Depth || (settings != nil && settings.Depth > 0 && line.Depth > settings.Depth) || !validScore(line.Score) {
			return false
		}
		seen[line.Move] = true
	}
	return true
}

func (s *server) cachedSF(r evaluationRequest) (*evaluationResponse, bool) {
	// Native exact identity always wins. The legacy node-budget policy has no
	// compatible v2 timed-policy equivalent, even at 750ms / two candidates.
	for lines := 0; lines <= 5; lines++ {
		candidate := r
		if lines != 0 {
			if r.Settings == nil || lines <= r.Settings.Lines {
				continue
			}
			settings := *r.Settings
			settings.Lines = lines
			candidate.Settings = &settings
		}
		hash, key := sfIdentity(candidate).coordinates()
		entry, ok := s.lookupCache(hash, "sf", key)
		if !ok {
			continue
		}
		value, ok := decodeStrictValue[evaluationResponse](entry.Value, evalRequired, docAllowNull)
		if !ok || !validEvaluationValue(value, candidate.Settings) {
			continue
		}
		value.ActualSettings = candidate.Settings
		if r.Settings != nil && len(value.Lines) > r.Settings.Lines {
			value.Lines = value.Lines[:r.Settings.Lines]
		}
		return &value, true
	}
	return nil, false
}

func (s *server) cachedMaia(r EngineRequest, model string) (*moveResponse, bool) {
	hash, key := maiaIdentity(r, model).coordinates()
	entry, ok := s.lookupCache(hash, "maia", key)
	if !ok {
		return nil, false
	}
	value, ok := decodeStrictValue[moveResponse](entry.Value, moveRequired, nil)
	if !ok || !validMoveValue(value, model, true) || value.Degraded {
		return nil, false
	}
	return &value, true
}

type lookupRequest struct {
	Engine     string             `json:"engine"`
	FEN        string             `json:"fen"`
	InitialFEN string             `json:"initial_fen"`
	Moves      []string           `json:"moves"`
	Settings   *stockfishSettings `json:"settings,omitempty"`
	EloMaia    *int               `json:"elo_maia,omitempty"`
	EloUser    *int               `json:"elo_user,omitempty"`
	Model      string             `json:"model,omitempty"`
}
type lookupResult struct {
	Index          int                `json:"index"`
	Value          any                `json:"value"`
	ActualSettings *stockfishSettings `json:"actual_settings,omitempty"`
}

func (s *server) evaluationLookup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, 405, "method_not_allowed", "POST is required")
		return
	}
	var body struct {
		Requests []lookupRequest `json:"requests"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024*1024))
	d.DisallowUnknownFields()
	if err := d.Decode(&body); err != nil {
		writeAPIError(w, 400, "invalid_json", "request body must be a valid lookup object")
		return
	}
	var trailing any
	if d.Decode(&trailing) != io.EOF || body.Requests == nil || len(body.Requests) > 1024 {
		writeAPIError(w, 400, "invalid_request", "requests must be an array of at most 1024 entries")
		return
	}
	results := []lookupResult{}
	for index, query := range body.Requests {
		var invalid error
		if query.Moves == nil {
			invalid = fmt.Errorf("moves must be an array")
		}
		switch query.Engine {
		case "sf":
			request := evaluationRequest{FEN: query.FEN, InitialFEN: query.InitialFEN, Moves: query.Moves, Settings: query.Settings}
			if err := validateEvaluationRequest(&request); err != nil {
				invalid = err
			}
			if query.EloMaia != nil || query.EloUser != nil || query.Model != "" {
				invalid = fmt.Errorf("Stockfish request contains Maia settings")
			}
			if invalid == nil {
				if value, ok := s.cachedSF(request); ok {
					results = append(results, lookupResult{index, value, value.ActualSettings})
				}
			}
		case "maia":
			_, side, _ := normalizeFEN(query.FEN)
			color := "white"
			if side == "b" {
				color = "black"
			}
			request, model, err := validateMoveRequest(moveRequest{FEN: query.FEN, InitialFEN: query.InitialFEN, Moves: query.Moves, EloMaia: query.EloMaia, EloUser: query.EloUser, Model: query.Model, MaiaColor: color})
			if err != nil {
				invalid = err
			}
			if query.Settings != nil {
				invalid = fmt.Errorf("Maia request contains Stockfish settings")
			}
			if invalid == nil {
				if value, ok := s.cachedMaia(request, model); ok {
					results = append(results, lookupResult{Index: index, Value: value})
				}
			}
		default:
			invalid = fmt.Errorf("engine must be sf or maia")
		}
		if invalid != nil {
			writeAPIError(w, 400, "invalid_request", fmt.Sprintf("requests[%d]: %s", index, invalid))
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}
