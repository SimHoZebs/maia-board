package server

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"time"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/chess"
	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/evalcache"
	"maia-board/backend/internal/store"
)

// cacheSource abstracts point reads so bulk paths can prefetch one IN query
// and serve the same decode/validate/slice logic from memory. serverSource
// is the single-row path; bulkSource is a prefetched snapshot for one
// submit or lookup. Both enforce the same engine/key match.
type cacheSource interface {
	fetch(hash, engine, key string) (store.CachedEvaluation, bool)
}

type serverSource struct{ s *Server }

func (src serverSource) fetch(hash, eng, key string) (store.CachedEvaluation, bool) {
	return src.s.lookupCache(hash, eng, key)
}

type bulkSource struct {
	rows map[string]store.CachedEvaluation
}

func (b bulkSource) fetch(hash, eng, key string) (store.CachedEvaluation, bool) {
	if !evalcache.ValidCacheRef(hash, key) {
		return store.CachedEvaluation{}, false
	}
	entry, ok := b.rows[hash]
	if !ok || entry.Engine != eng || entry.Key != key {
		return store.CachedEvaluation{}, false
	}
	return entry, true
}

// prefetch loads every hash in one batched read (chunked IN queries). A nil
// store yields all-miss; a query failure logs once and yields all-miss, the
// same outcome as N failing point reads.
func (s *Server) prefetch(hashes []string) cacheSource {
	if s.store == nil || len(hashes) == 0 {
		return bulkSource{rows: map[string]store.CachedEvaluation{}}
	}
	started := time.Now()
	rows, err := s.store.CacheGetMany(hashes)
	if err != nil {
		log.Printf("evaluation cache bulk read failed hashes=%d error=%v", len(hashes), err)
		return bulkSource{rows: map[string]store.CachedEvaluation{}}
	}
	log.Printf("evaluation cache bulk read hashes=%d rows=%d duration_us=%d",
		len(hashes), len(rows), time.Since(started).Microseconds())
	return bulkSource{rows: rows}
}

func (s *Server) cachedSF(r engine.EvaluationRequest) (*engine.EvaluationResponse, bool) {
	return s.cachedSFFrom(serverSource{s}, r)
}

