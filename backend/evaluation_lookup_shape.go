package main

import (
	"bytes"
	"encoding/json"
	"fmt"
)

func (r *lookupRequest) UnmarshalJSON(data []byte) error {
	type plain lookupRequest
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, key := range []string{"engine", "fen", "initial_fen", "moves"} {
		if _, ok := fields[key]; !ok {
			return fmt.Errorf("%s is required", key)
		}
	}
	for key, raw := range fields {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("%s cannot be null", key)
		}
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	return d.Decode((*plain)(r))
}
