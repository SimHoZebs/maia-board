package server

import (
	"context"
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

// Handler is defined in api.go: it builds the Chi+Huma router and wraps it
// with panic recovery and baseline hardening headers.

// recoverJSON catches handler panics and answers Huma-envelope 500s. It runs
// outside the router so panics anywhere (Huma ops, SSE, static) stay JSON.
func recoverJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recovered := recover(); recovered != nil {
				writeHumaError(w, http.StatusInternalServerError, "internal", "the server hit an unexpected error")
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

// retryAfter supplies the backpressure headers Huma errors cannot carry:
// every 503 we emit is engine_busy (retry in 1s) and every 429 is an
// over-cap batch submit (retry in 5s). Explicitly set values win; this only
// fills gaps. Health 503s honestly ask for a 1s retry too.
func retryAfter(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&statusRecorder{ResponseWriter: w, status: http.StatusOK}, r)
	})
}

// statusRecorder captures the response status and injects backpressure
// defaults before the headers go out. Handlers log their own per-request
// timing lines with the status they return, so this stays a dumb observer.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	r.status = status
	if status == http.StatusServiceUnavailable && r.Header().Get("Retry-After") == "" {
		r.Header().Set("Retry-After", "1")
	}
	if status == http.StatusTooManyRequests && r.Header().Get("Retry-After") == "" {
		r.Header().Set("Retry-After", "5")
	}
	r.ResponseWriter.WriteHeader(status)
}

func (s *Server) frontend(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or HEAD is required")
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

// HealthBody is the /healthz document. Status is dynamic: 200 normally,
// 503 when every model failed.
type HealthBody struct {
	Status string                         `json:"status"`
	Models map[string]engine.WorkerStatus `json:"models"`
}

// HealthOutput is the pool-health document. Status is dynamic: 200 normally,
// 503 when every model failed.
type HealthOutput struct {
	Status int `json:"-"`
	Body   HealthBody
}

func (s *Server) handleHealth(ctx context.Context, _ *struct{}) (*HealthOutput, error) {
	status, models, code := s.pool.Health()
	out := &HealthOutput{Status: code}
	out.Body.Status = status
	out.Body.Models = models
	return out, nil
}
