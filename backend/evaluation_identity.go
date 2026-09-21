package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"time"
)

const maiaRevision = "1e13597c42d4858b7cfd7cfdae01e297263364b2"
const standardInitialFEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"

// Identity includes both the claimed board and the complete reconstruction.
// Inconsistent triples are rejected at validation and never filed: empty
// histories must root at fen, and non-empty histories are replayed by the
// worker (position_mismatch) whose failure never writes a row.
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
	ValueSelfElo *int             `json:"value_self_elo,omitempty"`
	ValueOppoElo *int             `json:"value_oppo_elo,omitempty"`
	Model      string             `json:"model,omitempty"`
	// ValueRev versions the Maia value shape (per-candidate WDL arrived in
	// v1; split policy/value Elos arrive in v2). Old Maia rows miss by key
	// instead of failing validation on read; Stockfish rows never set it,
	// so their keys — and cache — are untouched.
	ValueRev int `json:"value_rev,omitempty"`
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
	// Split rows (value Elos differing from policy Elos) get ValueRev 2 and
	// explicit value coordinates; equal-or-omitted values normalize to the
	// legacy ValueRev-1 key so 2400/2400 display rows dedup with the grading
	// lane and existing cache rows keep hitting.
	if (r.ValueSelfElo != nil && *r.ValueSelfElo != r.SelfElo) ||
		(r.ValueOppoElo != nil && *r.ValueOppoElo != r.OppoElo) {
		i.ValueSelfElo, i.ValueOppoElo, i.ValueRev = r.ValueSelfElo, r.ValueOppoElo, 2
		// Fill the unspecified half from policy so the key is complete even
		// when only one value Elo was supplied (worker defaults the same way).
		if i.ValueSelfElo == nil {
			v := r.SelfElo
			i.ValueSelfElo = &v
		}
		if i.ValueOppoElo == nil {
			v := r.OppoElo
			i.ValueOppoElo = &v
		}
	} else {
		i.ValueRev = 1
	}
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
	docAllowNull         = map[string]bool{"terminal": true, "best_move": true, "actual_settings": true, "winning_side": true}
	evalRequired         = []string{"engine", "search_policy", "depth", "score", "lines", "terminal", "best_move"}
	moveRequired         = []string{"move", "top_moves", "wdl", "model_used", "degraded"}
	engineResultRequired = []string{"move", "candidates", "wdl"}
)

// walkShape is the single recursive poisoning-defense pass, merging the
// former noBadNulls + validWDLLens walks. It rejects JSON nulls except for
// explicitly optional keys (terminal, best_move, actual_settings,
// winning_side) — Go decodes null into zero values without error, so without
// this a missing degraded flag or a null prob would silently become false/0
// and could still pass semantic validation — and enforces exactly three
// numeric entries for every wdl array (encoding/json silently pads
// ([0,1] -> [0,1,0]) or truncates ([0,0,1,0] -> [0,0,1]) when decoding into
// [3]float64, so length must be checked on the raw document before typed
// decoding).
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

