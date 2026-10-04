package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"time"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/chess"
	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/sched"
)

type moveRequest struct {
	FEN          string   `json:"fen"`
	Moves        []string `json:"moves"`
	EloMaia      *int     `json:"elo_maia"`
	EloUser      *int     `json:"elo_user"`
	ValueEloMaia *int     `json:"value_elo_maia,omitempty"`
	ValueEloUser *int     `json:"value_elo_user,omitempty"`
	Model        string   `json:"model"`
	MaiaColor    string   `json:"maia_color"`
	InitialFEN   string   `json:"initial_fen,omitempty"`
	Temperature  float64  `json:"temperature,omitempty"`
	// Accepted for older clients; cache identity is derived by the server.
	CacheHash string `json:"cache_hash,omitempty"`
	CacheKey  string `json:"cache_key,omitempty"`
}

// /move serves live game replies; /move/analysis serves retrospective Maia
// analysis with the same payload shape. Separate endpoints keep the
// endpoint-implied lane mapping exact (Play vs Focus). This split is
// load-bearing, not cosmetic: every user move fires a live reply plus its
// move feedback concurrently, and one depth-1 latest-wins lane would
// supersede the queued waiter and surface 409 on the live reply. Keep play
// and analysis on separate lanes (Play queues ahead of Focus) — do not merge.
func (s *Server) move(w http.ResponseWriter, r *http.Request) { s.serveMove(w, r, sched.PriorityPlay) }
func (s *Server) moveAnalysis(w http.ResponseWriter, r *http.Request) {
	s.serveMove(w, r, sched.PriorityFocus)
}

