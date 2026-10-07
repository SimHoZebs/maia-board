package server

import (
	"encoding/json"
	"log"
	"net/http"
	"os"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
)

// This file owns the HTTP boundary topology: the Chi router, the Huma API
// with every operation's OpenAPI registration, and the shared error shape.
// Handler implementations live with their domains (move.go, evaluate.go,
// games.go, evaluations.go, identity.go, reviews.go, openings.go); every
// huma.Operation Path literal lives HERE so the lifecycle manifest's
// reverse check (spec/lifecycle-manifest.json -> reverse.routes_file) can
// parse them from this one file.
//
// Error contract: Huma's ErrorModel envelope
// {title, status, detail, errors}. Our machine-readable code vocabulary
// (engine_busy, superseded, invalid_fen, ...) rides in errors[0].message so
// clients keep switching on codes while the envelope is Huma-native. Human
// text rides in detail. Huma's own request errors (malformed JSON -> 400,
// schema violations like unknown fields or missing required keys -> 422,
// oversized bodies -> 413) carry no code and read as 'unknown' client-side.

// apiError builds a Huma error carrying our code in errors[0].message.
func apiError(status int, code, message string) error {
	return huma.NewError(status, message, &huma.ErrorDetail{Message: code})
}

// writeHumaError serializes the same shape for plain-Chi paths that bypass
// Huma handlers: the SSE stream, 405/404 shims, and panic recovery.
func writeHumaError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(huma.NewError(status, message, &huma.ErrorDetail{Message: code})); err != nil {
		log.Printf("http response encoding/write failed: %v", err)
	}
}

// methodNotAllowed answers Chi's MethodNotAllowed hook with a Huma 405
// carrying our method_not_allowed code (the envelope tests pin the code,
// not the wording).
func methodNotAllowed(w http.ResponseWriter, _ *http.Request) {
	writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
}

// Handler wraps the Chi+Huma router with panic recovery and baseline
// hardening headers (same position as before: outermost, so even recovery
// JSON carries the headers).
func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	// recoverJSON first (= outermost): panics anywhere stay JSON.
	r.Use(recoverJSON, securityHeaders, retryAfter)
	r.MethodNotAllowed(methodNotAllowed)

	api := newAPI(r)
	s.registerOps(r, api)

	// SPA fallback: any other unmatched path serves the frontend shell.
	r.NotFound(s.frontend)
	return r
}

func newAPI(r chi.Router) huma.API {
	config := huma.DefaultConfig("Maia Board", "1.0.0")
	// Only the machine-readable spec is served (/openapi.json, /openapi.yaml
	// for Orval codegen). No interactive docs UI, no schema browser.
	config.DocsPath = ""
	config.SchemasPath = ""
	return humachi.New(r, config)
}

// DumpOpenAPI writes the OpenAPI document backing /openapi.json to path,
// for Orval codegen without booting engines. Registration touches no Server
// fields, so a zero Server is enough.
func DumpOpenAPI(path string) error {
	r := chi.NewRouter()
	api := newAPI(r)
	(&Server{}).registerOps(r, api)
	spec, err := api.OpenAPI().YAML()
	if err != nil {
		return err
	}
	return os.WriteFile(path, spec, 0o644)
}

