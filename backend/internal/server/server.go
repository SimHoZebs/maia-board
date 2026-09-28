package server

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/openings"
	"maia-board/backend/internal/store"
)

// Server owns the HTTP boundary and orchestrates engines, persistence, batch
// jobs, and openings. The engine pool, evaluator, store, and openings lookup
// are constructed by the caller (cmd/server); ReviewJobs is built here since
// it is pure orchestration over this Server.
type Server struct {
	pool      *engine.EnginePool
	staticDir string
	evaluator *engine.Evaluator
	store     *store.GameStore
	reviews   *ReviewJobs
	openings  *openings.OpeningsLookup
}

// NewServer wires a Server; ReviewJobs starts empty (jobs are in-memory,
// finished plies persist in the store).
func NewServer(pool *engine.EnginePool, evaluator *engine.Evaluator, gameStore *store.GameStore, lookup *openings.OpeningsLookup, staticDir string) *Server {
	s := &Server{pool: pool, staticDir: staticDir, store: gameStore, evaluator: evaluator, openings: lookup}
	s.reviews = NewReviewJobs(s)
	return s
}

// Routes registers every endpoint. Lane mapping is endpoint-implied:
// /move → Play, /move/analysis + /evaluate → Focus, /reviews → Batch.
func (s *Server) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.healthz)
	mux.HandleFunc("/move", s.move)
	mux.HandleFunc("/move/analysis", s.moveAnalysis)
	mux.HandleFunc("/evaluate", s.evaluate)
	mux.HandleFunc("/games", s.games)
	mux.HandleFunc("/games/", s.gameByID)
	mux.HandleFunc("/evaluations", s.evaluations)
	mux.HandleFunc("/evaluations/", s.evaluations)
	mux.HandleFunc("/evaluations/lookup", s.evaluationLookup)
	mux.HandleFunc("/openings", s.openingsHandler)
	mux.HandleFunc("/reviews", s.reviews.reviews)
	mux.HandleFunc("/reviews/", s.reviews.reviewRouter)
	mux.HandleFunc("/", s.frontend)
	return mux
}

// Handler wraps Routes with panic recovery and baseline hardening headers.
func (s *Server) Handler() http.Handler {
	return recoverJSON(securityHeaders(s.Routes()))
}

func recoverJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				writeAPIError(w, http.StatusInternalServerError, "internal", "the server hit an unexpected error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// securityHeaders sets baseline hardening headers for the same-origin
// static app and JSON API. It runs inside recoverJSON so panic-recovery
// JSON errors carry the same headers, and it only sets headers the
// handlers never override — existing Cache-Control logic is untouched.
// No HSTS: TLS terminates at Traefik, not this server, so this server
// must not emit Strict-Transport-Security.
// CSP stays minimal (default-src 'self', plus data: for images):
// frontend/index.html has no inline scripts (single external module
// script; Vite build emits hashed external assets under assets/), and
// same-origin API/SSE fall back to default-src. img-src needs data:
// because chessground paints board squares and pieces from embedded
// data: SVG backgrounds (chessground.brown.css, chessground.cburnett.css);
// without it the board renders as a blank peach square with no pieces.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) frontend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or HEAD is required")
		return
	}

	requested := strings.TrimPrefix(filepath.Clean("/"+r.URL.Path), "/")
	filePath := filepath.Join(s.staticDir, filepath.FromSlash(requested))
	if requested != "" {
		if info, err := os.Stat(filePath); err == nil && !info.IsDir() {
			// Vite emits content-hashed filenames under assets/; those
			// bytes are immutable, so browsers may cache them for a year.
			// Everything else (including the index fallback below) revalidates.
			if strings.HasPrefix(requested, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			http.ServeFile(w, r, filePath)
			return
		}
	}

	indexPath := filepath.Join(s.staticDir, "index.html")
	if _, err := os.Stat(indexPath); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, indexPath)
}

func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or HEAD is required")
		return
	}
	status, models, code := s.pool.Health()
	writeJSON(w, code, map[string]any{"status": status, "models": models})
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

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("http response encoding/write failed: %v", err)
	}
}
