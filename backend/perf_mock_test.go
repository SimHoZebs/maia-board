package main

// Mock-engine backend perf harness: measures Go overhead (validation,
// scheduler admission, SQLite cache, batch drain) with inference stubbed
// to a fixed sleep. No subprocesses, no weights, no GPU.
//
// Run via scripts/backend-perf.sh (or directly):
//
//	PERF_MODE=mock PERF_SEED=1 PERF_PLIES=40 PERF_MAIA_MS=5 \
//	  PERF_OUT=test-results/backend-perf.json go test -run TestBackendPerfMock -v .
//
// Without PERF_MODE=mock the test skips, so plain `go test ./...` stays
// fast. PERF_LINE_JSON optionally points at scripts/gen-perf-line.py
// output to run the shared seeded line; otherwise a synthetic line
// (varying FEN counters + cycling UCI prefixes) is used. Synthetic
// positions pass validation because validateMoveRequest checks FEN/UCI
// shape only; move↔FEN replay consistency is worker-side and the mock
// predictor bypasses it the same way fakePredictor does.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// perfSleeper stubs engine inference behind the existing predictor
// interface (the same seam fakePredictor uses), but unlike fakePredictor
// it admits through a real Scheduler exactly like Worker.predict does:
// deterministic requests derive the same maiaIdentity dedup key, sync
// lanes bind their queue wait, batch entries carry their submitSeq, and
// the returned release must be called after the caller persists the
// result. The execution itself is a fixed liveMs sleep serving a valid
// single-candidate result. Cache hits never reach the pool, so hit
// latency measured at the HTTP layer is the real SQLite read path.
type perfSleeper struct {
	model  string
	sched  *Scheduler
	mu     sync.Mutex
	execs  int
	liveMs int
	result EngineResult
}

func newPerfSleeper(model string, liveMs int, result EngineResult) *perfSleeper {
	return &perfSleeper{model: model, sched: NewScheduler(), liveMs: liveMs, result: result}
}

func (f *perfSleeper) predict(waitCtx, execCtx context.Context, prio Priority, submitSeq uint64, request EngineRequest) (EngineResult, func(), error) {
	if err := waitCtx.Err(); err != nil {
		return EngineResult{}, nil, err
	}
	key := ""
	if request.Temperature == 0 {
		key, _ = maiaIdentity(request, f.model).coordinates()
	}
	grant, err := admit(waitCtx, prio, f.sched, key, submitSeq)
	if err != nil {
		return EngineResult{}, nil, err
	}
	release := func() { f.sched.Release(grant) }
	if f.liveMs > 0 {
		select {
		case <-time.After(time.Duration(f.liveMs) * time.Millisecond):
		case <-execCtx.Done():
			release()
			return EngineResult{}, nil, execCtx.Err()
		}
	}
	f.mu.Lock()
	f.execs++
	f.mu.Unlock()
	result := f.result
	result.Candidates = append([]Candidate(nil), f.result.Candidates...)
	return result, release, nil
}

func (f *perfSleeper) snapshot() WorkerStatus { return WorkerStatus{} }

func (f *perfSleeper) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.execs
}

type perfStep struct {
	Step string `json:"step"`
	Ms   int64  `json:"ms"`
}

func perfEnvInt(key string, fallback int) int {
	if raw := os.Getenv(key); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil {
			return value
		}
	}
	return fallback
}

func perfPct(sorted []int64, p int) int64 {
	if len(sorted) == 0 {
		return 0
	}
	return sorted[min(len(sorted)-1, p*len(sorted)/100)]
}

func perfAvg(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	sum := int64(0)
	for _, v := range values {
		sum += v
	}
	return sum / int64(len(values))
}

// perfLine is either the shared seeded line (PERF_LINE_JSON, from
// scripts/gen-perf-line.py) or a synthetic fallback. FENs[i] is the
// position after Moves[:i]; len(FENs) == len(Moves)+1.
type perfLine struct {
	moves []string
	fens  []string
}

var perfCycleMoves = []string{"e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6", "b5a4", "g8f6"}

func perfSyntheticLine(plies int) perfLine {
	moves := make([]string, 0, plies)
	for i := 0; i < plies; i++ {
		moves = append(moves, perfCycleMoves[i%len(perfCycleMoves)])
	}
	fens := make([]string, 0, plies+1)
	for i := 0; i <= plies; i++ {
		fens = append(fens, fmt.Sprintf("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 %d", i+1))
	}
	return perfLine{moves: moves, fens: fens}
}

