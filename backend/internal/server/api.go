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
// games.go, evaluations.go, identity.go, reviews.go, openings.go, auth.go,
// imports.go); every huma.Operation Path literal lives HERE so the lifecycle
// manifest's reverse check (spec/lifecycle-manifest.json -> reverse.routes_file)
// can parse them from this one file.
//
// Error contract: Huma's ErrorModel envelope; our machine-readable codes
// ride in errors[0].message, human text in detail. Route contracts live in
// the generated spec (spec/openapi.yaml).

// apiError builds a Huma error carrying our code in errors[0].message.
func apiError(status int, code, message string) error {
	return huma.NewError(status, message, &huma.ErrorDetail{Message: code})
}

// writeHumaError serializes the same shape for plain-Chi paths that bypass
// Huma handlers: the SSE stream and panic recovery.
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
	r.Use(recoverJSON, securityHeaders, retryAfter, s.authContext)
	r.MethodNotAllowed(methodNotAllowed)

	api := newAPI(r)
	s.registerOps(r, api)

	// POST /imports/games stays hand-rolled Chi: its 200-vs-400-with-body
	// contract (the frontend branches on 400, account.ts) is not
	// Huma-modelable without changing the wire shape. Its spec entry is
	// declared in code below so the generated document stays complete.
	r.Post("/imports/games", s.serveBulkImport)

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
	huma.Register(api, huma.Operation{
		OperationID:   "auth-local",
		Method:        http.MethodPost,
		Path:          "/auth/local",
		Summary:       "Create a local session account",
		DefaultStatus: http.StatusOK,
		MaxBodyBytes:  64 * 1024,
		Errors:        []int{400, 502, 503},
	}, s.serveLocalLogin)
	huma.Register(api, huma.Operation{
		OperationID:   "auth-logout",
		Method:        http.MethodPost,
		Path:          "/auth/logout",
		Summary:       "Revoke the session",
		DefaultStatus: http.StatusNoContent,
	}, s.serveLogout)
	huma.Register(api, huma.Operation{
		OperationID:   "me",
		Method:        http.MethodGet,
		Path:          "/me",
		Summary:       "Current session user",
		DefaultStatus: http.StatusOK,
		Errors:        []int{401, 503},
	}, s.serveMe)
	huma.Register(api, huma.Operation{
		OperationID:   "lichess-start",
		Method:        http.MethodGet,
		Path:          "/auth/lichess/start",
		Summary:       "Begin Lichess OAuth (PKCE S256, scope preference:read)",
		DefaultStatus: http.StatusOK,
		Errors:        []int{400, 501, 502, 503},
	}, s.serveLichessStart)
	huma.Register(api, huma.Operation{
		OperationID:   "lichess-start-post",
		Method:        http.MethodPost,
		Path:          "/auth/lichess/start",
		Summary:       "Begin Lichess OAuth (JSON leg)",
		DefaultStatus: http.StatusOK,
		Errors:        []int{400, 501, 502, 503},
	}, s.serveLichessStart)
	huma.Register(api, huma.Operation{
		OperationID:   "lichess-callback",
		Method:        http.MethodGet,
		Path:          "/auth/lichess/callback",
		Summary:       "Lichess OAuth browser leg (302 back into the app)",
		DefaultStatus: http.StatusFound,
		Errors:        []int{400, 502, 503},
	}, s.serveLichessCallbackGet)
	huma.Register(api, huma.Operation{
		OperationID:   "lichess-callback-post",
		Method:        http.MethodPost,
		Path:          "/auth/lichess/callback",
		Summary:       "Lichess OAuth code exchange (JSON leg)",
		DefaultStatus: http.StatusOK,
		MaxBodyBytes:  64 * 1024,
		Errors:        []int{400, 502, 503},
	}, s.serveLichessCallbackPost)
	huma.Register(api, huma.Operation{
		OperationID:   "imports-status",
		Method:        http.MethodGet,
		Path:          "/imports/status",
		Summary:       "Newest Lichess import run plus owned total",
		DefaultStatus: http.StatusOK,
		Errors:        []int{401, 502},
	}, s.serveImportStatus)

	// The SSE progress stream stays hand-rolled on Chi: Huma's SSE helper
	// commits 200 OK before invoking the handler, so pre-stream 404s (unknown
	// id), 401s, and no-flusher 502s cannot survive migration; after commit,
	// errors would have to become events, rewriting the frontend contract.
	// The stream's spec entry is declared here in code (not hand-edited yaml)
	// so re-dumps stay complete.
	r.Get("/reviews/{id}/events", s.reviews.reviewEvents)
	api.OpenAPI().Paths["/reviews/{id}/events"] = &huma.PathItem{
		Get: &huma.Operation{
			OperationID: "reviews-events",
			Summary:     "Batch progress stream (fast-path; poll is ground truth)",
			Parameters: []*huma.Param{{
				Name:        "id",
				In:          "path",
				Description: "Batch job id",
				Required:    true,
				Schema:      &huma.Schema{Type: huma.TypeString},
			}},
			Responses: map[string]*huma.Response{
				"200": {
					Description: "event: progress ticks with the bare batch status JSON, starting with a snapshot. No replay buffer; Last-Event-ID ignored; counters are cumulative so the latest tick supersedes earlier ones. Heartbeat :ping every 15 s; ends when finished is true.",
					Content: map[string]*huma.MediaType{
						"text/event-stream": {
							Schema: &huma.Schema{Ref: "#/components/schemas/BatchProgress"},
						},
					},
				},
				"404": {Description: "Unknown or evicted job id"},
			},
		},
	}
	// POST /imports/games stays hand-rolled Chi for the same completeness
	// reason: its 200-vs-400-with-body shape is declared here.
	api.OpenAPI().Paths["/imports/games"] = &huma.PathItem{
		Post: &huma.Operation{
			OperationID:   "imports-games",
			Summary:       "Bulk Lichess history append (max 100 entries, 4 MiB)",
			DefaultStatus: http.StatusOK,
			Parameters:    []*huma.Param{},
			Responses: map[string]*huma.Response{
				"200": {
					Description: "200 even when all rows skip (already up to date); 400 when nothing saved and real errors exist",
					Content: map[string]*huma.MediaType{
						"application/json": {},
					},
				},
				"400": {Description: "invalid_request (empty or >100 entries, unknown provider), invalid_source, invalid_opponent, invalid_rating_diff, per-index codes in errors map"},
				"401": {Description: "Unauthenticated"},
			},
		},
	}
}
