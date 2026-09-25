# Refactor decisions (living)

Review-only walkthrough, one item at a time. Each item: plain-language proposal, guessed justification for the current shape, open questions, then the final decision with rationale. Items stay in `Pending` until explicitly decided.

Status: `Pending` | `Accepted` | `Rejected` | `Needs-doc` (keep code, document intent).

## Queue

- [x] 1. Shared HTTP envelope helper (Accepted)
- [x] 2. Generic `execute<T>` for SF + Maia (Accepted, interface form)
- [x] 3. Shared admission helper `admit()` (Accepted)
- [x] 4. Shared store plumbing (`withTx`, JSON columns) (Accepted)
- [x] 5. Single strict-decode path + merged walker (Accepted)
- [x] 6. Batch fairness: rotation + dual caps (Accepted, keep)
- [x] 7. Single frontend restore path (Accepted, corrected)
- [x] 8. Merge `useBulkPrime` into `useServerBatch` (Accepted)
- [x] 9. Unify `useReview` / `usePlayFeedback` orchestration (Accepted)
- [x] 10. Single transport + play `/move` through coordinator (Accepted)
- [ ] 11. Single timeline selector / FEN-scan fan-out (active)
- [ ] 12. Persistence writes behind repository only
- [ ] 13. Verdict priority tables in one module (keep wording richness)
- [ ] 14. One opening subscription per workspace
- [x] 15. Dissolve `state.ts` god reducer (Accepted — delete the file, split into slices)
- [ ] 16. Tests / scripts / docs trim (this cleanup is the docs half)

## Settled architecture (from REFACTOR_PLAN, 2026-09-15)

Intent: LAN-first self-hosted Play vs Maia + Analyze (Maia + Stockfish) + History. Single container. Server owns ordering, identity, persistence. Browser owns rendering + what it still needs.

1. Scheduler: 3 lanes, endpoint-implied. `POST /move` → Play, `POST /move/analysis` → Focus, `POST /evaluate` → Focus, `POST /reviews` → Batch. One slot per engine, non-preemptive, grant order Play > Focus > Batch. Dedup-by-hash within each scheduler instance: Maia's single scheduler spans Play/Focus/Batch; Stockfish's interactive and batch slots dedup separately (a Focus duplicate of in-flight Batch recomputes, last write wins).
2. Abort scopes: `{ lineKey, gameId? }`. Line change/unmount aborts the foreground controller; game delete cancels its hydration jobs, drops pending UI, keeps settled cache. Branch collapse = line change. Backgrounding never aborts batch.
3. Persistence: keep versioned outbox + pending-wins + compare-swap + recovery/export.
4. Cache identity: keep superset reuse + `initialFen`. Reject inconsistent triples; validate once on write, shape-check on read.
5. Single executor: one `resolve() + execute()` for `/move`, `/evaluate`, `/reviews` entries; `lookup` reuses `resolve` read-only. Keep forgiving-live vs strict-batch as a flag.
6. Timeline: one `posId = hash(initialFen, prefix)`, `reviewKey = posId + engine + settingsHash`. Keep history-aware terminals + prefix-sharing LRU.
7. Review grades: compute once. One `computeQualities` call site; single `reviewState: loading|partial|complete|failed` drives the action button. God `State` split into play/analysis/ui slices.
8. Tests/build/docs/openings: tests to `go test` + pure-logic vitest + 1 Playwright smoke; docs to usage README + architecture limits.

Retired specs (implemented, removed 2026-09-22; git history retains them): `CANCEL_REMOVAL_SPEC.md` (rotation + dual caps, no cancel paths), `JOBLESS_BATCH_SPEC.md` (rejected jobless alternative), `MECHANISM_AUDIT.md` (threat model + items 1–4 implemented), `USEEFFECT_CLEANUP_NOTES.md` (bulk-prime sharing, openings server-side), `REFACTOR_PLAN.md` (folded into the section above).

## 1. Shared HTTP envelope helper

### Proposal in plain language

Six handlers (`main.go` `/move`, `evaluate.go` `/evaluate`, `reviews.go` `/reviews`, `evaluation_identity.go` `/evaluations/lookup`, `games.go` `/games`, `openings.go` `/openings`) each repeat the same ~12-15 lines: check the method, cap the body size, decode strict JSON (reject unknown fields), reject trailing garbage after the JSON, and write timing logs. Same for the engine-error-to-HTTP mapping (`ErrSuperseded`, `ErrWorkerBusy`, `engine_unavailable`) repeated in at least two places.

