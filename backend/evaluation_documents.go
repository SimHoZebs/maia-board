package main

import (
	"encoding/json"
	"strings"
)

// evaluationDocument preserves the presence-check API for non-owned callers
// (evaluate.go) but delegates to the single strict typed decode path.
func evaluationDocument(value any) bool {
	_, ok := decodeStrictValue[evaluationResponse](value, evalRequired, docAllowNull)
	return ok
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
		response, ok := decodeStrictValue[evaluationResponse](value, evalRequired, docAllowNull)
		return ok && identity.Revision == "Stockfish-19" && identity.Policy == identity.Settings.policy() && identity.Settings.validate() == nil && validEvaluationValue(response, identity.Settings)
	case "maia":
		response, ok := decodeStrictValue[moveResponse](value, moveRequired, nil)
		return ok && identity.Revision == maiaRevision && !response.Degraded && validMoveValue(response, identity.Model, true)
	}
	return false
}
