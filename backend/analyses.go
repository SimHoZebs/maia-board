package main

import (
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Analysis records mark whole-line review batches as complete. Rows are keyed
// by line content (normalized initial FEN plus UCI moves, hashed client-side
// with the same deterministic hash as evaluation cache keys) rather than by
// game id, so pasted PGNs share records without creating game rows, duplicate
// lines share one record, and deleting a game never orphans results. Settings
// are part of the key because Maia output genuinely differs per Elo and model;
// Stockfish keys ignore ratings, so post-change restores still hit its cache.
var (
	analysesMaxLines     = 200
	analysesBodyMaxBytes = 4096
	analysisHashPattern  = regexp.MustCompile(`^[0-9a-f]{16}$`)
	analysisPolicyMaxLen = 256
	analysisMaxPositions = 257
)

type analysisSettings struct {
	EloMaia      int    `json:"elo_maia"`
	EloUser      int    `json:"elo_user"`
	Model        string `json:"model"`
	SearchPolicy string `json:"search_policy"`
	MaiaRef      string `json:"maia_ref"`
}

type analysisRecord struct {
	LineHash    string           `json:"line_hash"`
	Settings    analysisSettings `json:"settings"`
	Positions   int              `json:"positions"`
	Failed      int              `json:"failed"`
	CompletedAt string           `json:"completed_at"`
}

type analysisPut struct {
	Settings  analysisSettings `json:"settings"`
	Positions int              `json:"positions"`
	Failed    int              `json:"failed"`
}

func validAnalysisPut(put *analysisPut) *requestError {
	settings := put.Settings
	if settings.EloMaia < 0 || settings.EloMaia > 5000 || settings.EloUser < 0 || settings.EloUser > 5000 {
		return &requestError{"invalid_elo", "Elo values must be between 0 and 5000"}
	}
	if settings.Model != "79m" && settings.Model != "5m" {
		return &requestError{"invalid_model", "model must be lowercase 79m or 5m"}
	}
	if settings.SearchPolicy == "" || len(settings.SearchPolicy) > analysisPolicyMaxLen {
		return &requestError{"invalid_search_policy", "search_policy must be non-empty and short"}
	}
	if settings.MaiaRef == "" || len(settings.MaiaRef) > analysisPolicyMaxLen {
		return &requestError{"invalid_maia_ref", "maia_ref must be non-empty and short"}
	}
	if put.Positions < 0 || put.Positions > analysisMaxPositions {
		return &requestError{"invalid_positions", "positions must be between 0 and 257"}
	}
	if put.Failed < 0 || put.Failed > put.Positions {
		return &requestError{"invalid_failed", "failed must be between 0 and positions"}
	}
	return nil
}

// settingsKey serializes with fixed struct field order, so equal settings
// always produce the identical key string without separator escaping issues.
func settingsKey(settings analysisSettings) string {
	encoded, _ := json.Marshal(settings)
	return string(encoded)
}

func scanAnalysis(scanner gameScanner, lineHash string) (analysisRecord, error) {
	var record analysisRecord
	var settings string
	record.LineHash = lineHash
	if err := scanner.Scan(&settings, &record.Positions, &record.Failed, &record.CompletedAt); err != nil {
		return analysisRecord{}, err
	}
	if err := json.Unmarshal([]byte(settings), &record.Settings); err != nil {
		return analysisRecord{}, err
	}
	return record, nil
}

func (s *GameStore) recordAnalysis(lineHash, settings string, positions, failed int) (analysisRecord, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := s.db.Exec(`INSERT INTO analyses (line_hash, settings, positions, failed, completed_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (line_hash, settings) DO UPDATE SET positions = excluded.positions,
			failed = excluded.failed, completed_at = excluded.completed_at`,
		lineHash, settings, positions, failed, now); err != nil {
		return analysisRecord{}, err
	}
	var record analysisRecord
	var stored string
	err := s.db.QueryRow(`SELECT settings, positions, failed, completed_at FROM analyses
		WHERE line_hash = ? AND settings = ?`, lineHash, settings).Scan(&stored, &record.Positions, &record.Failed, &record.CompletedAt)
	if err != nil {
		return analysisRecord{}, err
	}
	record.LineHash = lineHash
	if err := json.Unmarshal([]byte(stored), &record.Settings); err != nil {
		return analysisRecord{}, err
	}
	return record, nil
}

func (s *GameStore) lineAnalyses(lineHash string) ([]analysisRecord, error) {
	rows, err := s.db.Query(`SELECT settings, positions, failed, completed_at FROM analyses
		WHERE line_hash = ? ORDER BY completed_at DESC`, lineHash)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []analysisRecord{}
	for rows.Next() {
		record, err := scanAnalysis(rows, lineHash)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}

func (s *GameStore) batchAnalyses(hashes []string) ([]analysisRecord, error) {
	records := []analysisRecord{}
	for _, hash := range hashes {
		rows, err := s.lineAnalyses(hash)
		if err != nil {
			return nil, err
		}
		records = append(records, rows...)
	}
	return records, nil
}

func writeAnalyses(w http.ResponseWriter, records []analysisRecord) {
	writeJSON(w, http.StatusOK, map[string]any{"analyses": records})
}

func (s *server) analyses(w http.ResponseWriter, r *http.Request) {
	if s.store == nil {
		writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
		return
	}
	if r.URL.Path == "/analyses" {
		if r.Method != http.MethodGet {
			writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET is required")
			return
		}
		hashes := r.URL.Query()["line"]
		if len(hashes) > analysesMaxLines {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "at most 200 lines per lookup")
			return
		}
		for _, hash := range hashes {
			if !analysisHashPattern.MatchString(hash) {
				writeAPIError(w, http.StatusBadRequest, "invalid_request", "line hashes must be 16 hex characters")
				return
			}
		}
		records, err := s.store.batchAnalyses(hashes)
		if err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			return
		}
		writeAnalyses(w, records)
		return
	}
	hash := strings.TrimPrefix(r.URL.Path, "/analyses/")
	if hash == "" || strings.Contains(hash, "/") {
		writeAPIError(w, http.StatusNotFound, "not_found", "unknown analysis")
		return
	}
	if !analysisHashPattern.MatchString(hash) {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "line hashes must be 16 hex characters")
		return
	}
	switch r.Method {
	case http.MethodGet:
		records, err := s.store.lineAnalyses(hash)
		if err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			return
		}
		writeAnalyses(w, records)
	case http.MethodPut:
		var put analysisPut
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, int64(analysesBodyMaxBytes)))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&put); err != nil {
			writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must be a valid JSON object")
			return
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			writeAPIError(w, http.StatusBadRequest, "invalid_json", "request body must contain one JSON object")
			return
		}
		if err := validAnalysisPut(&put); err != nil {
			writeAPIError(w, http.StatusBadRequest, err.Code, err.Message)
			return
		}
		record, err := s.store.recordAnalysis(hash, settingsKey(put.Settings), put.Positions, put.Failed)
		if err != nil {
			writeAPIError(w, http.StatusBadGateway, "engine_unavailable", "game history is unavailable")
			return
		}
		writeJSON(w, http.StatusOK, record)
	default:
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed", "GET or PUT is required")
	}
}