Proposal: one generic helper, e.g. `decodeSingle[T](w, r, maxBytes) (T, bool)`, owning cap + strict decode + trailing check + `invalid_json` write; plus one `mapEngineError(w, err)` owning the error mapping. Handlers keep their own validation, limits, and success shapes. Behavior unchanged, ~55-70 LOC deleted. No API, cache, scheduler, or verdict change.

### Guessed justification for the current shape

Each handler was written to be self-contained and explicit at the HTTP boundary (copy-paste is the safest way to add a new endpoint without coupling it to others). Possible deliberate reasons: different `maxBytes` per endpoint (games 64 KiB vs lookup 4 MiB), different error codes per domain (`invalid_move` vs `invalid_position`), and a desire to keep the boundary readable without jumping to shared code. If so, the duplication is caution, not accident.

### Decision

Status: Accepted. Owner confirms no need for six handlers or per-endpoint envelope configs; body caps themselves are of unknown value. Implement a single shared envelope (single configuration unless a limit proves load-bearing during implementation).

## 2. Generic `execute<T>` for SF + Maia

### Proposal in plain language

`reviews.go` has two functions that do the same job: check the cache, run the engine, validate the reply, write it to the cache, release the scheduler slot, retry up to 3 times when a duplicate request joined. One is for Stockfish (`executeSF`), one is for Maia (`executeMaia`). They differ only in which cache read, which engine call, which validator, and the Maia degraded-fallback branch.

Proposal: one generic `execute` parameterized by those four closures. `runSFEntry` / `runMaiaEntry` become a small table. Retry, release-exactly-once, and write-through stay in sync by construction. ~50-60 LOC deleted. No behavior, cache identity, or strictness-flag change.

### Guessed justification for the current shape

Explicitness at the compute core: the two engines have genuinely different process models (persistent Python worker vs fork-per-request Stockfish) and different failure modes (Maia 79M→5M fallback vs SF none). Keeping two straight-line functions makes the strict-batch vs forgiving-live split visible per engine and avoids a clever generic that could blur where degraded results are allowed. Possible the duplication was left so a future engine change touches only its own path.

### Decision

Status: Accepted, in interface form. Owner direction: identical functions differentiated only by import; the call-site usage stays identical for both models and each model adheres to an agreed Stockfish-vs-Maia contract enforced by interface. This mirrors the already-unstaged frontend pattern `frontend/src/objective/maia.ts` / `stockfish.ts` behind `index.ts`. Backend `reviews.go` is not yet touched for this (unstaged diff there is only `maxBatchRequests` 512→768 and `TopMoves` WDL); staged changes are only the `StockfishBar→ObjectiveBar` rename plus deleted dup spec. So this item is still open work.

### Reopened 2026-09-18: where should the reconciliation live?

Owner question: shouldn't the frontend stop reconciling the two models — should the backend own "what is best" since it is closest to the engines? Counter-consideration: closest means very low level.

Distinction to hold: item 2 as accepted is low-level executor unification (cache→run→validate→store→release). That stays backend regardless. The separate question is the high-level objective switch (currently `frontend/src/objective/` twins + `reviewMetrics` cutoffs + `theory` wording). That is tracked under item 13, not item 2. Decision here does not move item 2 backend — it is already backend. Open: whether item 13's "which source names best" moves backend too.

### Decided 2026-09-18: access pattern over flexible endpoint (owner delegated)

Decision: backend owns thin composition shaped to the one access pattern, not a flexible generic composition endpoint. New or extended endpoint takes `{fen, moves, initial_fen, source: "maia2400" | "stockfish19"}` plus the existing per-engine settings for that source, and returns raw `{top, expected}` only — no grades, no cutoffs, no wording. Implementation composes the existing per-model cache reads / `execute` paths at request time and never stores a combined row, so per-model cache independence is preserved (a Maia rating change never busts the SF half). Frontend `objective/` twins collapse to one caller passing `source` as a param; `reviewMetrics` cutoffs and `theory` wording stay frontend. Rationale: one enum + one shape is less surface than a generic engine-list composition language, and taste stays where the weekly game-driven commits land. Revisit full grades-from-backend only when a second client needs shared judgments.

## 3. Shared admission helper `admit()`

### Proposal in plain language

`engine.go` (Maia `Worker.predict`) and `evaluate.go` (`Evaluator.run`) each repeat the same ~20 lines: wait on the sync budget, call `Scheduler.Acquire` with priority + key, map `ErrSchedulerBusy` / `ErrSuperseded` / context-cancel to the caller's error shape.

