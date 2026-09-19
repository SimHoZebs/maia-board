package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var uciMovePattern = regexp.MustCompile(`^[a-h][1-8][a-h][1-8][qrbn]?$`)
var epSquarePattern = regexp.MustCompile(`^[a-h][36]$`)

type moveRequest struct {
	FEN          string   `json:"fen"`
	Moves        []string `json:"moves"`
	EloMaia      *int     `json:"elo_maia"`
	EloUser      *int     `json:"elo_user"`
	ValueEloMaia *int     `json:"value_elo_maia,omitempty"`
	ValueEloUser *int     `json:"value_elo_user,omitempty"`
	Model        string   `json:"model"`
	MaiaColor    string   `json:"maia_color"`
	InitialFEN  string   `json:"initial_fen,omitempty"`
	Temperature float64  `json:"temperature,omitempty"`
	// Accepted for older clients; cache identity is derived by the server.
	CacheHash string `json:"cache_hash,omitempty"`
	CacheKey  string `json:"cache_key,omitempty"`
}

type topMove struct {
	Move string     `json:"move"`
	Prob float64    `json:"prob"`
	WDL  [3]float64 `json:"wdl"`
}

type moveResponse struct {
	Move      string     `json:"move"`
	TopMoves  []topMove  `json:"top_moves"`
	WDL       [3]float64 `json:"wdl"`
	ModelUsed string     `json:"model_used"`
	Degraded  bool       `json:"degraded"`
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type requestError struct {
	Code    string
	Message string
}

func (e *requestError) Error() string { return e.Code + ": " + e.Message }

type server struct {
	pool      *EnginePool
	staticDir string
	evaluator *Evaluator
	store     *GameStore
	reviews   *ReviewJobs
	openings  *OpeningsLookup
}

func main() {
	workerPath := getenv("MAIA3_WORKER", "/app/maia3_worker.py")
	python := getenv("PYTHON", "python3")
	largeModel := getenv("MAIA3_MODEL_79M", "79m")
	smallModel := getenv("MAIA3_MODEL_5M", "5m")
	port := getenv("PORT", "8080")
	staticDir := getenv("STATIC_DIR", "/app/static")

	large := NewWorker("79m", workerCommand(python, workerPath, largeModel))
	small := NewWorker("5m", workerCommand(python, workerPath, smallModel))
	store, err := NewGameStore(getenv("DB_PATH", "maia-board.db"))
	if err != nil {
		log.Fatalf("open game database: %v", err)
	}
	app := &server{pool: NewEnginePool(large, small), staticDir: staticDir, store: store,
		evaluator: NewEvaluator(python, getenv("STOCKFISH_WORKER", "/app/stockfish_worker.py"), getenv("STOCKFISH_BINARY", "/app/stockfish")),
		openings:  NewOpeningsLookup(python, getenv("OPENINGS_LOOKUP", "/app/openings_lookup.py"))}
	app.reviews = NewReviewJobs(app)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", app.healthz)
	mux.HandleFunc("/move", app.move)
	mux.HandleFunc("/move/analysis", app.moveAnalysis)
	mux.HandleFunc("/evaluate", app.evaluate)
	mux.HandleFunc("/games", app.games)
	mux.HandleFunc("/games/", app.gameByID)
	mux.HandleFunc("/evaluations", app.evaluations)
	mux.HandleFunc("/evaluations/", app.evaluations)
	mux.HandleFunc("/evaluations/lookup", app.evaluationLookup)
	mux.HandleFunc("/openings", app.openingsHandler)
	mux.HandleFunc("/reviews", app.reviews.reviews)
	mux.HandleFunc("/reviews/", app.reviews.reviewRouter)
	mux.HandleFunc("/", app.frontend)
	address := ":" + port
	log.Printf("maia-board listening on %s", address)
	if err := http.ListenAndServe(address, recoverJSON(mux)); err != nil {
		log.Fatal(err)
	}
}

func recoverJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				log.Printf("panic handling %s %s: %v", r.Method, r.URL.Path, recovered)
				writeAPIError(w, http.StatusInternalServerError, "internal", "the server hit an unexpected error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *server) frontend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or HEAD is required")
		return
	}

	requested := strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), "/")
	filePath := filepath.Join(s.staticDir, filepath.FromSlash(requested))
	if requested != "" {
		if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
			http.ServeFile(w, r, filePath)
			return
		}
	}

	indexPath := filepath.Join(s.staticDir, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		http.NotFound(w, r)
		return
	}
	http.ServeFile(w, r, indexPath)
}

