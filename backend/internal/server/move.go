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

// MoveRequest is the /move and /move/analysis wire shape. Huma derives the
// OpenAPI schema and required keys from these tags; chess-domain validation
// stays in validateMoveRequest below.
type MoveRequest struct {
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
}

type MoveInput struct {
	Body MoveRequest
}

// MoveOutput carries the Maia reply plus the cache header. The header stays
// empty for sampled (temperature != 0) replies; only hit/miss are emitted.
type MoveOutput struct {
	Cache string `header:"X-Eval-Cache"`
	Body  engine.MoveResponse
}

// /move serves live replies (Play), /move/analysis retrospective analysis
// (Focus), same payload. Separate lanes are load-bearing: a shared depth-1
// lane would supersede the live reply when feedback fires concurrently.
// Do not merge.
func (s *Server) handleMovePlay(ctx context.Context, input *MoveInput) (*MoveOutput, error) {
	return s.serveMove(ctx, &input.Body, sched.PriorityPlay)
}
func (s *Server) handleMoveFocus(ctx context.Context, input *MoveInput) (*MoveOutput, error) {
	return s.serveMove(ctx, &input.Body, sched.PriorityFocus)
}

// serveMove runs one Maia inference through the shared executor on the
// endpoint's lane.
//
// ctx is the request context: it drives the admission wait (a disconnect
// dequeues), while execution stays detached so a granted op still validates
// and persists after the client goes away.
func (s *Server) serveMove(ctx context.Context, request *MoveRequest, prio sched.Priority) (*MoveOutput, error) {
	started := time.Now()
	var response engine.MoveResponse
	model, degraded, hit := "", false, false
	status := http.StatusOK
	lane := "play"
	if prio == sched.PriorityFocus {
		lane = "focus"
	}
	if s.authEnabled() {
		if _, err := s.requireUser(ctx); err != nil {
			status = http.StatusUnauthorized
			return nil, err
		}
	}
	validateMicros, execMillis, waitMillis := int64(-1), int64(-1), int64(-1)
	defer func() {
		log.Printf("move status=%d lane=%s plies=%d model=%s degraded=%t duration_ms=%d validate_us=%d exec_ms=%d wait_ms=%d",
			status, lane, len(request.Moves), model, degraded, time.Since(started).Milliseconds(), validateMicros, execMillis, waitMillis)
		if status == http.StatusOK {
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
	validateStart := time.Now()
	engineRequest, validated, err := validateMoveRequest(*request)
	validateMicros = time.Since(validateStart).Microseconds()
	if err != nil {
		if reqErr, ok := errors.AsType[*apierror.RequestError](err); ok {
			status = http.StatusBadRequest
			return nil, apiError(status, reqErr.Code, reqErr.Message)
		}
		status = http.StatusBadRequest
		return nil, apiError(status, "invalid_request", "request validation failed")
	}
	model = validated
	if s.pool != nil && !s.pool.Supports(model) {
		status = http.StatusBadRequest
		return nil, apiError(status, "invalid_model", "model 5m is not enabled on this server")
	}

	useCache := request.Temperature == 0
	execCtx := context.WithoutCancel(ctx)
	execStart := time.Now()
	response, hit, predictErr := s.executeMaia(ctx, execCtx, prio, 0, engineRequest, model, false)
	execMillis = time.Since(execStart).Milliseconds()
	if predictErr != nil {
		failStatus, failCode, failMessage := engineFailure(predictErr, engine.SanitizeError(predictErr.Error()))
		status = failStatus
		return nil, apiError(failStatus, failCode, failMessage)
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
	out := &MoveOutput{Body: response}
	if useCache {
		if hit {
			out.Cache = "hit"
		} else {
			out.Cache = "miss"
		}
	}
	return out, nil
}

func validateMoveRequest(request MoveRequest) (engine.MaiaRequest, string, error) {
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
