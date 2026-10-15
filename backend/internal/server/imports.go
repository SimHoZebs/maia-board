package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"maia-board/backend/internal/store"
)

// Bulk import lets a verified account append external history (e.g. Lichess
// exports the client fetched) into its own owned store. Every entry is
// validated and saved exactly like POST /games, with ownership forced from
// the session — clients cannot set another owner's rows.

// maxImportGames bounds one append call: 100 games x 4096 plies would already
// approach the 4 MiB body cap; pagination stays client-side.
const maxImportGames = 100

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
		Games []store.GamePayload `json:"games"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024*1024)).Decode(&body); err != nil {
		writeHumaError(w, http.StatusBadRequest, "invalid_request", "request body is invalid")
		return
	}
	if len(body.Games) < 1 || len(body.Games) > maxImportGames {
		writeHumaError(w, http.StatusBadRequest, "invalid_request", "games must contain 1-100 entries")
		return
	}
	saved := make([]store.GameRow, 0, len(body.Games))
	errs := make(map[string]string)
	isNew := 0
	for index := range body.Games {
		entry := body.Games[index]
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
		if fresh {
			isNew++
		}
		saved = append(saved, row)
	}
	status := http.StatusOK
	if len(saved) == 0 && len(errs) > 0 {
		status = http.StatusBadRequest
	}
	log.Printf("import-save status=%d user=%s saved=%d failed=%d new=%d duration_ms=%d", status, ownerID, len(saved), len(errs), isNew, time.Since(started).Milliseconds())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"saved": saved, "errors": errs})
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
