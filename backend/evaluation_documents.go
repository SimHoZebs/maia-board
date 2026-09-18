package main

import (
	"encoding/json"
	"strings"
)

func validOwnedCacheValue(hash, engine, key string, encoded []byte) bool {
	if !strings.HasPrefix(key, "v2:") {
		return false
	}
	var identity evaluationIdentity
	if json.Unmarshal([]byte(strings.TrimPrefix(key, "v2:")), &identity) != nil || identity.Engine != engine || identity.Version != 2 {
		return false
	}
	// Never file inconsistent triples: empty histories must root at fen.
	// Non-empty histories rely on worker replay (position_mismatch never stores).
	if len(identity.Moves) == 0 && identity.InitialFEN != identity.FEN {
		return false
	}
	wantHash, wantKey := identity.coordinates()
	if hash != wantHash || key != wantKey {
		return false
	}
	switch engine {
	case "sf":
		response, ok := decodeStrictValue[evaluationResponse](encoded, evalRequired, docAllowNull)
		return ok && identity.Revision == "Stockfish-19" && identity.Policy == identity.Settings.policy() && identity.Settings.validate() == nil && validEvaluationValue(response, identity.Settings)
	case "maia":
		response, ok := decodeStrictValue[moveResponse](encoded, moveRequired, nil)
		return ok && identity.Revision == maiaRevision && !response.Degraded && validMoveValue(response, identity.Model, true)
	}
	return false
}
