package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http/httptest"
	"strings"
	"testing"

	"maia-board/backend/internal/engine"
	"maia-board/backend/internal/evalcache"
	"maia-board/backend/internal/store"
)

func sfFixture(settings *engine.StockfishSettings, score int) engine.EvaluationResponse {
	count := 2
	if settings != nil {
		count = settings.Lines
	}
	moves := []string{"e2e4", "d2d4", "g1f3", "c2c4", "b1c3"}
	value := engine.EvaluationResponse{Engine: "Stockfish 19", SearchPolicy: settings.Policy(), Depth: 8, Score: engine.EvaluationScore{Type: "cp", Value: score}, BestMove: &moves[0], Lines: []engine.EvaluationLine{}}
	for _, move := range moves[:count] {
		value.Lines = append(value.Lines, engine.EvaluationLine{Move: move, Score: value.Score, Depth: 8})
	}
	return value
}
func seedSF(t *testing.T, s *Server, r engine.EvaluationRequest, score int) {
	t.Helper()
	hash, key := engine.SFIdentity(r).Coordinates()
	s.storeCache(hash, "sf", key, sfFixture(r.Settings, score))
	if _, err := s.store.CacheGet(hash); err != nil {
		t.Fatalf("producer rejected fixture: %v", err)
	}
}
func testLine() BatchLine {
	return BatchLine{InitialFEN: startFEN, Moves: []string{}}
}
func lookup(t *testing.T, s *Server, line BatchLine, requests []LookupRequest) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(map[string]any{"line": line, "requests": requests})
	if err != nil {
		t.Fatal(err)
	}
	return serve(s, "POST", "/evaluations/lookup", string(data))
}
func lookupDefault(t *testing.T, s *Server, requests []LookupRequest) *httptest.ResponseRecorder {
	t.Helper()
	return lookup(t, s, testLine(), requests)
}
func lookupValues(t *testing.T, w *httptest.ResponseRecorder) []LookupResult {
	t.Helper()
	if w.Code != 200 {
		t.Fatalf("lookup status %d: %s", w.Code, w.Body)
	}
	var body struct {
		Results []LookupResult `json:"results"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Results == nil {
		t.Fatal("null results")
	}
	return body.Results
}

// strictEvalResponse decodes a lookup-returned value through the single
// strict entry. The marshal is test-only (tests hold any after JSON
// round-trips); production threads raw bytes with no re-marshal.
func strictEvalResponse(t *testing.T, value any) (engine.EvaluationResponse, bool) {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return evalcache.DecodeStrictValue[engine.EvaluationResponse](data, engine.EvalRequired, engine.DocAllowNull)
}
func TestLookupCompatibleSettingsPreserveActualProvenance(t *testing.T) {
	s := &Server{store: testStore(t)}
	large := &engine.StockfishSettings{TimeMS: 750, Lines: 5, Depth: 8}
	r := engine.EvaluationRequest{FEN: startFEN, Moves: []string{}, Settings: large}
	seedSF(t, s, r, 55)
	query := LookupRequest{Engine: "sf", FEN: startFEN, Ply: 0, Settings: &engine.StockfishSettings{TimeMS: 750, Lines: 2, Depth: 8}}
	rows := lookupValues(t, lookupDefault(t, s, []LookupRequest{query}))
	if len(rows) != 1 || rows[0].Index != 0 || rows[0].ActualSettings == nil || *rows[0].ActualSettings != *large {
		t.Fatalf("provenance %+v", rows)
	}
	var value engine.EvaluationResponse
	var ok bool
	value, ok = strictEvalResponse(t, rows[0].Value)
	if !ok || value.SearchPolicy != large.Policy() || len(value.Lines) != 2 || value.ActualSettings == nil || *value.ActualSettings != *large {
		t.Fatalf("compatible value %+v", value)
	}
	// Live endpoint exposes the same provenance; reuse never produces a new row
	// with the requested smaller policy stamped onto a larger native search.
	requested := engine.EvaluationRequest{FEN: startFEN, Moves: []string{}, Settings: query.Settings}
	data, _ := json.Marshal(requested)
	w := serve(s, "POST", "/evaluate", string(data))
	if w.Code != 200 || w.Header().Get("X-Eval-Cache") != "hit" {
		t.Fatal(w)
	}
	var live engine.EvaluationResponse
	if json.Unmarshal(w.Body.Bytes(), &live) != nil || live.SearchPolicy != large.Policy() || live.ActualSettings == nil || *live.ActualSettings != *large {
		t.Fatalf("live provenance %s", w.Body)
	}
	hash, _ := engine.SFIdentity(requested).Coordinates()
	if _, err := s.store.CacheGet(hash); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("restamped reuse: %v", err)
	}
	seedSF(t, s, requested, 99)
	rows = lookupValues(t, lookupDefault(t, s, []LookupRequest{query}))
	value, ok = strictEvalResponse(t, rows[0].Value)
	if !ok || value.Score.Value != 99 || value.SearchPolicy != query.Settings.Policy() || *rows[0].ActualSettings != *query.Settings {
		t.Fatalf("exact search did not win: %+v", rows)
	}
}
func TestLookupSettingsAndCompleteHistoryIsolation(t *testing.T) {
	s := &Server{store: testStore(t)}
	settings := &engine.StockfishSettings{TimeMS: 750, Lines: 3, Depth: 8}
	seedSF(t, s, engine.EvaluationRequest{FEN: startFEN, Settings: settings}, 10)
	base := LookupRequest{Engine: "sf", FEN: startFEN, Ply: 0, Settings: settings}
	queries := []LookupRequest{base}
	for _, mutate := range []func(*LookupRequest){
		func(q *LookupRequest) { q.Settings = &engine.StockfishSettings{TimeMS: 1000, Lines: 3, Depth: 8} },
		func(q *LookupRequest) { q.Settings = &engine.StockfishSettings{TimeMS: 750, Lines: 3, Depth: 9} },
		func(q *LookupRequest) { q.Settings = &engine.StockfishSettings{TimeMS: 750, Lines: 4, Depth: 8} },
		func(q *LookupRequest) { q.Settings = nil },
		func(q *LookupRequest) { q.Ply = 4 },
	} {
		q := base
		mutate(&q)
		queries = append(queries, q)
	}
	line := BatchLine{InitialFEN: startFEN, Moves: []string{"g1f3", "g8f6", "f3g1", "f6g8"}}
	rows := lookupValues(t, lookup(t, s, line, queries))
	if len(rows) != 1 || rows[0].Index != 0 {
		t.Fatalf("cross-key hit: %+v", rows)
	}
	// A normalized request shares identity with the real inference route.
	base.FEN = "  " + strings.ReplaceAll(startFEN, " ", "  ") + " "
	if len(lookupValues(t, lookupDefault(t, s, []LookupRequest{base}))) != 1 {
		t.Fatal("whitespace altered identity")
	}
}

// Inconsistent triples (empty history rooting away from fen) are rejected
// at validation and never filed: lookup/bulk paths 400, and no row appears.
func TestInconsistentTripleRejectedNeverFiled(t *testing.T) {
	s := &Server{store: testStore(t)}
	badInitial := strings.Replace(startFEN, "0 1", "1 1", 1)
	// Ply-0 entries rooting away from the shared line initial.
	for _, line := range []BatchLine{
		{InitialFEN: badInitial, Moves: []string{}},
		{InitialFEN: startFEN, Moves: []string{}},
	} {
		fen := startFEN
		if line.InitialFEN == startFEN {
			fen = badInitial
		}
		q := LookupRequest{Engine: "sf", FEN: fen, Ply: 0, Settings: &engine.StockfishSettings{TimeMS: 750, Lines: 3, Depth: 8}}
		w := lookup(t, s, line, []LookupRequest{q})
		if w.Code != 400 {
			t.Fatalf("inconsistent lookup status %d: %s", w.Code, w.Body)
		}
	}
	// /evaluate with empty moves + mismatched root is 400.
	w := serve(s, "POST", "/evaluate",
		fmt.Sprintf(`{"fen":%q,"initial_fen":%q,"moves":[]}`, startFEN, badInitial))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "position_mismatch") {
		t.Fatalf("evaluate inconsistent %d %s", w.Code, w.Body)
	}
	// validOwnedCacheValue never files empty-history mismatches even when
	// called directly (poisoning guard on the write path).
	r := engine.EvaluationRequest{FEN: startFEN, InitialFEN: badInitial, Moves: []string{}, Settings: &engine.StockfishSettings{TimeMS: 750, Lines: 2, Depth: 8}}
	hash, key := engine.SFIdentity(r).Coordinates()
	fixture, err := json.Marshal(sfFixture(r.Settings, 10))
	if err != nil {
		t.Fatal(err)
	}
	if engine.ValidOwnedCacheValue(hash, "sf", key, fixture) {
		t.Fatal("inconsistent triple passed write guard")
	}
	var rows int
	rows, _, err = s.store.CacheStats()
	if err != nil || rows != 0 {
		t.Fatalf("inconsistent triple filed rows=%d err=%v", rows, err)
	}
}
func TestMaiaLookupModelEloAndLegacyIsolation(t *testing.T) {
	s := &Server{store: testStore(t)}
	elo, other := 1600, 1700
	r := engine.MaiaRequest{FEN: startFEN, SelfElo: elo, OppoElo: elo}
	hash, key := engine.MaiaIdentity(r, "79m").Coordinates()
	value := engine.MoveResponse{Move: "e2e4", TopMoves: []engine.TopMove{{Move: "e2e4", Prob: 1, WDL: [3]float64{.2, .3, .5}}}, WDL: [3]float64{.2, .3, .5}, ModelUsed: "79m"}
	s.storeCache(hash, "maia", key, value)
	base := LookupRequest{Engine: "maia", FEN: startFEN, Ply: 0, EloMaia: &elo, EloUser: &elo, Model: "79m"}
	queries := []LookupRequest{base, base, base, base}
	queries[1].Model, queries[2].EloMaia, queries[3].EloUser = "5m", &other, &other
	rows := lookupValues(t, lookupDefault(t, s, queries))
	if len(rows) != 1 || rows[0].Index != 0 {
		t.Fatalf("model or ratings leaked: %+v", rows)
	}
	// An opaque legacy row with an otherwise perfect value is never promoted.
	legacy := &Server{store: testStore(t)}
	data, _ := json.Marshal(value)
	if _, err := legacy.store.CachePut("abc", "maia", "legacy", string(data)); err != nil {
		t.Fatal(err)
	}
	if rows := lookupValues(t, lookupDefault(t, legacy, []LookupRequest{base})); len(rows) != 0 {
		t.Fatal("trusted legacy row")
	}
}
func TestLookupRejectsMalformedShapeAndBounds(t *testing.T) {
	s := &Server{store: testStore(t)}
	line := `"line":{"initial_fen":"","moves":[]}`
	valid := `{"engine":"sf","ply":0,"fen":"` + startFEN + `"}`
	// Huma validates shape (malformed JSON is a 400, unknown fields and
	// missing required keys are a 422, oversize is a 413); domain rules
	// answer 400 with our code below.
	for name, tc := range map[string]struct {
		body   string
		status int
		code   string
	}{
		"null":                   {body: "null", status: 422},
		"missing":                {body: `{}`, status: 422},
		"null entries":           {body: `{"line":{"initial_fen":"","moves":[]},"requests":null}`, status: 400, code: "invalid_request"},
		"wrong array":            {body: `{"line":{"initial_fen":"","moves":[]},"requests":{}}`, status: 422},
		"null request":           {body: `{"line":{"initial_fen":"","moves":[]},"requests":[null]}`, status: 422},
		"no ply":                 {body: `{"line":{"initial_fen":"","moves":[]},"requests":[{"engine":"sf","fen":"` + startFEN + `"}]}`, status: 422},
		"null ply":               {body: `{"line":{"initial_fen":"","moves":[]},"requests":[` + strings.Replace(valid, `"ply":0`, `"ply":null`, 1) + `]}`, status: 422},
		"no line":                {body: `{"requests":[]}`, status: 422},
		"null line moves":        {body: `{"line":{"initial_fen":"","moves":null},"requests":[]}`, status: 422},
		"no line initial":        {body: `{"line":{"moves":[]},"requests":[]}`, status: 422},
		"bad FEN":                {body: `{"line":{"initial_fen":"","moves":[]},"requests":[` + strings.Replace(valid, startFEN, "garbage", 1) + `]}`, status: 400, code: "invalid_request"},
		"bad line move":          {body: `{"line":{"initial_fen":"","moves":["oops"]},"requests":[]}`, status: 400, code: "invalid_request"},
		"unknown":                {body: `{"line":{"initial_fen":"","moves":[]},"requests":[` + strings.Replace(valid, `"engine":"sf"`, `"engine":"other"`, 1) + `]}`, status: 400, code: "invalid_request"},
		"extra":                  {body: `{"line":{"initial_fen":"","moves":[]},"requests":[],"extra":true}`, status: 422},
		"null settings":          {body: `{"line":{"initial_fen":"","moves":[]},"requests":[` + strings.TrimSuffix(valid, "}") + `,"settings":null}]}`, status: 422},
		"missing settings depth": {body: `{"line":{"initial_fen":"","moves":[]},"requests":[` + strings.TrimSuffix(valid, "}") + `,"settings":{"time_ms":750,"lines":2}}]}`, status: 422},
		"mixed settings":         {body: `{"line":{"initial_fen":"","moves":[]},"requests":[` + strings.TrimSuffix(valid, "}") + `,"elo_maia":1600}]}`, status: 400, code: "invalid_request"},
		"unknown coordinates":    {body: `{"line":{"initial_fen":"","moves":[]},"requests":[` + strings.TrimSuffix(valid, "}") + `,"cache_hash":"abc"}]}`, status: 422},
		"old coordinates":        {body: `{"line":{"initial_fen":"","moves":[]},"requests":[{"engine":"sf","ply":0,"fen":"` + startFEN + `","initial_fen":"","moves":[]}]}`, status: 422},
		"trailing":               {body: `{"line":{"initial_fen":"","moves":[]},"requests":[]} {}`, status: 400},
		"count":                  {body: `{"line":{"initial_fen":"","moves":[]},"requests":[` + strings.Repeat(valid+",", 1024) + valid + `]}`, status: 400, code: "invalid_request"},
		"size":                   {body: `{"line":{"initial_fen":"","moves":[]},"requests":[],"padding":"` + strings.Repeat("x", 4*1024*1024) + `"}`, status: 413},
	} {
		t.Run(name, func(t *testing.T) {
			w := serve(s, "POST", "/evaluations/lookup", tc.body)
			if w.Code != tc.status || (tc.code != "" && humaCode(t, w) != tc.code) {
				t.Fatalf("status %d: %s", w.Code, w.Body)
			}
		})
	}
	_ = line
	requests := make([]LookupRequest, 1024)
	for i := range requests {
		requests[i] = LookupRequest{Engine: "sf", FEN: startFEN, Ply: 0}
	}
	if rows := lookupValues(t, lookup(t, s, BatchLine{InitialFEN: "", Moves: []string{}}, requests)); len(rows) != 0 {
		t.Fatal("cold cache produced results")
	}
	var rows int
	rows, _, err := s.store.CacheStats()
	if err != nil || rows != 0 {
		t.Fatalf("cache-only read wrote rows: %d %v", rows, err)
	}
}
func TestCorruptV2ValuesMissThenRecomputeAndOverwrite(t *testing.T) {
	s := &Server{store: testStore(t), evaluator: fakeEvaluator(t, "ok")}
	r := engine.EvaluationRequest{FEN: startFEN}
	hash, key := engine.SFIdentity(r).Coordinates()
	valid := sfFixture(nil, 20)
	encoded, _ := json.Marshal(valid)
	for _, corrupt := range []string{
		`{`, `{"engine":"Stockfish 19"}`,
		strings.Replace(string(encoded), `"value":20`, `"value":null`, 1),
		strings.Replace(string(encoded), `"type":"cp","value":20`, `"type":"cp"`, 1),
		strings.Replace(string(encoded), `"terminal":null,`, ``, 1),
		strings.Replace(string(encoded), `"depth":8`, `"depth":999`, 1),
		strings.Replace(string(encoded), `"d2d4"`, `"e2e4"`, 1),
		strings.Replace(string(encoded), engine.SearchPolicy, "sf19-ms750-mpv2-d0-t4-h128-v3", 1),
	} {
		if _, err := s.store.CachePut(hash, "sf", key, corrupt); err != nil {
			t.Fatal(err)
		}
		if _, ok := s.cachedSF(r); ok {
			t.Fatalf("corrupt hit: %s", corrupt)
		}
		w := serve(s, "POST", "/evaluate", fmt.Sprintf(`{"fen":%q,"moves":[]}`, startFEN))
		if w.Code != 200 || w.Header().Get("X-Eval-Cache") != "miss" {
			t.Fatalf("repair %d %s", w.Code, w.Body)
		}
		if _, ok := s.cachedSF(r); !ok {
			t.Fatal("recomputed output did not replace corruption")
		}
	}
}
func TestMaiaSplitIdentityIsolatesAndDedups(t *testing.T) {
	v2400 := 2400
	legacy := engine.MaiaRequest{FEN: startFEN, SelfElo: 800, OppoElo: 800}
	split := engine.MaiaRequest{FEN: startFEN, SelfElo: 800, OppoElo: 800, ValueSelfElo: &v2400, ValueOppoElo: &v2400}
	equal := engine.MaiaRequest{FEN: startFEN, SelfElo: 2400, OppoElo: 2400, ValueSelfElo: &v2400, ValueOppoElo: &v2400}
	grading := engine.MaiaRequest{FEN: startFEN, SelfElo: 2400, OppoElo: 2400}
	legacyHash, legacyKey := engine.MaiaIdentity(legacy, "79m").Coordinates()
	splitHash, splitKey := engine.MaiaIdentity(split, "79m").Coordinates()
	equalHash, equalKey := engine.MaiaIdentity(equal, "79m").Coordinates()
	gradingHash, gradingKey := engine.MaiaIdentity(grading, "79m").Coordinates()
	if splitHash == legacyHash || splitKey == legacyKey {
		t.Fatal("split row collides with legacy X/X row")
	}
	if !strings.Contains(splitKey, `"value_rev":2`) {
		t.Fatalf("split identity must bump value_rev: %s", splitKey)
	}
	if equalHash != gradingHash || equalKey != gradingKey {
		t.Fatal("explicit equal value Elos must dedup with omitted values")
	}
	// Half-specified split fills the other half from policy.
	half := engine.MaiaRequest{FEN: startFEN, SelfElo: 800, OppoElo: 800, ValueSelfElo: &v2400}
	_, halfKey := engine.MaiaIdentity(half, "79m").Coordinates()
	if !strings.Contains(halfKey, `"value_self_elo":2400`) || !strings.Contains(halfKey, `"value_oppo_elo":800`) {
		t.Fatalf("half split must fill oppo from policy: %s", halfKey)
	}
}
func TestMaiaIdentityVersionsCandidateWDLShape(t *testing.T) {
	r := engine.MaiaRequest{FEN: startFEN, SelfElo: 1600, OppoElo: 1600}
	_, key := engine.MaiaIdentity(r, "79m").Coordinates()
	if !strings.Contains(key, `"value_rev":1`) {
		t.Fatalf("maia identity must version the candidate-WDL shape: %s", key)
	}
	// A legacy-shaped row (no per-candidate WDL) filed under the new key
	// still misses on validation, so mixed-version caches heal by recompute.
	s := &Server{store: testStore(t)}
	hash, _ := engine.MaiaIdentity(r, "79m").Coordinates()
	legacy := `{"move":"e2e4","top_moves":[{"move":"e2e4","prob":0.8}],"wdl":[0.2,0.3,0.5],"model_used":"79m","degraded":false}`
	if _, err := s.store.CachePut(hash, "maia", key, legacy); err != nil {
		t.Fatal(err)
	}
	if _, ok := s.cachedMaia(r, "79m"); ok {
		t.Fatal("legacy candidate shape hit")
	}
}

func TestCorruptMaiaShapeAndValuesAreMisses(t *testing.T) {
	s := &Server{store: testStore(t)}
	r := engine.MaiaRequest{FEN: startFEN, SelfElo: 1600, OppoElo: 1600}
	hash, key := engine.MaiaIdentity(r, "79m").Coordinates()
	valid := `{"move":"e2e4","top_moves":[{"move":"e2e4","prob":0.8,"wdl":[0.3,0.3,0.4]}],"wdl":[0.2,0.3,0.5],"model_used":"79m","degraded":false}`
	for _, corrupt := range []string{
		strings.Replace(valid, `,"prob":0.8`, "", 1),
		strings.Replace(valid, `0.8`, `null`, 1),
		strings.Replace(valid, `0.8`, `1.5`, 1),
		strings.Replace(valid, `[0.3,0.3,0.4]`, `[0,1]`, 1),
		strings.Replace(valid, `[0.3,0.3,0.4]`, `[0,0,1,0]`, 1),
		strings.Replace(valid, `[0.3,0.3,0.4]`, `[0.5,0.5,0.5]`, 1),
		strings.Replace(valid, `,"wdl":[0.3,0.3,0.4]`, "", 1),
		strings.Replace(valid, `[0.2,0.3,0.5]`, `[0,1]`, 1),
		strings.Replace(valid, `[0.2,0.3,0.5]`, `[0.5,0.5,0.5]`, 1),
		strings.Replace(valid, `"degraded":false`, `"degraded":null`, 1),
		strings.Replace(valid, `"degraded":false`, `"degraded":true`, 1),
		strings.Replace(valid, `"79m"`, `"5m"`, 1),
		strings.Replace(valid, `"move":"e2e4"`, `"move":"a2a3"`, 1),
	} {
		if _, err := s.store.CachePut(hash, "maia", key, corrupt); err != nil {
			t.Fatal(err)
		}
		if _, ok := s.cachedMaia(r, "79m"); ok {
			t.Fatalf("corrupt hit: %s", corrupt)
		}
	}
}

func TestV2RejectsWrongIdentityAndEngine(t *testing.T) {
	s := &Server{store: testStore(t)}
	r := engine.EvaluationRequest{FEN: startFEN}
	hash, key := engine.SFIdentity(r).Coordinates()
	data, err := json.Marshal(sfFixture(nil, 10))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range []struct{ engine, key string }{{"sf", "v2:another-key"}, {"maia", key}} {
		if _, err := s.store.CachePut(hash, entry.engine, entry.key, string(data)); err != nil {
			t.Fatal(err)
		}
		if _, ok := s.cachedSF(r); ok {
			t.Fatalf("served mismatched identity: %+v", entry)
		}
	}
}

func TestTerminalWinnerContract(t *testing.T) {
	for _, winner := range []string{"white", "black"} {
		terminal := winner + "_win"
		v := engine.EvaluationResponse{Engine: "Stockfish 19", SearchPolicy: engine.SearchPolicy, Terminal: &terminal, Score: engine.EvaluationScore{Type: "mate", WinningSide: winner}, Lines: []engine.EvaluationLine{}}
		if !engine.ValidEvaluationValue(v, nil) {
			t.Fatalf("rejected Python terminal: %+v", v)
		}
		v.Score.WinningSide = "white"
		if winner == "white" {
			v.Score.WinningSide = "black"
		}
		if engine.ValidEvaluationValue(v, nil) {
			t.Fatal("accepted wrong terminal winner")
		}
		terminal = "checkmate"
		if engine.ValidEvaluationValue(v, nil) {
			t.Fatal("accepted obsolete terminal spelling")
		}
	}
}

func TestLookupBodyByteLimit(t *testing.T) {
	s := &Server{store: testStore(t)}
	prefix := `{"line":{"initial_fen":"","moves":[]},"requests":[{"engine":"sf","ply":0,"fen":"`
	suffix := startFEN + `"}]}`
	// Huma's MaxBodyBytes is exclusive: under 4MiB passes, exactly 4MiB is
	// a 413 (the old MaxBytesReader let exactly-limit bodies through).
	for _, extra := range []int{-1, 0} {
		body := prefix + strings.Repeat(" ", 4*1024*1024-len(prefix)-len(suffix)+extra) + suffix
		w := serve(s, "POST", "/evaluations/lookup", body)
		want := 200
		if extra == 0 {
			want = 413
		}
		if w.Code != want {
			t.Fatalf("body bytes=%d status=%d want=%d: %s", len(body), w.Code, want, w.Body)
		}
	}
}

func TestBulkPrefetchMatchesSingleReads(t *testing.T) {
	s := &Server{store: testStore(t)}
	sfReq := engine.EvaluationRequest{FEN: startFEN}
	seedSF(t, s, sfReq, 20)
	elo := 1600
	maiaReq := engine.MaiaRequest{FEN: startFEN, SelfElo: elo, OppoElo: elo}
	maiaHash, maiaKey := engine.MaiaIdentity(maiaReq, "79m").Coordinates()
	maiaValue := engine.MoveResponse{Move: "e2e4", TopMoves: []engine.TopMove{{Move: "e2e4", Prob: 1, WDL: [3]float64{.2, .3, .5}}}, WDL: [3]float64{.2, .3, .5}, ModelUsed: "79m"}
	s.storeCache(maiaHash, "maia", maiaKey, maiaValue)
	missReq := engine.EvaluationRequest{FEN: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1", Moves: []string{"e2e4"}}

	var hashes []string
	for _, candidate := range sfSupersetCandidates(sfReq) {
		hash, _ := engine.SFIdentity(candidate).Coordinates()
		hashes = append(hashes, hash)
	}
	hashes = append(hashes, maiaHash)
	missHash, _ := engine.SFIdentity(missReq).Coordinates()
	hashes = append(hashes, missHash, missHash) // duplicate exercises dedupe
	src := s.prefetch(hashes)
	if single, ok := s.cachedSF(sfReq); !ok {
		t.Fatal("single-path SF fixture missed")
	} else if bulk, ok := s.cachedSFFrom(src, sfReq); !ok || bulk.Score != single.Score || bulk.BestMove == nil || *bulk.BestMove != *single.BestMove {
		t.Fatalf("bulk SF disagrees with single path: %+v vs %+v", bulk, single)
	}
	if single, ok := s.cachedMaia(maiaReq, "79m"); !ok {
		t.Fatal("single-path Maia fixture missed")
	} else if bulk, ok := s.cachedMaiaFrom(src, maiaReq, "79m"); !ok || bulk.Move != single.Move {
		t.Fatalf("bulk Maia disagrees with single path: %+v vs %+v", bulk, single)
	}
	if _, ok := s.cachedSFFrom(src, missReq); ok {
		t.Fatal("bulk served an unseeded identity")
	}
	if _, ok := (&Server{}).prefetch([]string{maiaHash}).fetch(maiaHash, "maia", maiaKey); ok {
		t.Fatal("nil-store prefetch hit")
	}
}

func TestBulkPrefetchChunksLargeBatches(t *testing.T) {
	s := &Server{store: testStore(t)}
	const rows = 505 // past the 500-hash chunk boundary
	var hashes []string
	for i := 0; i < rows; i++ {
		hash := fmt.Sprintf("%04x", i)
		if _, err := s.store.CachePut(hash, "sf", fmt.Sprintf("k%d", i), `{"ok":true}`); err != nil {
			t.Fatal(err)
		}
		hashes = append(hashes, hash)
	}
	got, err := s.store.CacheGetMany(hashes)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != rows {
		t.Fatalf("bulk rows=%d want=%d", len(got), rows)
	}
}

func seedMaia(t *testing.T, s *Server, r engine.MaiaRequest, model string, value engine.MoveResponse) {
	t.Helper()
	hash, key := engine.MaiaIdentity(r, model).Coordinates()
	s.storeCache(hash, "maia", key, value)
	if _, err := s.store.CacheGet(hash); err != nil {
		t.Fatalf("producer rejected fixture: %v", err)
	}
}

// Golden delta attachment: display row at 1600 with a 2400 grading row
// behind it. Grading WDL [.2,.3,.5] is 65.0 expected; candidates land at
// 53.15/53.2, so deltas are -11.85/-11.8 with kind before.
func TestMaiaDeltaAttachGolden(t *testing.T) {
	s := &Server{store: testStore(t)}
	elo := 1600
	req := engine.MaiaRequest{FEN: startFEN, SelfElo: elo, OppoElo: elo}
	display := engine.MoveResponse{Move: "e2e4", WDL: [3]float64{0.437, 0.063, 0.5}, ModelUsed: "79m", TopMoves: []engine.TopMove{
		{Move: "e2e4", Prob: 0.6, WDL: [3]float64{0.437, 0.063, 0.5}},
		{Move: "d2d4", Prob: 0.4, WDL: [3]float64{0.435, 0.066, 0.499}},
	}}
	seedMaia(t, s, req, "79m", display)
	grading := engine.MaiaRequest{FEN: startFEN, SelfElo: 2400, OppoElo: 2400}
	seedMaia(t, s, grading, "79m", engine.MoveResponse{Move: "e2e4",
		WDL: [3]float64{.2, .3, .5}, ModelUsed: "79m",
		TopMoves: []engine.TopMove{{Move: "e2e4", Prob: 1, WDL: [3]float64{.2, .3, .5}}}})
	before, err := json.Marshal(display)
	if err != nil {
		t.Fatal(err)
	}
	attached := attachMaiaDelta(serverSource{s}, req, &display)
	if string(before) != mustMarshal(t, display) {
		t.Fatal("attach mutated its input")
	}
	if attached.DeltaBaseline == nil || attached.DeltaBaseline.Kind != "before" ||
		math.Abs(attached.DeltaBaseline.Value-65) > 1e-9 {
		t.Fatalf("baseline = %+v, want {65 before}", attached.DeltaBaseline)
	}
	want := []float64{53.15 - 65, 53.2 - 65}
	if len(attached.TopMoves) != 2 {
		t.Fatalf("top moves = %+v", attached.TopMoves)
	}
	for i, delta := range want {
		got := attached.TopMoves[i].Delta
		if got == nil || math.Abs(*got-delta) > 1e-9 {
			t.Fatalf("delta[%d] = %v, want %v", i, got, delta)
		}
	}
	// End to end through the line-shaped lookup: same baseline and deltas.
	rows := lookupValues(t, lookupDefault(t, s, []LookupRequest{{Engine: "maia", FEN: startFEN,
		Ply: 0, EloMaia: &elo, EloUser: &elo, Model: "79m"}}))
	if len(rows) != 1 {
		t.Fatalf("lookup rows = %+v", rows)
	}
	served, err := evalcache.DecodeStrict[engine.MoveResponse]([]byte(mustMarshal(t, rows[0].Value)), engine.MoveRequired, nil)
	if err != nil {
		t.Fatalf("served value rejected: %v", err)
	}
	if served.DeltaBaseline == nil || served.DeltaBaseline.Kind != "before" {
		t.Fatalf("served baseline = %+v", served.DeltaBaseline)
	}
	// Without a grading row the baseline stays absent and the client falls
	// back to its list-max comparison.
	bare := &Server{store: testStore(t)}
	seedMaia(t, bare, engine.MaiaRequest{FEN: startFEN, SelfElo: 1500, OppoElo: 1500}, "79m", display)
	servedBare, ok := bare.cachedMaia(engine.MaiaRequest{FEN: startFEN, SelfElo: 1500, OppoElo: 1500}, "79m")
	if !ok {
		t.Fatal("bare display row missed")
	}
	if withDelta := attachMaiaDelta(serverSource{bare}, engine.MaiaRequest{FEN: startFEN, SelfElo: 1500, OppoElo: 1500}, servedBare); withDelta.DeltaBaseline != nil {
		t.Fatalf("baseline without grading row = %+v", withDelta.DeltaBaseline)
	} else {
		for _, candidate := range withDelta.TopMoves {
			if candidate.Delta != nil {
				t.Fatalf("delta without baseline = %+v", withDelta.TopMoves)
			}
		}
	}
}

// A degraded grading row must never anchor display deltas, even if one
// reaches the cache through a path that bypasses write validation.
func TestMaiaDeltaIgnoresDegradedBaseline(t *testing.T) {
	req := engine.MaiaRequest{FEN: startFEN, SelfElo: 1600, OppoElo: 1600}
	display := engine.MoveResponse{Move: "e2e4", WDL: [3]float64{0.437, 0.063, 0.5}, ModelUsed: "79m", TopMoves: []engine.TopMove{
		{Move: "e2e4", Prob: 0.6, WDL: [3]float64{0.437, 0.063, 0.5}},
	}}
	gradingHash, gradingKey := maiaGradingHash(req)
	degraded, err := json.Marshal(engine.MoveResponse{Move: "e2e4",
		WDL: [3]float64{.2, .3, .5}, ModelUsed: "5m", Degraded: true,
		TopMoves: []engine.TopMove{{Move: "e2e4", Prob: 1, WDL: [3]float64{.2, .3, .5}}}})
	if err != nil {
		t.Fatal(err)
	}
	src := bulkSource{rows: map[string]store.CachedEvaluation{
		gradingHash: {KeyHash: gradingHash, Engine: "maia", Key: gradingKey, Value: degraded},
	}}
	if attached := attachMaiaDelta(src, req, &display); attached.DeltaBaseline != nil {
		t.Fatalf("degraded baseline attached = %+v", attached.DeltaBaseline)
	}
}

func mustMarshal(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