func (s *Server) registerOps(r chi.Router, api huma.API) {
	huma.Register(api, huma.Operation{
		OperationID:   "move",
		Method:        http.MethodPost,
		Path:          "/move",
		Summary:       "Live Maia game reply (Play lane)",
		DefaultStatus: http.StatusOK,
		MaxBodyBytes:  64 * 1024,
		Errors:        []int{400, 409, 502, 503},
	}, s.handleMovePlay)
	huma.Register(api, huma.Operation{
		OperationID:   "move-analysis",
		Method:        http.MethodPost,
		Path:          "/move/analysis",
		Summary:       "Retrospective Maia analysis (Focus lane)",
		DefaultStatus: http.StatusOK,
		MaxBodyBytes:  64 * 1024,
		Errors:        []int{400, 409, 502, 503},
	}, s.handleMoveFocus)
	huma.Register(api, huma.Operation{
		OperationID:   "evaluate",
		Method:        http.MethodPost,
		Path:          "/evaluate",
		Summary:       "Stockfish search (Focus lane)",
		DefaultStatus: http.StatusOK,
		MaxBodyBytes:  64 * 1024,
		Errors:        []int{400, 502, 503},
	}, s.handleEvaluate)
	huma.Register(api, huma.Operation{
		OperationID:   "games-list",
		Method:        http.MethodGet,
		Path:          "/games",
		Summary:       "List saved games with paging",
		DefaultStatus: http.StatusOK,
		Errors:        []int{400, 502},
	}, s.handleGamesList)
	huma.Register(api, huma.Operation{
		OperationID:   "games-create",
		Method:        http.MethodPost,
		Path:          "/games",
		Summary:       "Save a game (upsert by id)",
		DefaultStatus: http.StatusOK,
		MaxBodyBytes:  64 * 1024,
		Errors:        []int{400, 502},
	}, s.handleGamesCreate)
	huma.Register(api, huma.Operation{
		OperationID:   "games-get",
		Method:        http.MethodGet,
		Path:          "/games/{id}",
		Summary:       "Fetch one saved game",
		DefaultStatus: http.StatusOK,
		Errors:        []int{404, 502},
	}, s.handleGameGet)
	huma.Register(api, huma.Operation{
		OperationID:   "games-delete",
		Method:        http.MethodDelete,
		Path:          "/games/{id}",
		Summary:       "Delete one saved game",
		DefaultStatus: http.StatusNoContent,
		Errors:        []int{502},
	}, s.handleGameDelete)
	huma.Register(api, huma.Operation{
		OperationID:   "evaluations-stats",
		Method:        http.MethodGet,
		Path:          "/evaluations/stats",
		Summary:       "Evaluation cache stats",
		DefaultStatus: http.StatusOK,
		Errors:        []int{502},
	}, s.handleEvalStats)
	huma.Register(api, huma.Operation{
		OperationID:   "evaluations-get",
		Method:        http.MethodGet,
		Path:          "/evaluations/{hash}",
		Summary:       "Fetch one cached evaluation by key hash",
		DefaultStatus: http.StatusOK,
		Errors:        []int{400, 404, 502},
	}, s.handleEvalGet)
	huma.Register(api, huma.Operation{
		OperationID:   "evaluations-lookup",
		Method:        http.MethodPost,
		Path:          "/evaluations/lookup",
		Summary:       "Bulk cache read (read-only, never admits or infers)",
		DefaultStatus: http.StatusOK,
		MaxBodyBytes:  4 * 1024 * 1024,
		Errors:        []int{400},
	}, s.handleEvalLookup)
	huma.Register(api, huma.Operation{
		OperationID:   "openings",
		Method:        http.MethodPost,
		Path:          "/openings",
		Summary:       "ECO opening names for a move line",
		DefaultStatus: http.StatusOK,
		MaxBodyBytes:  64 * 1024,
		Errors:        []int{400, 502},
	}, s.handleOpenings)
	huma.Register(api, huma.Operation{
		OperationID:   "reviews-submit",
		Method:        http.MethodPost,
		Path:          "/reviews",
		Summary:       "Submit a whole-game batch review",
		DefaultStatus: http.StatusAccepted,
		MaxBodyBytes:  4 * 1024 * 1024,
		Errors:        []int{400, 429, 502},
	}, s.reviews.handleSubmit)
	huma.Register(api, huma.Operation{
		OperationID:   "reviews-status",
		Method:        http.MethodGet,
		Path:          "/reviews/{id}",
		Summary:       "Batch progress (ground truth; the stream is fast-path only)",
		DefaultStatus: http.StatusOK,
		Errors:        []int{404},
	}, s.reviews.handleStatus)
	huma.Register(api, huma.Operation{
		OperationID:   "healthz",
		Method:        http.MethodGet,
		Path:          "/healthz",
		Summary:       "Engine pool health",
		DefaultStatus: http.StatusOK,
	}, s.handleHealth)

	// The SSE progress stream stays hand-rolled on Chi: Huma's SSE helper
	// cannot answer pre-stream 404s, and the framing (named progress events
	// plus :ping heartbeats the client ignores) is load-bearing.
	r.Get("/reviews/{id}/events", s.reviews.reviewEvents)
	// Empty-id and legacy shims answer 404 exactly like the old prefix
	// mux did (id check ran before the method switch there).
	r.Handle("/games/", notFound("unknown game"))
	r.Get("/reviews/", notFound("unknown review batch"))
	r.Get("/evaluations", notFound("unknown evaluation"))
	r.Get("/evaluations/", notFound("unknown evaluation"))
}

// notFound answers exact-path shims with a Huma 404. The detail wording
// matches the old prefix-mux messages.
func notFound(message string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeHumaError(w, http.StatusNotFound, "not_found", message)
	}
}