Proposal: one `admit(sched, waitCtx, prio, key, seq)` helper owning the wait + acquire + error map. Both engines call it. Dual-slot routing (`schedulerFor`), timeouts, and process lifecycle stay per engine. ~30-40 LOC deleted.

### Decision

Status: Accepted. Owner confirms straightforward implementation oversight, no deliberate per-engine split. Centralize wait + acquire + mapping; keep timeouts, slot routing, and process lifecycle per engine.

## 4. Shared store plumbing (`withTx`, JSON columns) (active)

### Proposal in plain language

`evaluations.go` (disposable cache) and `games.go` (user games) talk to the same SQLite database the same way: open a transaction, roll back on error, commit at the end; marshal rows to JSON text columns and back; count rows with `COUNT(*)`. Each file hand-writes that plumbing, ~40-55 LOC duplicated. Tables and write strategies stay different on purpose (games use update-in-place, cache uses delete-then-insert to refresh its age order).

Proposal: shared `withTx`, JSON-column encode/decode, and count/eviction helpers. No table merge, no behavior change.

### Guessed justification for the current shape

Two different authors-in-time: user data (must never lose a game) vs cache rows (safe to evict) were built to never touch each other, so sharing a helper felt like coupling durability to disposability. Possible the split was deliberate blast-radius control.

### Open questions for you

1. Is the games-vs-cache isolation load-bearing (you want zero shared failure surface), or is shared plumbing with separate tables enough isolation?

### Decision

Status: Accepted. Owner confirms isolation is not load-bearing. Merge the plumbing; keep tables and their opposite write strategies separate.

## 5. Single strict-decode path + merged walker (active)

### Proposal in plain language

Every cached evaluation and every worker reply gets decoded and safety-checked multiple times: parse JSON, walk the whole document checking for bad nulls, walk it again checking win/draw/loss shapes, marshal it back, parse it again strictly into the typed struct. Hot paths pay 3 decodes and up to 4 full walks per read/write, plus a dead `strictDocument` duplicate with no live caller.

Proposal: one entry point (`raw bytes → one shape walk → one typed strict decode`), delete the dead path, thread bytes through `cacheGet` / `storeCache` / worker replies so nothing re-marshals just to re-parse. Same poisoning defense, ~60-80 LOC gone, 1-2 decodes removed per hot path.

### Guessed justification for the current shape

Each layer added its own check when it got burned: worker replies, cache writes, cache reads each defend independently. The double-walk may be two fixes stacked (null-poisoning, then WDL-shape) that never got merged. Defense in depth, not design.

### Open questions for you

1. Is the layered decode load-bearing as independent defense (you want each layer to re-verify even at the cost), or is one verified entry point with tests at each call site enough?

### Decision

Status: Accepted. Owner direction: no repeated checks of the same kind; verify once within the boundary. Implement single entry point with merged null + WDL walk; boundary checks stay, layered re-verification goes.

## 6. Batch fairness: rotation + dual caps vs FIFO + tripwire (active)

### Proposal in plain language

Today's batch lane (implemented: `submitSeq`, per-scheduler `batchCursor`, `maxBatchRequests = 768`, `maxKeptJobs = 8`) does fair sharing: when two tabs submit whole-game reviews at once, grants alternate A,B,A,B so the second tab starts on the second grant instead of waiting for the first tab's whole game. Plus two admission caps (512-768 misses per engine, 8 unfinished jobs) with snapshot + re-check + 429 so a runaway client fails visibly instead of piling silently.

The simpler alternative was FIFO + tripwire: batches run in submit order, one tripwire depth cap only as a runaway backstop. Less code (no rotation proof, no dual-cap counting, no 429 wait-once client path), but tab B waits for tab A's whole game.

Priority lanes (Play > Focus > Batch) and SSE are settled and stay either way. This item is only about fairness *within* the batch lane.

### Guessed justification for the current shape

Two visible tabs on the same LAN submitting whole games at once is a real household pattern (you + someone else, or two of your own tabs), and single-active FIFO would look hung. Rotation gives the second tab progress within ~2 grants. Caps bound worst-case wait to today's single-active worst case per engine. Fairness without auth (per-submit, not per-client) is the documented compromise.

### Open questions for you

1. You already said single FIFO is not the way you want to go. Does that cover rotation within the batch lane too (keep A,B,A,B sharing), or only the Play > Focus > Batch priority?
2. If rotation stays, do the dual caps + 429 wait-once stay with it, or is one tripwire cap enough?

