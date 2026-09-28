package engine

import (
	"fmt"

	"maia-board/backend/internal/apierror"
	"maia-board/backend/internal/chess"
	"maia-board/backend/internal/evalcache"
)

// StockfishSettings bounds one search: wall-clock budget, candidate lines,
// and optional fixed depth.
type StockfishSettings struct {
	TimeMS int `json:"time_ms"`
	Lines  int `json:"lines"`
	Depth  int `json:"depth"`
}

func (s *StockfishSettings) UnmarshalJSON(data []byte) error {
	type plain StockfishSettings
	decoded, err := evalcache.DecodeStrict[plain](data, []string{"time_ms", "lines", "depth"}, nil)
	if err != nil {
		return err
	}
	*s = StockfishSettings(decoded)
	return nil
}

// Validate rejects out-of-range search budgets.
func (s *StockfishSettings) Validate() *apierror.RequestError {
	if s != nil && (s.TimeMS < 250 || s.TimeMS > 30000 || s.Lines < 1 || s.Lines > 5 || s.Depth < 0 || s.Depth > 40) {
		return &apierror.RequestError{Code: "invalid_request", Message: "Stockfish settings require time_ms 250–30000, lines 1–5, and depth 0–40"}
	}
	return nil
}

// Policy names the search budget for cache identity and provenance. Nil
// settings mean the legacy timed default.
func (s *StockfishSettings) Policy() string {
	if s == nil {
		return SearchPolicy
	}
	return fmt.Sprintf("sf19-ms%d-mpv%d-d%d-t4-h128-v3", s.TimeMS, s.Lines, s.Depth)
}

// validScore checks a score's ranges and side consistency.
func validScore(s EvaluationScore) bool {
	switch s.Type {
	case "cp":
		return s.Value >= -100000 && s.Value <= 100000 && s.WinningSide == ""
	case "mate":
		return s.Value >= -1000 && s.Value <= 1000 && ((s.WinningSide == "white" && s.Value >= 0) || (s.WinningSide == "black" && s.Value <= 0))
	}
	return false
}

// ValidEvaluationValue checks a Stockfish document's semantic ranges.
func ValidEvaluationValue(v EvaluationResponse, settings *StockfishSettings) bool {
	limit := 2
	if settings != nil {
		limit = settings.Lines
	}
	if v.Engine != "Stockfish 19" || v.SearchPolicy != settings.Policy() || v.Depth < 0 || v.Depth > 256 || !validScore(v.Score) || v.Lines == nil || len(v.Lines) > limit {
		return false
	}
	if v.ActualSettings != nil && (settings == nil || *v.ActualSettings != *settings) {
		return false
	}
	if v.Terminal != nil {
		if len(v.Lines) != 0 || v.BestMove != nil || v.Depth != 0 {
			return false
		}
		return (*v.Terminal == "draw" && v.Score.Type == "cp" && v.Score.Value == 0) || (*v.Terminal == v.Score.WinningSide+"_win" && v.Score.Type == "mate" && v.Score.Value == 0)
	}
	if len(v.Lines) == 0 || v.Depth < 1 || v.BestMove == nil || *v.BestMove != v.Lines[0].Move || v.Score != v.Lines[0].Score {
		return false
	}
	seen := map[string]bool{}
	for index, line := range v.Lines {
		if !chess.UCIMovePattern.MatchString(line.Move) || seen[line.Move] || line.Depth != v.Depth || (settings != nil && settings.Depth > 0 && line.Depth > settings.Depth) || !validScore(line.Score) {
			return false
		}
		seen[line.Move] = true
		// PV is shape-only here (Go has no board replay): 1-5 UCI with
		// PV[0]==Move. Rank-1 only by construction; lower ranks must omit
		// it. Full legality is enforced frontend where the FEN is available.
		// Worker + Go ship in one image so no mixed-version PV traffic occurs.
		if index == 0 {
			if line.PV != nil {
				if len(line.PV) < 1 || len(line.PV) > 5 || line.PV[0] != line.Move {
					return false
				}
				for _, pvMove := range line.PV {
					if !chess.UCIMovePattern.MatchString(pvMove) {
						return false
					}
				}
			}
		} else if line.PV != nil {
			return false
		}
	}
	return true
}