func workerCommand(python, workerPath, model string) []string {
	return []string{python, workerPath, "--model", model, "--device", "cpu", "--no-use-amp", "--multipv", "5", "--temperature", "0", "--use-uci-history"}
}

func (s *server) healthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or HEAD is required")
		return
	}
	status, models, code := s.pool.health()
	writeJSON(w, code, map[string]any{"status": status, "models": models})
}

// /move serves live game replies; /move/analysis serves retrospective Maia
// analysis with the same payload shape. Separate endpoints keep the
// endpoint-implied lane mapping exact (Play vs Focus). This split is
// load-bearing, not cosmetic: every user move fires a live reply plus its
// move feedback concurrently, and one depth-1 latest-wins lane would
// supersede the queued waiter and surface 409 on the live reply. Keep play
// and analysis on separate lanes (Play queues ahead of Focus) — do not merge.
func (s *server) move(w http.ResponseWriter, r *http.Request) { s.serveMove(w, r, PriorityPlay) }
func (s *server) moveAnalysis(w http.ResponseWriter, r *http.Request) {
	s.serveMove(w, r, PriorityFocus)
}

// serveMove runs one Maia inference through the shared executor. The lane
// is endpoint-implied: /move → Play (live game replies, latency-critical),
// /move/analysis → Focus (retrospective analysis). Lanes queue on the shared
// slot with Play priority instead of superseding each other; same-lane
// arrivals stay latest-wins.
func (s *server) serveMove(w http.ResponseWriter, r *http.Request, prio Priority) {
	started := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	w = rec
	var request moveRequest
	model, degraded := "", false
	lane := "play"
	if prio == PriorityFocus {
		lane = "focus"
	}
	defer func() {
		log.Printf("move status=%d lane=%s plies=%d model=%s degraded=%t duration_ms=%d",
			rec.status, lane, len(request.Moves), model, degraded, time.Since(started).Milliseconds())
	}()
	request, ok := decodeSingle[moveRequest](w, r, 64*1024)
	if !ok {
		return
	}
	engineRequest, validated, err := validateMoveRequest(request)
	if err != nil {
		if reqErr, ok := errors.AsType[*requestError](err); ok {
			writeAPIError(w, http.StatusBadRequest, reqErr.Code, reqErr.Message)
			return
		}
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "request validation failed")
		return
	}
	model = validated

	// waitCtx dequeues on disconnect; execCtx stays detached so a granted op
	// still validates and persists after the client goes away.
	useCache := request.Temperature == 0
	execCtx := context.WithoutCancel(r.Context())
	response, hit, predictErr := s.executeMaia(r.Context(), execCtx, prio, 0, engineRequest, model, false)
	if predictErr != nil {
		mapEngineError(w, predictErr, sanitizeError(predictErr.Error()))
		return
	}
	model, degraded = response.ModelUsed, response.Degraded
	if useCache {
		if hit {
			w.Header().Set("X-Eval-Cache", "hit")
		} else {
			w.Header().Set("X-Eval-Cache", "miss")
		}
	}
	writeJSON(w, http.StatusOK, response)
}