// serveMove runs one Maia inference through the shared executor. The lane
// is endpoint-implied: /move → Play (live game replies, latency-critical),
// /move/analysis → Focus (retrospective analysis). Lanes queue on the shared
// slot with Play priority instead of superseding each other; same-lane
// arrivals stay latest-wins.
func (s *Server) serveMove(w http.ResponseWriter, r *http.Request, prio sched.Priority) {
	started := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	w = rec
	var request moveRequest
	var response engine.MoveResponse
	model, degraded, hit := "", false, false
	lane := "play"
	if prio == sched.PriorityFocus {
		lane = "focus"
	}
	// Perf spans: validate_us covers decode + request validation, exec_ms
	// covers the cache→admission→inference→store path, and wait_ms is the
	// admission queue wait inside exec_ms (-1 when admission was never
	// reached: validation error or cache hit). exec_ms - wait_ms ~= engine
	// inference + store on misses.
	validateMicros, execMillis, waitMillis := int64(-1), int64(-1), int64(-1)
	defer func() {
		log.Printf("move status=%d lane=%s plies=%d model=%s degraded=%t duration_ms=%d validate_us=%d exec_ms=%d wait_ms=%d",
			rec.status, lane, len(request.Moves), model, degraded, time.Since(started).Milliseconds(), validateMicros, execMillis, waitMillis)
		if rec.status == http.StatusOK {
			cache := "miss"
			if request.Temperature != 0 {
				cache = "live"
			} else if hit {
				cache = "hit"
			}
			modelName := request.Model
			if modelName == "" {
				modelName = "79m"
			}
			log.Printf("eval-content engine=maia cache=%s lane=%s fen=%s plies=%d elo=%s value=%s model=%s color=%s %s",
				cache, lane, request.FEN, len(request.Moves), eloPair(request.EloMaia, request.EloUser),
				valueEloPair(request.ValueEloMaia, request.ValueEloUser), modelName, request.MaiaColor, maiaContentFields(response))
		}
	}()
	request, ok := decodeSingle[moveRequest](w, r, 64*1024)
	if !ok {
		return
	}
	validateStart := time.Now()
	engineRequest, validated, err := validateMoveRequest(request)
	validateMicros = time.Since(validateStart).Microseconds()
	if err != nil {
		if reqErr, ok := errors.AsType[*apierror.RequestError](err); ok {
			writeAPIError(w, http.StatusBadRequest, reqErr.Code, reqErr.Message)
			return
		}
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "request validation failed")
		return
	}
	model = validated
	if s.pool != nil && !s.pool.Supports(model) {
		writeAPIError(w, http.StatusBadRequest, "invalid_model", "model 5m is not enabled on this server")
		return
	}

	// waitCtx dequeues on disconnect; execCtx stays detached so a granted op
	// still validates and persists after the client goes away.
	useCache := request.Temperature == 0
	execCtx := context.WithoutCancel(r.Context())
	execStart := time.Now()
	response, hit, predictErr := s.executeMaia(r.Context(), execCtx, prio, 0, engineRequest, model, false)
	execMillis = time.Since(execStart).Milliseconds()
	if predictErr != nil {
		mapEngineError(w, predictErr, engine.SanitizeError(predictErr.Error()))
		return
	}
	if !hit {
		waitMillis = response.WaitMs
	}
	model, degraded = response.ModelUsed, response.Degraded
	// The analysis lane serves rows with their delta context attached (the
	// before-position 2400 baseline + per-candidate deltas). Attachment
	// happens after the executor's write-through, so cached rows stay
	// baseline-free and never go stale. Play replies carry no delta column.
	if prio == sched.PriorityFocus {
		response = *attachMaiaDelta(serverSource{s}, engineRequest, &response)
	}
	if useCache {
		if hit {
			w.Header().Set("X-Eval-Cache", "hit")
		} else {
			w.Header().Set("X-Eval-Cache", "miss")
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func validateMoveRequest(request moveRequest) (engine.MaiaRequest, string, error) {
	if !chess.ValidTemperature(request.Temperature) {
		return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "invalid_request", Message: "temperature must be between 0 and 2"}
	}
	fen, side, err := chess.NormalizeFEN(request.FEN)
	if err != nil {
		return engine.MaiaRequest{}, "", err
	}
	if err := chess.ValidateElo(request.EloMaia, request.EloUser); err != nil {
		return engine.MaiaRequest{}, "", err
	}
	for _, elo := range []*int{request.ValueEloMaia, request.ValueEloUser} {
		if elo != nil && (*elo < 0 || *elo > 5000) {
			return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "invalid_elo", Message: "Elo values must be between 0 and 5000"}
		}
	}
	model := request.Model
	if model == "" {
		model = "79m"
	}
	if model != "79m" && model != "5m" {
		return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "invalid_model", Message: "model must be lowercase 79m or 5m"}
	}
	if request.MaiaColor != "white" && request.MaiaColor != "black" {
		return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "invalid_maia_color", Message: "maia_color must be white or black"}
	}
	if (side == "w" && request.MaiaColor != "white") || (side == "b" && request.MaiaColor != "black") {
		return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "not_maia_turn", Message: "fen side-to-move is not maia_color"}
	}
	if len(request.Moves) > 256 {
		return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "history_too_long", Message: "moves may contain at most 256 plies"}
	}
	if err := chess.ValidateUCIMoves(request.Moves); err != nil {
		return engine.MaiaRequest{}, "", err
	}
	initialFEN := request.InitialFEN
	if initialFEN != "" {
		normalizedInitialFEN, _, err := chess.NormalizeFEN(initialFEN)
		if err != nil {
			return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "invalid_initial_fen", Message: "initial_fen must be a valid FEN"}
		}
		initialFEN = normalizedInitialFEN
		if len(request.Moves) == 0 && initialFEN != fen {
			return engine.MaiaRequest{}, "", &apierror.RequestError{Code: "position_mismatch", Message: "initial_fen must equal fen when moves is empty"}
		}
	}
	return engine.MaiaRequest{
		FEN:          fen,
		Moves:        request.Moves,
		InitialFEN:   initialFEN,
		SelfElo:      *request.EloMaia,
		OppoElo:      *request.EloUser,
		ValueSelfElo: request.ValueEloMaia,
		ValueOppoElo: request.ValueEloUser,
		Temperature:  request.Temperature,
	}, model, nil
}