func (s *Server) cachedSFFrom(src cacheSource, r engine.EvaluationRequest) (*engine.EvaluationResponse, bool) {
	// Superset reuse: a stored 5-line search serves a 2-line request by
	// slicing, so compatible budgets never recompute. Native exact identity
	// always wins; larger-lines variants are tried in increasing order. The
	// legacy node-budget policy has no compatible v2 timed-policy equivalent,
	// even at 750ms / two candidates. Timed reuse is approximate: a fixed
	// time budget spread over more lines is thinner per line than a dedicated
	// smaller search. Provenance must stay native (ActualSettings and
	// SearchPolicy report the stored search) so the client can slice without
	// relabelling; see TestLookupCompatibleSettingsPreserveActualProvenance.
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
func sfSupersetCandidates(r engine.EvaluationRequest) []engine.EvaluationRequest {
	out := []engine.EvaluationRequest{r}
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
// path (write path owns poisoning defense via ValidOwnedCacheValue), then
// slices the stored max-lines row down to the request. Provenance stays
// native: ActualSettings and SearchPolicy report the stored search, not the
// smaller request.
func (s *Server) lookupSFCandidate(candidate engine.EvaluationRequest, want *engine.StockfishSettings) (*engine.EvaluationResponse, bool) {
	return s.lookupSFCandidateFrom(serverSource{s}, candidate, want)
}

func (s *Server) lookupSFCandidateFrom(src cacheSource, candidate engine.EvaluationRequest, want *engine.StockfishSettings) (*engine.EvaluationResponse, bool) {
	hash, key := engine.SFIdentity(candidate).Coordinates()
	entry, ok := src.fetch(hash, "sf", key)
	if !ok {
		return nil, false
	}
	value, ok := evalcache.DecodeStrictValue[engine.EvaluationResponse](entry.Value, engine.EvalRequired, engine.DocAllowNull)
	if !ok || !engine.ValidEvaluationValue(value, candidate.Settings) {
		return nil, false
	}
	value.ActualSettings = candidate.Settings
	if want != nil && len(value.Lines) > want.Lines {
		value.Lines = value.Lines[:want.Lines]
	}
	return &value, true
}

func (s *Server) cachedMaia(r engine.MaiaRequest, model string) (*engine.MoveResponse, bool) {
	return s.cachedMaiaFrom(serverSource{s}, r, model)
}

func (s *Server) cachedMaiaFrom(src cacheSource, r engine.MaiaRequest, model string) (*engine.MoveResponse, bool) {
	hash, key := engine.MaiaIdentity(r, model).Coordinates()
	entry, ok := src.fetch(hash, "maia", key)
	if !ok {
		return nil, false
	}
	value, ok := evalcache.DecodeStrictValue[engine.MoveResponse](entry.Value, engine.MoveRequired, nil)
	if !ok || !engine.ValidMoveValue(value, model, true) || value.Degraded {
		return nil, false
	}
	return &value, true
}

// maiaGradingHash is the cache identity of the before-position 2400 point
// for a display triple: same position and history, fixed 2400/2400 ratings
// on 79m, no value split. It mirrors the client's grading lane,
// including the ValueRev-1 normalization that lets a 2400 display row share
// its own grading row.
func maiaGradingHash(r engine.MaiaRequest) (string, string) {
	grading := engine.MaiaRequest{FEN: r.FEN, Moves: r.Moves, InitialFEN: r.InitialFEN, SelfElo: 2400, OppoElo: 2400}
	return engine.MaiaIdentity(grading, "79m").Coordinates()
}

// attachMaiaDelta serves a Maia row with its delta context: the
// before-position 2400 baseline plus per-candidate deltas (raw floats; the
// client formats). The baseline is read, never stored: it depends on which
// grading rows exist at serve time, so freezing it into the cache would go
// stale. Without a grading row the baseline stays absent and the client
// falls back to its list-max comparison.
//
// The grading fetch mirrors the display read's trust boundary: the baseline
// must come from a non-degraded 79m row with a valid position WDL. Degraded
// rows are never written through the cache, but the read must not depend on
// that write-path guarantee alone.
func attachMaiaDelta(src cacheSource, r engine.MaiaRequest, value *engine.MoveResponse) *engine.MoveResponse {
	if value == nil || len(value.TopMoves) == 0 {
		return value
	}
	hash, key := maiaGradingHash(r)
	entry, ok := src.fetch(hash, "maia", key)
	if !ok {
		return value
	}
	grading, ok := evalcache.DecodeStrictValue[engine.MoveResponse](entry.Value, engine.MoveRequired, nil)
	if !ok || grading.Degraded || grading.ModelUsed != "79m" || !evalcache.ValidWDL(grading.WDL) {
		return value
	}
	baseline := wdlExpected(grading.WDL)
	out := *value
	out.DeltaBaseline = &engine.DeltaBaseline{Value: baseline, Kind: "before"}
	tops := make([]engine.TopMove, 0, len(value.TopMoves))
	for _, candidate := range value.TopMoves {
		delta := wdlExpected(candidate.WDL) - baseline
		tops = append(tops, engine.TopMove{Move: candidate.Move, Prob: candidate.Prob, WDL: candidate.WDL, Delta: &delta})
	}
	out.TopMoves = tops
	return &out
}

type LookupRequest struct {
	Engine       string                    `json:"engine"`
	FEN          string                    `json:"fen"`
	Ply          int                       `json:"ply"`
	PosHash      string                    `json:"pos_hash,omitempty"`
	Settings     *engine.StockfishSettings `json:"settings,omitempty"`
	EloMaia      *int                      `json:"elo_maia,omitempty"`
	EloUser      *int                      `json:"elo_user,omitempty"`
	ValueEloMaia *int                      `json:"value_elo_maia,omitempty"`
	ValueEloUser *int                      `json:"value_elo_user,omitempty"`
	Model        string                    `json:"model,omitempty"`
}

func (r *LookupRequest) UnmarshalJSON(data []byte) error {
	type plain LookupRequest
	decoded, err := evalcache.DecodeStrict[plain](data, []string{"engine", "fen", "ply"}, nil)
	if err != nil {
		return err
	}
	*r = LookupRequest(decoded)
	return nil
}

// BatchLine carries the shared game line once per bulk submit. Entries
// reference it by ply: prefix = moves[:ply] (pure slice, no chess needed).
// The derived triple (fen, initial_fen, prefix) feeds the unchanged
// identity/validate/worker paths, so cache identities are untouched.
type BatchLine struct {
	InitialFEN string   `json:"initial_fen"`
	Moves      []string `json:"moves"`
}

func (b *BatchLine) UnmarshalJSON(data []byte) error {
	type plain BatchLine
	decoded, err := evalcache.DecodeStrict[plain](data, []string{"initial_fen", "moves"}, nil)
	if err != nil {
		return err
	}
	*b = BatchLine(decoded)
	return nil
}

// validateBatchLine checks the shared line before per-entry work: moves must
// be a present array, bounded, and UCI-shaped. InitialFEN is left to the
// per-entry triple validation (empty allowed, invalid surfaces as today).
func validateBatchLine(line BatchLine) *apierror.RequestError {
	if line.Moves == nil {
		return &apierror.RequestError{Code: "invalid_request", Message: "line.moves must be an array"}
	}
	if len(line.Moves) > 4096 {
		return &apierror.RequestError{Code: "invalid_request", Message: "line.moves may contain at most 4096 plies"}
	}
	for _, move := range line.Moves {
		if !chess.UCIMovePattern.MatchString(move) {
			return &apierror.RequestError{Code: "invalid_request", Message: "line.moves must contain UCI moves"}
		}
	}
	return nil
}

// linePrefix slices the shared line for one entry. Bounds are checked here
// so callers never panic; ply<=256 enforcement stays in the existing
// triple validation (history_too_long wrapped as invalid_request).
func linePrefix(line BatchLine, ply int) ([]string, *apierror.RequestError) {
	if ply < 0 || ply > len(line.Moves) {
		return nil, &apierror.RequestError{Code: "invalid_request", Message: "ply must be between 0 and len(line.moves)"}
	}
	return line.Moves[:ply], nil
}

type LookupResult struct {
	Index          int                       `json:"index"`
	Value          any                       `json:"value"`
	ActualSettings *engine.StockfishSettings `json:"actual_settings,omitempty"`
}

// LookupBody is the POST /evaluations/lookup (and POST /reviews) bulk
// shape: the shared line once, entries referencing it by ply.
type LookupBody struct {
	Line     BatchLine       `json:"line"`
	Requests []LookupRequest `json:"requests"`
}

type LookupInput struct {
	Body LookupBody
}

// LookupResults is the bulk cache-read document. Results stay [] (never
// null) so empty restores parse without a shape check.
type LookupResults struct {
	Results []LookupResult `json:"results"`
}

type LookupOutput struct {
	Body LookupResults
}

func (s *Server) handleEvalLookup(ctx context.Context, input *LookupInput) (*LookupOutput, error) {
	body := input.Body
	if lineErr := validateBatchLine(body.Line); lineErr != nil {
		return nil, apiError(http.StatusBadRequest, lineErr.Code, lineErr.Message)
	}
	if body.Requests == nil || len(body.Requests) > 1024 {
		return nil, apiError(http.StatusBadRequest, "invalid_request", "requests must be an array of at most 1024 entries")
	}
	results := []LookupResult{}
	// Two phases: resolve every request first (validation only, collecting
	// the identities to fetch), then serve all hits from one prefetched
	// snapshot. Same validation, same per-index results and logs as the old
	// per-entry loop — one bulk read instead of N point reads. Prefixes are
	// pure slices of the shared line; the derived triples feed the unchanged
	// resolve paths.
	type resolved struct {
		query   LookupRequest
		sfReq   engine.EvaluationRequest
		maiaReq engine.MaiaRequest
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
						hash, _ := engine.SFIdentity(candidate).Coordinates()
						hashes = append(hashes, hash)
					}
				}
			case "maia":
				request, model, reqErr := resolveMaiaQuery(query, body.Line.InitialFEN, prefix)
				if reqErr != nil {
					invalid = fmt.Errorf("%s", reqErr.Message)
				} else {
					entry.maiaReq, entry.model = request, model
					hash, _ := engine.MaiaIdentity(request, model).Coordinates()
					hashes = append(hashes, hash)
					// The delta baseline reads the grading row from the same
					// snapshot, so its identity joins the prefetch.
					gradingHash, _ := maiaGradingHash(request)
					hashes = append(hashes, gradingHash)
				}
			default:
				invalid = fmt.Errorf("engine must be sf or maia")
			}
		}
		if invalid != nil {
			return nil, apiError(http.StatusBadRequest, "invalid_request", fmt.Sprintf("requests[%d]: %s", index, invalid))
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
				results = append(results, LookupResult{index, value, value.ActualSettings})
				log.Printf("eval-content engine=sf cache=hit via=lookup index=%d fen=%s plies=%d pos=%s %s",
					index, query.FEN, query.Ply, orDash(query.PosHash), sfContentFields(value))
			}
		case "maia":
			if value, ok := s.cachedMaiaFrom(src, entry.maiaReq, entry.model); ok {
				value = attachMaiaDelta(src, entry.maiaReq, value)
				results = append(results, LookupResult{Index: index, Value: value})
				log.Printf("eval-content engine=maia cache=hit via=lookup index=%d fen=%s plies=%d pos=%s elo=%s value=%s model=%s %s",
					index, query.FEN, query.Ply, orDash(query.PosHash), eloPair(query.EloMaia, query.EloUser),
					valueEloPair(query.ValueEloMaia, query.ValueEloUser), entry.model, maiaContentFields(*value))
			}
		}
	}
	return &LookupOutput{Body: LookupResults{Results: results}}, nil
}