### Decision

Status: Accepted (keep current design, no simplification). Owner direction: rotation + caps exist so a stranger can self-host this exact package and scale to family/friends. Fairness-without-auth is the point, not premature optimization. FIFO + tripwire is rejected.

## 7. Single frontend restore path

### Proposal in plain language

Today four layers each own a piece of "fill the board from cache": `evaluationStore.restore` + `reviewCoordinator.restore` + standalone `primeWithPriority` + `buildPrimeJobs` / `reorderJobsForPriority` focus-first chunking, called from `useBulkPrime` and `useServerBatch`. Two-phase focus-first (visible pair first, rest after) is implemented at two levels, so one navigation can double-chunk and double-fetch.

Proposal: one `store.restore` owning cache-fill + focus-first; coordinator keeps only the live foreground pump. `prime` vs `primeWithPriority` variants collapse. ~80-100 LOC gone, one lookup round trip per navigation instead of two.

### Decision

Status: Accepted, with corrected model (2026-09-18). Two Maia lanes are load-bearing and stay: game-level Maia (findability — "was it rare for this player," feeds rarity + candidate lists at game settings) and grading Maia 2400 (objective truth — "would 2400 consider it best," feeds Critical + negatives). Praise needs both. Struck from the record: the earlier "grading as a settings flag" collapse proposal — wrong.

Consequences recorded: Critical moves off the SF cp gap onto Maia-2400 top + wide Maia-2400 expected gap (needs second-best expectation from the Maia top-5 WDLs already returned). Negatives already classify on objective expected-score loss. Stockfish leaves grading entirely and keeps mate scores + rank-1 PV for material preview only → hardcode lines=1, delete the 1–5 lines setting, delete the fast-MPV1/full-MPV2 fork and provisional/full row split. One restore path restores two Maia lanes plus cheap SF, with visible-pair-first ordering preserved inside it. Mate handling stays SF-sourced. Item 13 (verdict tables) implements the Critical redefinition; the item-2 thin composition endpoint serves Maia lanes (SF no longer part of the objective shape beyond mate/PV).

## 8. Merge `useBulkPrime` into `useServerBatch` (active)

### Proposal in plain language

Today two hooks own cache-fill: `useBulkPrime` (generic lookup restore, used by both workspaces, own flights map capped at 3, own lineKey guard) and `useServerBatch` (batch progress reconcile, own SSE/poll/prime-throttle, own lineKey/stale guards, own persist/reattach). After item 7 there is one `store.restore` underneath — but still two callers with two flight trackers, two guards, two throttles for the same line.

Proposal: one `useLookupRestore` hook owning flights + guards + throttle; `useServerBatch` progress just calls it. Deletes one hook file (~70-90 LOC), one flights map, one guard set. Batch progress and bulk prime become the same operation observed two ways.

### Guessed justification for the current shape

`useBulkPrime` was extracted (earlier cleanup) to share the bulk shape between `useReview` and `usePlayFeedback` without touching `useServerBatch`'s job lifecycle. The batch hook kept its own prime because progress reconcile predates the shared hook and has its own timing (2s throttle + progress events + online listener). Two owners, two rhythms — sharing the shape but not the driver.

### Open questions for you

1. After item 7, batch reconcile is just "restore the wanted set, again" on each progress event. Is there any batch-specific restore behavior worth keeping separate (persisted reattach on mount, game-delete broadcast cancel, grading-lane second prime), or can all of it ride the single hook with callers passing keys?
2. `usePlayFeedback` also uses `useBulkPrime` fire-and-forget outside any batch. Does the merged hook need to serve non-batch callers directly, or should play go through the same restore entry as analysis?

### Decision

Status: Accepted (2026-09-18). One `useLookupRestore` hook owns flights + guards + throttle; batch progress and bulk prime become the same operation observed two ways. Transport settled within this item: delete the hand-rolled fetch-stream parser (`subscribeBatchEvents` reader/frame/abort-race); live ticks ride the browser's native `EventSource`, status endpoint is the ground truth. Refetch status + prime on mount, focus, visible, online, and stream error. Stream is a pure optimization (fast path); status is the truth (typed gone-vs-transient, no replay-buffer sizing, one request on resume). Rationale: native ES deletes ~60 lines and gets reconnect free; status-as-truth keeps the app correct with the stream broken or deleted; focus/visible refetch (not a held connection) is what survives backgrounding. Batch-specific bits (persisted reattach, progress-prime) ride the single hook as caller-passed keys.