func validateMoveRequest(request moveRequest) (EngineRequest, string, error) {
	if !validTemperature(request.Temperature) {
		return EngineRequest{}, "", &requestError{Code: "invalid_request", Message: "temperature must be between 0 and 2"}
	}
	fen, side, err := normalizeFEN(request.FEN)
	if err != nil {
		return EngineRequest{}, "", err
	}
	if err := validateElo(request.EloMaia, request.EloUser); err != nil {
		return EngineRequest{}, "", err
	}
	for _, elo := range []*int{request.ValueEloMaia, request.ValueEloUser} {
		if elo != nil && (*elo < 0 || *elo > 5000) {
			return EngineRequest{}, "", &requestError{Code: "invalid_elo", Message: "Elo values must be between 0 and 5000"}
		}
	}
	model := request.Model
	if model == "" {
		model = "79m"
	}
	if model != "79m" && model != "5m" {
		return EngineRequest{}, "", &requestError{Code: "invalid_model", Message: "model must be lowercase 79m or 5m"}
	}
	if request.MaiaColor != "white" && request.MaiaColor != "black" {
		return EngineRequest{}, "", &requestError{Code: "invalid_maia_color", Message: "maia_color must be white or black"}
	}
	if (side == "w" && request.MaiaColor != "white") || (side == "b" && request.MaiaColor != "black") {
		return EngineRequest{}, "", &requestError{Code: "not_maia_turn", Message: "fen side-to-move is not maia_color"}
	}
	if len(request.Moves) > 256 {
		return EngineRequest{}, "", &requestError{Code: "history_too_long", Message: "moves may contain at most 256 plies"}
	}
	if err := validateUCIMoves(request.Moves); err != nil {
		return EngineRequest{}, "", err
	}
	initialFEN := request.InitialFEN
	if initialFEN != "" {
		normalizedInitialFEN, _, err := normalizeFEN(initialFEN)
		if err != nil {
			return EngineRequest{}, "", &requestError{Code: "invalid_initial_fen", Message: "initial_fen must be a valid FEN"}
		}
		initialFEN = normalizedInitialFEN
		if len(request.Moves) == 0 && initialFEN != fen {
			return EngineRequest{}, "", &requestError{Code: "position_mismatch", Message: "initial_fen must equal fen when moves is empty"}
		}
	}
	return EngineRequest{
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

func normalizeFEN(fen string) (string, string, error) {
	fields := strings.Fields(fen)
	if len(fields) != 6 {
		return "", "", &requestError{Code: "invalid_fen", Message: "fen must contain six fields"}
	}
	if fields[1] != "w" && fields[1] != "b" {
		return "", "", &requestError{Code: "invalid_fen", Message: "fen side-to-move must be w or b"}
	}
	ranks := strings.Split(fields[0], "/")
	if len(ranks) != 8 {
		return "", "", &requestError{Code: "invalid_fen", Message: "fen board must contain eight ranks"}
	}
	for _, rank := range ranks {
		count := 0
		for _, piece := range rank {
			switch {
			case piece >= '1' && piece <= '8':
				count += int(piece - '0')
			case strings.ContainsRune("pnbrqkPNBRQK", piece):
				count++
			default:
				return "", "", &requestError{Code: "invalid_fen", Message: "fen contains an invalid board symbol"}
			}
		}
		if count != 8 {
			return "", "", &requestError{Code: "invalid_fen", Message: "fen rank does not contain eight squares"}
		}
	}
	if fields[2] != "-" {
		for _, piece := range fields[2] {
			if !strings.ContainsRune("KQkq", piece) {
				return "", "", &requestError{Code: "invalid_fen", Message: "fen contains invalid castling rights"}
			}
		}
	}
	if fields[3] != "-" && !epSquarePattern.MatchString(fields[3]) {
		return "", "", &requestError{Code: "invalid_fen", Message: "fen contains invalid en-passant square"}
	}
	for _, field := range fields[4:] {
		value, err := strconv.Atoi(field)
		if err != nil || value < 0 {
			return "", "", &requestError{Code: "invalid_fen", Message: "fen move counters must be non-negative integers"}
		}
	}
	return strings.Join(fields, " "), fields[1], nil
}

func writeAPIError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, apiError{Code: code, Message: message})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("http response encoding/write failed: %v", err)
	}
}

// statusRecorder captures the response status so handlers can log one
// per-request timing line (method/path/status/duration) for analysis
// slowdown diagnosis. Interactive analysis issues one /move/analysis + one /evaluate
// per examined position; whole-game batches instead emit one review-batch
// entry line per position from the drain loop, so `docker logs` (Komodo)
// shows the per-ply latency curve either way: a second-half cliff points
// at ply-correlated cost (history length, hash pressure, thermal), while
// flat-but-slow lines point at the search budget itself
// (time_ms/lines/depth).
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	r.ResponseWriter.WriteHeader(status)
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
