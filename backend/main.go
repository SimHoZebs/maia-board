package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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
	FEN         string   `json:"fen"`
	Moves       []string `json:"moves"`
	EloMaia     *int     `json:"elo_maia"`
	EloUser     *int     `json:"elo_user"`
	Model       string   `json:"model"`
	MaiaColor   string   `json:"maia_color"`
	InitialFEN  string   `json:"initial_fen,omitempty"`
	Temperature float64  `json:"temperature,omitempty"`
	// Accepted for older clients; cache identity is derived by the server.
	CacheHash string `json:"cache_hash,omitempty"`
	CacheKey  string `json:"cache_key,omitempty"`
}

type topMove struct {
	Move string  `json:"move"`
	Prob float64 `json:"prob"`
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
	if err := store.ensureV2Cache(); err != nil {
		log.Fatalf("open evaluation cache: %v", err)
	}
	app := &server{pool: NewEnginePool(large, small), staticDir: staticDir, store: store,
		evaluator: NewEvaluator(python, getenv("STOCKFISH_WORKER", "/app/stockfish_worker.py"), getenv("STOCKFISH_BINARY", "/app/stockfish"))}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", app.healthz)
	mux.HandleFunc("/move", app.move)
	mux.HandleFunc("/evaluate", app.evaluate)
	mux.HandleFunc("/games", app.games)
	mux.HandleFunc("/games/", app.gameByID)
	mux.HandleFunc("/evaluations", app.evaluations)
	mux.HandleFunc("/evaluations/", app.evaluations)
	mux.HandleFunc("/evaluations/lookup", app.evaluationLookup)
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

func (s *server) move(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "POST is required")
		return
	}

	started := time.Now()
	rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
	w = rec
	var request moveRequest
	model, degraded := "", false
	defer func() {
		log.Printf("move status=%d plies=%d model=%s degraded=%t duration_ms=%d",
			rec.status, len(request.Moves), model, degraded, time.Since(started).Milliseconds())
	}()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must be a valid JSON object")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must contain one JSON object")
		return
	}
	engineRequest, validated, err := validateMoveRequest(request)
	if err != nil {
		var reqErr *requestError
		if errors.As(err, &reqErr) {
			writeAPIError(w, http.StatusBadRequest, reqErr.Code, reqErr.Message)
			return
		}
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "request validation failed")
		return
	}
	model = validated

	// Cache lookup runs before the worker pool is touched: hits must never
	// occupy an inference slot. Only deterministic (temperature 0) requests
	// participate: sampled moves vary per call, so they are neither served
	// from nor filed under the shared key. Degraded rows are stand-ins, and
	// the served model must equal the requested one.
	useCache := request.Temperature == 0
	if useCache {
		if cached, ok := s.cachedMaia(engineRequest, model); ok {
			w.Header().Set("X-Eval-Cache", "hit")
			writeJSON(w, http.StatusOK, cached)
			return
		}
	}

	// The client transport may stop waiting on cancellation or deadline. This
	// handler still owns bounded prediction, validation, and cache persistence;
	// its eventual response write may fail after disconnect. Worker admission
	// and operation deadlines remain authoritative, including during fallback.
	result, used, fallback, err := s.pool.predict(context.WithoutCancel(r.Context()), model, engineRequest)
	if err != nil {
		switch {
		case errors.Is(err, ErrWorkerBusy):
			w.Header().Set("Retry-After", "1")
			writeAPIError(w, http.StatusServiceUnavailable, "engine_busy", "the selected Maia3 worker is busy")
		case errors.Is(err, ErrPositionMismatch):
			writeAPIError(w, http.StatusBadRequest, "position_mismatch", "moves do not produce fen")
		case errors.Is(err, ErrInvalidPosition):
			writeAPIError(w, http.StatusBadRequest, "invalid_position", "position or move history is invalid")
		case errors.Is(err, ErrNoLegalMoves):
			writeAPIError(w, http.StatusBadRequest, "game_over", "position has no legal moves")
		default:
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", sanitizeError(err.Error()))
		}
		return
	}
	model, degraded = used, fallback
	response := moveResponse{Move: result.Move, WDL: result.WDL, ModelUsed: used, Degraded: degraded}
	for _, candidate := range result.Candidates {
		response.TopMoves = append(response.TopMoves, topMove{Move: candidate.Move, Prob: candidate.Policy})
	}
	if !validMoveValue(response, validated, useCache) {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "invalid Maia worker response")
		return
	}
	// Only deterministic, non-degraded answers populate the requested model's cache.
	if !degraded && useCache {
		hash, key := maiaIdentity(engineRequest, validated).coordinates()
		s.storeCache(hash, "maia", key, response)
	}
	if useCache {
		w.Header().Set("X-Eval-Cache", "miss")
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
		FEN:         fen,
		Moves:       request.Moves,
		InitialFEN:  initialFEN,
		SelfElo:     *request.EloMaia,
		OppoElo:     *request.EloUser,
		Temperature: request.Temperature,
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
// slowdown diagnosis. Full-game reviews issue one /move + one /evaluate
// per ply, so `docker logs` (Komodo) shows the per-ply latency curve:
// a second-half cliff points at ply-correlated cost (history length,
// hash pressure, thermal), while flat-but-slow lines point at the
// search budget itself (time_ms/lines/depth).
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
