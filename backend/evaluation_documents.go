package main

import (
	"encoding/json"
	"strings"
)

// Presence and array lengths are checked before decoding Go value types, which
// otherwise silently turn missing/null numbers into zero and truncate arrays.
func objectFields(value any, names ...string) (map[string]any, bool) {
	m, ok := value.(map[string]any)
	if !ok {
		return nil, false
	}
	for _, name := range names {
		if v, ok := m[name]; !ok || v == nil {
			return nil, false
		}
	}
	return m, true
}
func wdlDocument(value any) bool {
	items, ok := value.([]any)
	if !ok || len(items) != 3 {
		return false
	}
	for _, item := range items {
		if _, ok := item.(float64); !ok {
			return false
		}
	}
	return true
}
func scoreDocument(value any) bool {
	m, ok := objectFields(value, "type", "value")
	if !ok {
		return false
	}
	if m["type"] == "mate" {
		_, ok = objectFields(value, "winning_side")
	}
	return ok
}
func moveDocument(value any) bool {
	m, ok := objectFields(value, "move", "top_moves", "wdl", "model_used", "degraded")
	if !ok || !wdlDocument(m["wdl"]) {
		return false
	}
	items, ok := m["top_moves"].([]any)
	if !ok {
		return false
	}
	for _, item := range items {
		if _, ok := objectFields(item, "move", "prob"); !ok {
			return false
		}
	}
	return true
}
func evaluationDocument(value any) bool {
	m, ok := objectFields(value, "engine", "search_policy", "depth", "score", "lines")
	if !ok || !scoreDocument(m["score"]) {
		return false
	}
	if _, ok := m["terminal"]; !ok {
		return false
	}
	if _, ok := m["best_move"]; !ok {
		return false
	}
	items, ok := m["lines"].([]any)
	if !ok {
		return false
	}
	for _, item := range items {
		line, ok := objectFields(item, "move", "score", "depth")
		if !ok || !scoreDocument(line["score"]) {
			return false
		}
	}
	return true
}

func engineResultDocument(value any) bool {
	m, ok := objectFields(value, "result", "legal_count")
	if !ok {
		return false
	}
	result, ok := objectFields(m["result"], "move", "candidates", "wdl")
	if !ok || !wdlDocument(result["wdl"]) {
		return false
	}
	candidates, ok := result["candidates"].([]any)
	if !ok {
		return false
	}
	for _, candidate := range candidates {
		fields, ok := objectFields(candidate, "move", "policy", "wdl")
		if !ok || !wdlDocument(fields["wdl"]) {
			return false
		}
	}
	return true
}
func validOwnedCacheValue(hash, engine, key string, value any) bool {
	if !strings.HasPrefix(key, "v2:") {
		return false
	}
	var identity evaluationIdentity
	if json.Unmarshal([]byte(strings.TrimPrefix(key, "v2:")), &identity) != nil || identity.Engine != engine || identity.Version != 2 {
		return false
	}
	wantHash, wantKey := identity.coordinates()
	if hash != wantHash || key != wantKey {
		return false
	}
	switch engine {
	case "sf":
		var response evaluationResponse
		return identity.Revision == "Stockfish-19" && identity.Policy == identity.Settings.policy() && identity.Settings.validate() == nil && evaluationDocument(value) && strictDocument(value, &response) && validEvaluationValue(response, identity.Settings)
	case "maia":
		var response moveResponse
		return identity.Revision == maiaRevision && moveDocument(value) && strictDocument(value, &response) && !response.Degraded && validMoveValue(response, identity.Model, true)
	}
	return false
}