func perfLoadLine(t *testing.T, plies int) perfLine {
	t.Helper()
	path := os.Getenv("PERF_LINE_JSON")
	if path == "" {
		return perfSyntheticLine(plies)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read PERF_LINE_JSON: %v", err)
	}
	var doc struct {
		Moves      []string `json:"moves"`
		FENs       []string `json:"fens"`
		InitialFEN string   `json:"initial_fen"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("parse PERF_LINE_JSON: %v", err)
	}
	if len(doc.FENs) != len(doc.Moves)+1 {
		t.Fatalf("line file has %d moves but %d fens", len(doc.Moves), len(doc.FENs))
	}
	for _, move := range doc.Moves {
		if !uciMovePattern.MatchString(move) {
			t.Fatalf("line file has non-UCI move %q", move)
		}
	}
	if len(doc.Moves) > plies {
		return perfLine{moves: append([]string{}, doc.Moves[:plies]...), fens: append([]string{}, doc.FENs[:plies+1]...)}
	}
	return perfLine{moves: doc.Moves, fens: doc.FENs}
}

func perfSide(fen string) string {
	fields := strings.Fields(fen)
	if len(fields) > 1 && fields[1] == "b" {
		return "black"
	}
	return "white"
}

func TestBackendPerfMock(t *testing.T) {
	if os.Getenv("PERF_MODE") != "mock" {
		t.Skip("backend perf harness runs only with PERF_MODE=mock")
	}
	seed := perfEnvInt("PERF_SEED", 1)
	plies := perfEnvInt("PERF_PLIES", 40)
	liveMs := perfEnvInt("PERF_MAIA_MS", 5)
	if plies < 1 {
		plies = 1
	}
	if plies > 256 {
		plies = 256
	}
	if liveMs < 0 {
		liveMs = 0
	}
	line := perfLoadLine(t, plies)
	plies = len(line.moves)
	positions := plies + 1

	wdl := [3]float64{0.2, 0.3, 0.5}
	maiaResult := EngineResult{Move: "e2e4", Candidates: []Candidate{{Move: "e2e4", Policy: 1, WDL: wdl}}, WDL: wdl}
	// One scheduler per model, mirroring production where each Worker owns
	// its scheduler: the 79m sleeper serves live + batch 79m traffic.
	large := newPerfSleeper("79m", liveMs, maiaResult)
	small := newPerfSleeper("5m", liveMs, maiaResult)
	sleeperCalls := func() int { return large.calls() + small.calls() }
	app := &server{pool: NewEnginePool(large, small), store: testStore(t)}
	app.reviews = NewReviewJobs(app)
	mux := http.NewServeMux()
	mux.HandleFunc("/move", app.move)
	mux.HandleFunc("/move/analysis", app.moveAnalysis)
	mux.HandleFunc("/evaluate", app.evaluate)
	mux.HandleFunc("/evaluations/lookup", app.evaluationLookup)
	mux.HandleFunc("/reviews", app.reviews.reviews)
	mux.HandleFunc("/reviews/", app.reviews.reviewRouter)

	var steps []perfStep
	timed := func(step string, fn func()) {
		start := time.Now()
		fn()
		steps = append(steps, perfStep{Step: step, Ms: time.Since(start).Milliseconds()})
	}
	post := func(path, body string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)))
		return w
	}
	moveBody := func(ply, eloMaia, eloUser int) string {
		prefix, _ := json.Marshal(line.moves[:ply])
		return fmt.Sprintf(`{"fen":%q,"moves":%s,"elo_maia":%d,"elo_user":%d,"model":"79m","maia_color":%q}`,
			line.fens[ply], prefix, eloMaia, eloUser, perfSide(line.fens[ply]))
	}

	// Miss/hit accounting is asserted per step (not just recorded): a
	// cache-identity leak that turns an expected miss into a hit (or vice
	// versa) must fail loudly instead of emitting plausible JSON.
	// sleeperCalls only advances on live inference; lookups never admit.

	// 1. Boot: single live reply at the root (miss → sleeper inference).
	var bootMs int64
	timed("move: boot reply at root", func() {
		before := sleeperCalls()
		start := time.Now()
		w := post("/move", moveBody(0, 1500, 1300))
		bootMs = time.Since(start).Milliseconds()
		if w.Code != http.StatusOK {
			t.Fatalf("boot reply: %d %s", w.Code, w.Body)
		}
		if w.Header().Get("X-Eval-Cache") != "miss" {
			t.Fatalf("boot reply cache header = %q, want miss", w.Header().Get("X-Eval-Cache"))
		}
		if got := sleeperCalls() - before; got != 1 {
			t.Fatalf("boot sleeper calls = %d, want 1", got)
		}
	})

	// 2. Line load: bulk lookup before the batch. Only the boot row is
	// cached, so exactly 1 of the positions hits; zero admissions:
	// lookup never touches the pool.
	var lineLoadMs int64
	timed("lookup: line load before batch", func() {
		before := sleeperCalls()
		queries := make([]lookupRequest, 0, positions)
		for i := range positions {
			queries = append(queries, lookupRequest{Engine: "maia", FEN: line.fens[i], Ply: i,
				EloMaia: intPtr(1500), EloUser: intPtr(1300), Model: "79m"})
		}
		body, _ := json.Marshal(map[string]any{"line": batchLine{InitialFEN: startFEN, Moves: line.moves}, "requests": queries})
		start := time.Now()
		w := post("/evaluations/lookup", string(body))
		lineLoadMs = time.Since(start).Milliseconds()
		if w.Code != http.StatusOK {
			t.Fatalf("line lookup: %d %s", w.Code, w.Body)
		}
		var result struct {
			Results []lookupResult `json:"results"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Results) != 1 {
			t.Fatalf("pre-batch lookup results = %d, want 1 (the boot row)", len(result.Results))
		}
		if got := sleeperCalls() - before; got != 0 {
			t.Fatalf("line lookup admitted %d inferences, want 0", got)
		}
	})

	// 3. Whole-line batch submit + drain. Maia-only entries exercise the
	// batch lane, drain loop, write-through, and per-entry timing lines.
	// The boot row above is entry 0's identity, so intake must report
	// cached==1 and the drain must run exactly positions-1 inferences.
	var batchSubmitMs, batchDrainMs, batchTotal, batchCached int64
	var drainSamples [][2]int64 // (elapsed_ms, done)
	timed("reviews: batch submit + drain", func() {
		before := sleeperCalls()
		queries := make([]lookupRequest, 0, positions)
		for i := range positions {
			queries = append(queries, lookupRequest{Engine: "maia", FEN: line.fens[i], Ply: i,
				EloMaia: intPtr(1500), EloUser: intPtr(1300), Model: "79m"})
		}
		body, _ := json.Marshal(map[string]any{"line": batchLine{InitialFEN: startFEN, Moves: line.moves}, "requests": queries})
		start := time.Now()
		w := post("/reviews", string(body))
		if w.Code != http.StatusAccepted {
			t.Fatalf("batch submit: %d %s", w.Code, w.Body)
		}
		batchSubmitMs = time.Since(start).Milliseconds()
		var submit struct {
			JobID   string `json:"job_id"`
			Total   int    `json:"total"`
			Cached  int    `json:"cached"`
			Pending int    `json:"pending"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &submit); err != nil {
			t.Fatalf("batch submit decode: %v", err)
		}
		batchTotal, batchCached = int64(submit.Total), int64(submit.Cached)
		if batchCached != 1 {
			t.Fatalf("batch cached = %d, want 1 (the boot row)", batchCached)
		}
		// Drain clock starts after 202 Accepted so intake
		// (validate + prefetch + insert) is reported separately as
		// batchSubmitMs. Poll samples observe completion at poll
		// granularity; per-entry ground truth also exists as
		// `review-batch entry … duration_ms` log lines.
		drainStart := time.Now()
		deadline := time.Now().Add(120 * time.Second)
		for {
			sw := httptest.NewRecorder()
			mux.ServeHTTP(sw, httptest.NewRequest(http.MethodGet, "/reviews/"+submit.JobID, nil))
			if sw.Code != http.StatusOK {
				t.Fatalf("batch poll: %d %s", sw.Code, sw.Body)
			}
			var progress struct {
				Total    int  `json:"total"`
				Done     int  `json:"done"`
				Failed   int  `json:"failed"`
				Finished bool `json:"finished"`
			}
			if err := json.Unmarshal(sw.Body.Bytes(), &progress); err != nil {
				t.Fatalf("batch progress decode: %v", err)
			}
			drainSamples = append(drainSamples, [2]int64{time.Since(drainStart).Milliseconds(), int64(progress.Done)})
			if progress.Finished {
				if progress.Failed != 0 || progress.Done+progress.Failed != progress.Total {
					t.Fatalf("batch finished dirty: %+v", progress)
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("batch did not finish: %+v", progress)
			}
			time.Sleep(time.Millisecond)
		}
		batchDrainMs = time.Since(drainStart).Milliseconds()
		if got := sleeperCalls() - before; got != positions-1 {
			t.Fatalf("batch drain inferences = %d, want %d (total - intake hit)", got, positions-1)
		}
	})

	// 4. Scrub analog: per-position single-request lookups after the batch.
	// Every row is now cached, so this measures the bulk-read + strict-decode
	// path per position, mirroring the frontend scrub sweep.
	var scrubMs []int64
	timed(fmt.Sprintf("lookup: scrub sweep of %d positions", positions), func() {
		before := sleeperCalls()
		for i := range positions {
			queries := []lookupRequest{{Engine: "maia", FEN: line.fens[i], Ply: i,
				EloMaia: intPtr(1500), EloUser: intPtr(1300), Model: "79m"}}
			body, _ := json.Marshal(map[string]any{"line": batchLine{InitialFEN: startFEN, Moves: line.moves}, "requests": queries})
			start := time.Now()
			w := post("/evaluations/lookup", string(body))
			scrubMs = append(scrubMs, time.Since(start).Milliseconds())
			if w.Code != http.StatusOK {
				t.Fatalf("scrub lookup %d: %d %s", i, w.Code, w.Body)
			}
			var result struct {
				Results []lookupResult `json:"results"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Results) != 1 {
				t.Fatalf("scrub lookup %d results: %v %s", i, err, w.Body)
			}
		}
		if got := sleeperCalls() - before; got != 0 {
			t.Fatalf("scrub sweep admitted %d inferences, want 0 (all hits)", got)
		}
	})

	// 5. Rating-change foreground: new Elo misses and runs live once.
	var ratingMs int64
	timed("move: rating-change foreground", func() {
		before := sleeperCalls()
		start := time.Now()
		w := post("/move/analysis", moveBody(positions-1, 1800, 1800))
		ratingMs = time.Since(start).Milliseconds()
		if w.Code != http.StatusOK {
			t.Fatalf("rating change: %d %s", w.Code, w.Body)
		}
		if w.Header().Get("X-Eval-Cache") != "miss" {
			t.Fatalf("rating change cache header = %q, want miss", w.Header().Get("X-Eval-Cache"))
		}
		if got := sleeperCalls() - before; got != 1 {
			t.Fatalf("rating change inferences = %d, want 1", got)
		}
	})

	// 6. Lane collision: live reply (Play) + analysis (Focus) concurrently
	// with fresh Elos so both miss. This is a concurrency smoke test only:
	// both admissions must succeed without deadlock, each a genuine miss
	// running once. It does not prove lane separation on its own (a
	// same-lane supersede needs three arrivals: running + queued victim +
	// newer arrival). Lane mapping itself is pinned by
	// TestMoveEndpointsAdmitOnSeparateLanes, which asserts the endpoints
	// admit on [Play Focus]; here the miss + inference-count assertions
	// prove both requests actually executed instead of joining or failing.
	var laneMs int64
	timed("move: play+focus lane collision", func() {
		before := sleeperCalls()
		start := time.Now()
		var wg sync.WaitGroup
		bodies := make([]*httptest.ResponseRecorder, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			bodies[0] = post("/move", moveBody(0, 1601, 1601))
		}()
		go func() {
			defer wg.Done()
			bodies[1] = post("/move/analysis", moveBody(0, 1602, 1602))
		}()
		wg.Wait()
		laneMs = time.Since(start).Milliseconds()
		for i, w := range bodies {
			if w.Code != http.StatusOK {
				t.Fatalf("lane collision reply %d: %d %s", i, w.Code, w.Body)
			}
			if w.Header().Get("X-Eval-Cache") != "miss" {
				t.Fatalf("lane collision reply %d cache header = %q, want miss", i, w.Header().Get("X-Eval-Cache"))
			}
		}
		if got := sleeperCalls() - before; got != 2 {
			t.Fatalf("lane collision inferences = %d, want 2", got)
		}
	})

	// 7. Stockfish cache-hit path: seed one row, serve it without an
	// evaluator (nil evaluator proves hits never touch the engine).
	var sfHitMs int64
	timed("evaluate: stockfish cache hit", func() {
		settings := &stockfishSettings{TimeMS: 750, Lines: 2, Depth: 0}
		seedSF(t, app, evaluationRequest{FEN: startFEN, Settings: settings}, 25)
		sfApp := &server{store: app.store}
		body := fmt.Sprintf(`{"fen":%q,"moves":[],"settings":{"time_ms":750,"lines":2,"depth":0}}`, startFEN)
		w := httptest.NewRecorder()
		start := time.Now()
		sfApp.evaluate(w, httptest.NewRequest(http.MethodPost, "/evaluate", strings.NewReader(body)))
		sfHitMs = time.Since(start).Milliseconds()
		if w.Code != http.StatusOK || w.Header().Get("X-Eval-Cache") != "hit" {
			t.Fatalf("sf hit: %d header=%q %s", w.Code, w.Header().Get("X-Eval-Cache"), w.Body)
		}
	})

	sortedScrub := append([]int64{}, scrubMs...)
	sort.Slice(sortedScrub, func(i, j int) bool { return sortedScrub[i] < sortedScrub[j] })
	third := max(1, len(scrubMs)/3)
	earlyAvg, lateAvg := perfAvg(scrubMs[:third]), perfAvg(scrubMs[len(scrubMs)-third:])
	// Drain curve: first half of completions vs second half by sample time.
	var earlyDrain, lateDrain int64
	if len(drainSamples) >= 2 {
		total := drainSamples[len(drainSamples)-1][1]
		var firstHalfMs, secondHalfMs int64 = -1, -1
		for _, s := range drainSamples {
			if firstHalfMs < 0 && s[1] >= total/2 {
				firstHalfMs = s[0]
			}
			if s[1] >= total {
				secondHalfMs = s[0]
			}
		}
		if firstHalfMs >= 0 {
			earlyDrain, lateDrain = firstHalfMs, secondHalfMs-firstHalfMs
		}
	}

	metrics := map[string]any{
		"config": map[string]any{"seed": seed, "targetPlies": perfEnvInt("PERF_PLIES", 40),
			"actualPlies": plies, "positions": positions, "maiaLiveMs": liveMs, "inference": "mocked"},
		"steps": steps,
		"move":  map[string]any{"bootMs": bootMs, "ratingChangeMs": ratingMs, "laneCollisionMs": laneMs},
		"lookup": map[string]any{"lineLoadMs": lineLoadMs, "sfHitMs": sfHitMs,
			"scrubPerPositionMs": scrubMs,
			"scrub": map[string]any{"count": len(scrubMs), "p50": perfPct(sortedScrub, 50),
				"p95": perfPct(sortedScrub, 95), "max": perfPct(sortedScrub, 100),
				"earlyAvg": earlyAvg, "lateAvg": lateAvg}},
		"batch": map[string]any{"total": batchTotal, "cached": batchCached,
			"submitMs": batchSubmitMs, "drainMs": batchDrainMs,
			"firstHalfMs": earlyDrain, "secondHalfMs": lateDrain},
		"sleeperCalls": sleeperCalls(),
	}
	out := os.Getenv("PERF_OUT")
	data, err := json.MarshalIndent(metrics, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if out != "" {
		if err := os.WriteFile(out, append(data, '\n'), 0o644); err != nil {
			t.Fatalf("write PERF_OUT: %v", err)
		}
	}
	t.Logf("[backend-perf] %d plies | boot %dms line-load %dms submit %dms drain %dms (halves %d/%dms) | scrub p50 %dms p95 %dms early/late %d/%dms | rating %dms lanes %dms sf-hit %dms | sleeper calls %d",
		plies, bootMs, lineLoadMs, batchSubmitMs, batchDrainMs, earlyDrain, lateDrain,
		perfPct(sortedScrub, 50), perfPct(sortedScrub, 95), earlyAvg, lateAvg,
		ratingMs, laneMs, sfHitMs, sleeperCalls())

	if batchTotal != int64(positions) {
		t.Fatalf("batch total = %d, want %d positions", batchTotal, positions)
	}
	if len(scrubMs) != positions {
		t.Fatalf("scrub sweep covered %d positions, want %d", len(scrubMs), positions)
	}
}

func intPtr(v int) *int { return &v }