// decodeStrictValue is the single strict typed decode entry for cached and
// worker documents: raw bytes → one shape walk → one typed strict decode.
// Required presence, null rejection, wdl lengths, size bound,
// DisallowUnknownFields, and trailing-data rejection live here; semantic
// ranges stay in valid*. Callers thread []byte (cache rows, worker replies)
// so nothing re-marshals just to re-parse.
func decodeStrictValue[T any](data []byte, required []string, allowNull map[string]bool) (T, bool) {
	var zero T
	if len(data) > evalCacheMaxValueBytes {
		return zero, false
	}
	decoded, err := decodeStrict[T](data, required, allowNull)
	if err != nil {
		return zero, false
	}
	return decoded, true
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
		if !uciMovePattern.MatchString(m.Move) || seen[m.Move] || !probability(m.Prob) || m.Prob > previous+1e-7 || !validWDL(m.WDL) {
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
	for index, line := range v.Lines {
		if !uciMovePattern.MatchString(line.Move) || seen[line.Move] || line.Depth != v.Depth || (settings != nil && settings.Depth > 0 && line.Depth > settings.Depth) || !validScore(line.Score) {
			return false
		}
		seen[line.Move] = true
		// PV is shape-only here (Go has no board replay): 1-5 UCI with
		// PV[0]==Move. Rank-1 only by construction; lower ranks must omit
		// it. Full legality is enforced frontend where the FEN is available.
		// Worker + Go ship in one image so no mixed-version PV traffic occurs.
		if index == 0 {
			if line.PV != nil {
				if len(line.PV) < 1 || len(line.PV) > 5 || line.PV[0] != line.Move {
					return false
				}
				for _, pvMove := range line.PV {
					if !uciMovePattern.MatchString(pvMove) {
						return false
					}
				}
			}
		} else if line.PV != nil {
			return false
		}
	}
	return true
}

// cacheSource abstracts point reads so bulk paths can prefetch one IN query
// and serve the same decode/validate/slice logic from memory. serverSource
// is the single-row path; bulkSource is a prefetched snapshot for one
// submit or lookup. Both enforce the same engine/key match.
type cacheSource interface {
	fetch(hash, engine, key string) (cachedEvaluation, bool)
}

type serverSource struct{ s *server }

func (src serverSource) fetch(hash, engine, key string) (cachedEvaluation, bool) {
	return src.s.lookupCache(hash, engine, key)
}

type bulkSource struct{ rows map[string]cachedEvaluation }

func (b bulkSource) fetch(hash, engine, key string) (cachedEvaluation, bool) {
	if !validCacheRef(hash, key) {
		return cachedEvaluation{}, false
	}
	entry, ok := b.rows[hash]
	if !ok || entry.Engine != engine || entry.Key != key {
		return cachedEvaluation{}, false
	}
	return entry, true
}

// prefetch loads every hash in one batched read (chunked IN queries). A nil
// store yields all-miss; a query failure logs once and yields all-miss, the
// same outcome as N failing point reads.
func (s *server) prefetch(hashes []string) cacheSource {
	if s.store == nil || len(hashes) == 0 {
		return bulkSource{rows: map[string]cachedEvaluation{}}
	}
	started := time.Now()
	rows, err := s.store.cacheGetMany(hashes)
	if err != nil {
		log.Printf("evaluation cache bulk read failed hashes=%d error=%v", len(hashes), err)
		return bulkSource{rows: map[string]cachedEvaluation{}}
	}
	log.Printf("evaluation cache bulk read hashes=%d rows=%d duration_us=%d",
		len(hashes), len(rows), time.Since(started).Microseconds())
	return bulkSource{rows: rows}
}

func (s *server) cachedSF(r evaluationRequest) (*evaluationResponse, bool) {
	return s.cachedSFFrom(serverSource{s}, r)
}

func (s *server) cachedSFFrom(src cacheSource, r evaluationRequest) (*evaluationResponse, bool) {
	// Superset reuse: a stored 5-line search serves a 2-line request by
	// slicing, so compatible budgets never recompute. Native exact identity
	// always wins; larger-lines variants are tried in increasing order. The
	// legacy node-budget policy has no compatible v2 timed-policy equivalent,
	// even at 750ms / two candidates.
	for _, candidate := range sfSupersetCandidates(r) {
		if value, ok := s.lookupSFCandidateFrom(src, candidate, r.Settings); ok {
			return value, true
		}
	}
	return nil, false
}

// sfSupersetCandidates returns the exact request first, then larger-lines
// variants for superset slicing. Smaller-lines rows can never satisfy the
// request, so they are skipped without a lookup.
func sfSupersetCandidates(r evaluationRequest) []evaluationRequest {
	out := []evaluationRequest{r}
	for lines := 1; lines <= 5; lines++ {
		if r.Settings == nil || lines <= r.Settings.Lines {
			continue
		}
		candidate := r
		settings := *r.Settings
		settings.Lines = lines
		candidate.Settings = &settings
		out = append(out, candidate)
	}
	return out
}

// lookupSFCandidate reads one identity, validates shape once on the read
// path (write path owns poisoning defense via validOwnedCacheValue), then
// slices the stored max-lines row down to the request. Provenance stays
// native: ActualSettings and SearchPolicy report the stored search, not the
// smaller request.
func (s *server) lookupSFCandidate(candidate evaluationRequest, want *stockfishSettings) (*evaluationResponse, bool) {
	return s.lookupSFCandidateFrom(serverSource{s}, candidate, want)
}

func (s *server) lookupSFCandidateFrom(src cacheSource, candidate evaluationRequest, want *stockfishSettings) (*evaluationResponse, bool) {
	hash, key := sfIdentity(candidate).coordinates()
	entry, ok := src.fetch(hash, "sf", key)
	if !ok {
		return nil, false
	}
	value, ok := decodeStrictValue[evaluationResponse](entry.Value, evalRequired, docAllowNull)
	if !ok || !validEvaluationValue(value, candidate.Settings) {
		return nil, false
	}
	value.ActualSettings = candidate.Settings
	if want != nil && len(value.Lines) > want.Lines {
		value.Lines = value.Lines[:want.Lines]
	}
	return &value, true
}

func (s *server) cachedMaia(r EngineRequest, model string) (*moveResponse, bool) {
	return s.cachedMaiaFrom(serverSource{s}, r, model)
}

func (s *server) cachedMaiaFrom(src cacheSource, r EngineRequest, model string) (*moveResponse, bool) {
	hash, key := maiaIdentity(r, model).coordinates()
	entry, ok := src.fetch(hash, "maia", key)
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
	Engine       string             `json:"engine"`
	FEN          string             `json:"fen"`
	Ply          int                `json:"ply"`
	PosHash      string             `json:"pos_hash,omitempty"`
	Settings     *stockfishSettings `json:"settings,omitempty"`
	EloMaia      *int               `json:"elo_maia,omitempty"`
	EloUser      *int               `json:"elo_user,omitempty"`
	ValueEloMaia *int               `json:"value_elo_maia,omitempty"`
	ValueEloUser *int               `json:"value_elo_user,omitempty"`
	Model        string             `json:"model,omitempty"`
}

// batchLine carries the shared game line once per bulk submit. Entries
// reference it by ply: prefix = moves[:ply] (pure slice, no chess needed).
// The derived triple (fen, initial_fen, prefix) feeds the unchanged
// identity/validate/worker paths, so cache identities are untouched.
type batchLine struct {
	InitialFEN string   `json:"initial_fen"`
	Moves      []string `json:"moves"`
}

// validateBatchLine checks the shared line before per-entry work: moves must
// be a present array, bounded, and UCI-shaped. InitialFEN is left to the
// per-entry triple validation (empty allowed, invalid surfaces as today).
func validateBatchLine(line batchLine) *requestError {
	if line.Moves == nil {
		return &requestError{"invalid_request", "line.moves must be an array"}
	}
	if len(line.Moves) > 4096 {
		return &requestError{"invalid_request", "line.moves may contain at most 4096 plies"}
	}
	for _, move := range line.Moves {
		if !uciMovePattern.MatchString(move) {
			return &requestError{"invalid_request", "line.moves must contain UCI moves"}
		}
	}
	return nil
}

// linePrefix slices the shared line for one entry. Bounds are checked here
// so callers never panic; ply<=256 enforcement stays in the existing
// triple validation (history_too_long wrapped as invalid_request).
func linePrefix(line batchLine, ply int) ([]string, *requestError) {
	if ply < 0 || ply > len(line.Moves) {
		return nil, &requestError{"invalid_request", "ply must be between 0 and len(line.moves)"}
	}
	return line.Moves[:ply], nil
}
type lookupResult struct {
	Index          int                `json:"index"`
	Value          any                `json:"value"`
	ActualSettings *stockfishSettings `json:"actual_settings,omitempty"`
}

func (s *server) evaluationLookup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Line     batchLine       `json:"line"`
		Requests []lookupRequest `json:"requests"`
	}
	decoded, ok := decodeSingle[struct {
		Line     batchLine       `json:"line"`
		Requests []lookupRequest `json:"requests"`
	}](w, r, 4*1024*1024)
	if !ok {
		return
	}
	body = decoded
	if lineErr := validateBatchLine(body.Line); lineErr != nil {
		writeAPIError(w, 400, lineErr.Code, lineErr.Message)
		return
	}
	if body.Requests == nil || len(body.Requests) > 1024 {
		writeAPIError(w, 400, "invalid_request", "requests must be an array of at most 1024 entries")
		return
	}
	results := []lookupResult{}
	// Two phases: resolve every request first (validation only, collecting
	// the identities to fetch), then serve all hits from one prefetched
	// snapshot. Same validation, same per-index results and logs as the old
	// per-entry loop — one bulk read instead of N point reads. Prefixes are
	// pure slices of the shared line; the derived triples feed the unchanged
	// resolve paths.
	type resolved struct {
		query   lookupRequest
		sfReq   evaluationRequest
		maiaReq EngineRequest
		model   string
	}
	prepared := make([]resolved, 0, len(body.Requests))
	var hashes []string
	for index, query := range body.Requests {
		entry := resolved{query: query}
		var invalid error
		prefix, prefixErr := linePrefix(body.Line, query.Ply)
		if prefixErr != nil {
			invalid = fmt.Errorf("%s", prefixErr.Message)
		} else {
			switch query.Engine {
			case "sf":
				request, reqErr := resolveSFQuery(query, body.Line.InitialFEN, prefix)
				if reqErr != nil {
					invalid = fmt.Errorf("%s", reqErr.Message)
				} else {
					entry.sfReq = request
					for _, candidate := range sfSupersetCandidates(request) {
						hash, _ := sfIdentity(candidate).coordinates()
						hashes = append(hashes, hash)
					}
				}
			case "maia":
				request, model, reqErr := resolveMaiaQuery(query, body.Line.InitialFEN, prefix)
				if reqErr != nil {
					invalid = fmt.Errorf("%s", reqErr.Message)
				} else {
					entry.maiaReq, entry.model = request, model
					hash, _ := maiaIdentity(request, model).coordinates()
					hashes = append(hashes, hash)
				}
			default:
				invalid = fmt.Errorf("engine must be sf or maia")
			}
		}
		if invalid != nil {
			writeAPIError(w, 400, "invalid_request", fmt.Sprintf("requests[%d]: %s", index, invalid))
			return
		}
		prepared = append(prepared, entry)
	}
	src := s.prefetch(hashes)
	for index, entry := range prepared {
		// Lookup reuses the shared resolve read-only: same validation as
		// live/batch paths, cache read only, never admits or stores.
		query := entry.query
		switch query.Engine {
		case "sf":
			if value, ok := s.cachedSFFrom(src, entry.sfReq); ok {
				results = append(results, lookupResult{index, value, value.ActualSettings})
				log.Printf("eval-content engine=sf cache=hit via=lookup index=%d fen=%s plies=%d pos=%s %s",
					index, query.FEN, query.Ply, orDash(query.PosHash), sfContentFields(value))
			}
		case "maia":
			if value, ok := s.cachedMaiaFrom(src, entry.maiaReq, entry.model); ok {
				results = append(results, lookupResult{Index: index, Value: value})
				log.Printf("eval-content engine=maia cache=hit via=lookup index=%d fen=%s plies=%d pos=%s elo=%s value=%s model=%s %s",
					index, query.FEN, query.Ply, orDash(query.PosHash), eloPair(query.EloMaia, query.EloUser),
					valueEloPair(query.ValueEloMaia, query.ValueEloUser), entry.model, maiaContentFields(*value))
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}
