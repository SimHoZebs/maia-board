package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
)

func validTemperature(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= 2
}

type stockfishSettings struct {
	TimeMS int `json:"time_ms"`
	Lines  int `json:"lines"`
	Depth  int `json:"depth"`
}

func (s *stockfishSettings) UnmarshalJSON(data []byte) error {
	type plain stockfishSettings
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, key := range []string{"time_ms", "lines", "depth"} {
		if raw, ok := fields[key]; !ok || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("settings.%s must be an integer", key)
		}
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	return d.Decode((*plain)(s))
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
	return fmt.Sprintf("sf19-ms%d-mpv%d-d%d-t1-h64-v2", s.TimeMS, s.Lines, s.Depth)
}
