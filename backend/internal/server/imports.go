package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"maia-board/backend/internal/store"
)

// Bulk import lets a verified account append external history (e.g. Lichess
// exports the client fetched) into its own owned store. Every entry is
// validated and saved exactly like POST /games, with ownership forced from
// the session — clients cannot set another owner's rows. Re-running an
// import is safe: entries stamped with an already-imported source are
// skipped, never duplicated.

// maxImportGames bounds one append call: 100 games x 4096 plies would already
// approach the 4 MiB body cap; pagination stays client-side.
const maxImportGames = 100

// importSourcePattern gates the server-owned source stamp: `lichess:<gameId>`
// only. Anything else is a client bug, rejected before it reaches the store.
var importSourcePattern = regexp.MustCompile(`^lichess:[A-Za-z0-9]{4,16}$`)

// importOpponentPattern gates opponent display names: printable text, no
// control characters, bounded so rows stay list-shaped.
var importOpponentPattern = regexp.MustCompile(`^[^\x00-\x1f]{1,64}$`)

// importSpeedValues gates the server-owned speed stamp to known Lichess pools.
var importSpeedValues = map[string]bool{
	"ultrabullet": true, "bullet": true, "blitz": true, "rapid": true,
	"classical": true, "correspondence": true, "unlimited": true,
}