Test-semantics note (2026-09-18): mount-refresh converges fast jobs via status before the first stream tick, so the progress-hold browser test must hold the status route too (not just events) to observe running UI. `review.spec.ts` progress test updated accordingly. Pair-ensure-vs-batch request-count assertions remain inherently racy (pre-existing on baseline, mechanism-identical); retries distinguish flakes from regressions.

## 9. Unify `useReview` / `usePlayFeedback` orchestration

### Decision

Status: Accepted (2026-09-18). One `useReviewPipeline` hook with configuration expressing room differences, not two hooks. Config covers: target set (Analyze: whole line viewed-first; Play: newest pair + user-side-only activity), and eagerness (Play: foreground fetch on move + 3×2s retry + sweep-all-user-moves on reconnect; Analyze: debounce + wait for batch). Owner direction: differences are configuration, not architecture.

## 10. Single transport + play `/move` through coordinator (active)

### Proposal in plain language

Today the app talks to the engines through three parallel senders that each implement "send JSON, wait, retry-if-busy, read error, parse reply" on their own: the play-move sender (`api.ts`), the position-evaluation sender (`evaluationStore.ts` fetch path), and the batch sender (`batchReview.ts`). On top of that, the play-move *flight itself* (the in-flight POST while you wait for Maia's reply) is managed by the board-state hook (`useMaiaBoard.ts`: its own abort controller, its own 150s stall timer, its own cancelled-flag), bypassing the foreground scheduler (`ReviewCoordinator`) that every other engine request goes through.

Proposal: one shared sender owning send/wait/busy-retry/error/parse, used by all three; and the play-move flight rides the coordinator like everything else instead of its own one-off flight manager. Terms: "transport" = the send-and-parse function; "flight" = one in-flight request being tracked (abortable, timed out, matched to its reply); "coordinator" = the foreground scheduler tracking at most one live request per engine with latest-wins (a newer request for the same engine supersedes the older).

### Guessed justification for the current shape

The play move is the latency-critical path (a human waits on it mid-game), so it got its own hand-managed flight with its own stall timer rather than sharing the analysis scheduler. The three senders grew with their endpoints (`/move` first for play, `/evaluate` later for analysis, `/reviews` last for batches) and each kept its own error taxonomy copy.

### Open questions for you

1. The play flight's 150s stall timer and microtask-deferred fire: load-bearing game feel (a human staring at the board needs different timeout/abort behavior than a background batch), or can the coordinator own one flight policy with play passing tighter parameters?
2. Error vocabularies differ slightly per endpoint today (`invalid_move` vs `invalid_position`, Maia-color vs engine-shape errors). Unify into one taxonomy, or keep per-endpoint codes under one sender?

### Decision

Status: Accepted (2026-09-18). One shared sender for all three paths; play flight rides the coordinator with play passing its tighter parameters. Per-endpoint error codes ride under the one sender (no taxonomy fork).

## 11. Single timeline selector / FEN-scan fan-out (active)

### Proposal in plain language

Today every panel re-derives board facts on its own per render: workspace shells rebuild the move list, material strips replay the line, theory helpers re-parse the same position string, charts re-split the same counters. Terms: "timeline" = the built list of positions from the game start to now (one row per move); "FEN" = the standard text encoding of one board position; "fan-out" = N panels each parsing the same FEN / replaying the same line independently per render.

Proposal: build the timeline once per line change, then expose memoized selectors (row-at-ply, tip position, precomputed move labels, incremental material) that all panels read. Same facts, computed once. Largest per-ply render-cost cut in the UI set.

### Guessed justification for the current shape

Each panel was built to be self-sufficient (compute what you render from props), which is the natural React shape and keeps panels independently testable. The shared `domain.ts` builders exist, but no shared selector layer, so each render walks from a different level.

### Open questions for you

1. Panels staying independently testable matters to you — selectors as pure functions over the built timeline keep that. Any panel whose derivation you consider load-bearing-local and want excluded?

## 15. Dissolve `state.ts` god reducer

### Decision

Status: Accepted (2026-09-18, scope expanded by owner). Not just "display settings out" — delete `state.ts` as a file and split into play / analysis / display-settings slices so the god-reducer temptation has nowhere to regrow. Details (slice boundaries, `sync`-case ownership, snapshot-vs-v2 session truth) to be worked when the queue reaches the persistence items; the direction is settled early at owner request.
