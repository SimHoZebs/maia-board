package main

import (
	"fmt"
	"math"
)

func validTemperature(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 2
}

func validateElo(eloMaia, eloUser *int) *requestError {
	if eloMaia == nil || eloUser == nil {
		return &requestError{"missing_elo", "elo_maia and elo_user are required"}
	}
	if *eloMaia < 0 || *eloMaia > 5000 || *eloUser < 0 || *eloUser > 5000 {
		return &requestError{"invalid_elo", "Elo values must be between 0 and 5000"}
	}
	return nil
}

func validateUCIMoves(moves []string) *requestError {
	for _, move := range moves {
		if !uciMovePattern.MatchString(move) {
			return &requestError{"invalid_move", "moves must contain UCI moves"}
		}
	}
	return nil
}

type stockfishSettings struct {
	TimeMS int `json:"time_ms"`
	Lines  int `json:"lines"`
	Depth  int `json:"depth"`
}

func (s *stockfishSettings) UnmarshalJSON(data []byte) error {
	type plain stockfishSettings
	decoded, err := decodeStrict[plain](data, []string{"time_ms", "lines", "depth"}, nil)
	if err != nil {
		return err
	}
	*s = stockfishSettings(decoded)
	return nil
}

func (s *stockfishSettings) validate() *requestError {
	if s != nil && (s.TimeMS < 250 || s.TimeMS > 30000 || s.Lines < 1 || s.Lines > 5 || s.Depth < 0 || s.Depth > 40) {
		return &requestError{"invalid_request", "Stockfish settings require time_ms 250–30000, lines 1–5, and depth 0–40"}
	}
	return nil
}

func (s *stockfishSettings) policy() string {
	if s == nil {
		return SearchPolicy
	}
	return fmt.Sprintf("sf19-ms%d-mpv%d-d%d-t4-h128-v3", s.TimeMS, s.Lines, s.Depth)
}