func (s *Server) serveBulkImport(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	if r.Method != http.MethodPost {
		writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if s.store == nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	user, authErr := s.requireUser(r.Context())
	if authErr != nil {
		writeHumaError(w, http.StatusUnauthorized, "unauthenticated", "login is required")
		return
	}
	ownerID := ""
	if user != nil {
		ownerID = user.ID
	}
	var body struct {
		Games    []store.GamePayload `json:"games"`
		Provider string              `json:"provider"`
		Username string              `json:"username"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024*1024)).Decode(&body); err != nil {
		writeHumaError(w, http.StatusBadRequest, "invalid_request", "request body is invalid")
		return
	}
	if body.Provider != "" && body.Provider != "lichess" {
		writeHumaError(w, http.StatusBadRequest, "invalid_request", "provider must be lichess")
		return
	}
	if len(body.Games) < 1 || len(body.Games) > maxImportGames {
		writeHumaError(w, http.StatusBadRequest, "invalid_request", "games must contain 1-100 entries")
		return
	}
	sources := make([]string, 0, len(body.Games))
	for index := range body.Games {
		source := body.Games[index].Source
		if source == "" {
			continue
		}
		if !importSourcePattern.MatchString(source) {
			writeHumaError(w, http.StatusBadRequest, "invalid_source", "game source must be lichess:<gameId>")
			return
		}
		if opponent := body.Games[index].Opponent; opponent != "" && !importOpponentPattern.MatchString(opponent) {
			writeHumaError(w, http.StatusBadRequest, "invalid_opponent", "game opponent must be 1-64 printable characters")
			return
		}
		if speed := body.Games[index].Speed; speed != nil && *speed != "" && !importSpeedValues[*speed] {
			writeHumaError(w, http.StatusBadRequest, "invalid_speed", "game speed must be a Lichess pool")
			return
		}
		sources = append(sources, source)
	}
	known, err := s.store.ExistingSources(ownerID, sources)
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	saved := make([]store.GameRow, 0, len(body.Games))
	errs := make(map[string]string)
	skipped, isNew, refreshed := 0, 0, 0
	for index := range body.Games {
		entry := body.Games[index]
		if entry.Source != "" && known[entry.Source] {
			// Re-imports refresh fields on rows saved before they existed;
			// refreshed counts rows that actually gained a field.
			touched := false
			if entry.Opponent != "" {
				if ok, _ := s.store.UpdateOpponentIfEmpty(ownerID, entry.Source, entry.Opponent); ok {
					touched = true
				}
			}
			if entry.RatingDiff != nil {
				if ok, _ := s.store.UpdateRatingDiffIfEmpty(ownerID, entry.Source, entry.RatingDiff); ok {
					touched = true
				}
			}
			if ok, _ := s.store.UpdateTimeControlIfEmpty(ownerID, entry.Source, entry.TimeControl, entry.Speed); ok {
				touched = true
			}
			if ok, _ := s.store.UpdateClocksIfEmpty(ownerID, entry.Source, entry.Clocks); ok {
				touched = true
			}
			if touched {
				refreshed++
			}
			skipped++
			continue
		}
		entry.OwnerID = ownerID
		entry.Current = false
		if err := store.ValidateGamePayload(&entry); err != nil {
			errs[strconv.Itoa(index)] = err.Code
			continue
		}
		row, fresh, err := s.store.Save(entry)
		if err != nil {
			if errors.Is(err, store.ErrOwnerMismatch) {
				errs[strconv.Itoa(index)] = "forbidden"
			} else {
				errs[strconv.Itoa(index)] = "engine_unavailable"
			}
			continue
		}
		if entry.Source != "" {
			known[entry.Source] = true
		}
		if fresh {
			isNew++
		}
		saved = append(saved, row)
	}
	if body.Provider != "" {
		if _, err := s.store.RecordImportRun(ownerID, body.Provider, body.Username, len(body.Games), len(saved), skipped+len(errs)); err != nil {
			writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			return
		}
	}
	status := http.StatusOK
	// An all-skipped run is success ("already up to date"), not failure;
	// 400 stays for genuinely invalid batches.
	if len(saved) == 0 && len(errs) > 0 {
		status = http.StatusBadRequest
	}
	log.Printf("import-save status=%d user=%s saved=%d failed=%d skipped=%d new=%d refreshed=%d duration_ms=%d", status, ownerID, len(saved), len(errs), skipped, isNew, refreshed, time.Since(started).Milliseconds())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"saved": saved, "errors": errs, "skipped": skipped, "refreshed": refreshed})
}

// serveImportStatus summarizes the account's history lifecycle: the newest
// import run per provider plus the owned game total. The panel renders from
// this instead of presenting an eternal blank form.
func (s *Server) serveImportStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if s.store == nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	user, authErr := s.requireUser(r.Context())
	if authErr != nil {
		writeHumaError(w, http.StatusUnauthorized, "unauthenticated", "login is required")
		return
	}
	ownerID := ""
	if user != nil {
		ownerID = user.ID
	}
	_, total, err := s.store.ListForUser(1, ownerID)
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	last, err := s.store.LastImportRun(ownerID, "lichess")
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if err != nil {
		_ = json.NewEncoder(w).Encode(map[string]any{"last": nil, "total": total})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"last": last, "total": total})
}

// serveAdoptCount reports how many pre-user rows await adoption, so the UI
// only offers the claim button when it can do something.
func (s *Server) serveAdoptCount(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if s.store == nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	if _, authErr := s.requireUser(r.Context()); authErr != nil {
		writeHumaError(w, http.StatusUnauthorized, "unauthenticated", "login is required")
		return
	}
	unowned, err := s.store.CountUnowned()
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"unowned": unowned})
}

// serveAdopt migrates pre-user history: every unowned game row becomes the
// caller's, and the legacy global current marker moves onto their marker.
// Idempotent; a second account adopts nothing.
func (s *Server) serveAdopt(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	if r.Method != http.MethodPost {
		writeHumaError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
		return
	}
	if s.store == nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	user, authErr := s.requireUser(r.Context())
	if authErr != nil {
		writeHumaError(w, http.StatusUnauthorized, "unauthenticated", "login is required")
		return
	}
	adopted, err := s.store.AdoptLegacyGames(user.ID)
	if err != nil {
		writeHumaError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	log.Printf("import-save status=%d user=%s adopted=%d duration_ms=%d", http.StatusOK, user.ID, adopted, time.Since(started).Milliseconds())
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"adopted": adopted})
}
