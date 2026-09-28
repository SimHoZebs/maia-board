package engine

import (
	"encoding/json"

	"maia-board/backend/internal/evalcache"
)

// maiaRevision pins the upstream Maia3 implementation cache identity derives
// from. It must match the Dockerfile MAIA3_REF.
const maiaRevision = "1e13597c42d4858b7cfd7cfdae01e297263364b2"

// SFIdentity derives the server-owned v2 identity for a Stockfish request.
func SFIdentity(r EvaluationRequest) evalcache.Identity {
	i := evalcache.BaseIdentity("sf", r.FEN, r.InitialFEN, r.Moves)
	i.Revision = "Stockfish-19"
	if r.Settings != nil {
		raw, err := json.Marshal(r.Settings)
		if err == nil {
			i.Settings = raw
		}
		i.Policy = r.Settings.Policy()
	} else {
		i.Policy = SearchPolicy
	}
	return i
}

// MaiaIdentity derives the server-owned v2 identity for a Maia request on
// the given model.
func MaiaIdentity(r MaiaRequest, model string) evalcache.Identity {
	i := evalcache.BaseIdentity("maia", r.FEN, r.InitialFEN, r.Moves)
	i.Revision, i.SelfElo, i.OppoElo, i.Model = maiaRevision, r.SelfElo, r.OppoElo, model
	// Split rows (value Elos differing from policy Elos) get ValueRev 2 and
	// explicit value coordinates; equal-or-omitted values normalize to the
	// legacy ValueRev-1 key so 2400/2400 display rows dedup with the grading
	// lane and existing cache rows keep hitting.
	if (r.ValueSelfElo != nil && *r.ValueSelfElo != r.SelfElo) ||
		(r.ValueOppoElo != nil && *r.ValueOppoElo != r.OppoElo) {
		i.ValueSelfElo, i.ValueOppoElo, i.ValueRev = r.ValueSelfElo, r.ValueOppoElo, 2
		// Fill the unspecified half from policy so the key is complete even
		// when only one value Elo was supplied (worker defaults the same way).
		if i.ValueSelfElo == nil {
			v := r.SelfElo
			i.ValueSelfElo = &v
		}
		if i.ValueOppoElo == nil {
			v := r.OppoElo
			i.ValueOppoElo = &v
		}
	} else {
		i.ValueRev = 1
	}
	return i
}
