# Refactor decisions (living)

Review-only walkthrough, one item at a time. Accepted items condense to one
line below once implemented; full deliberation stays in git history.
Items stay in `Pending` until explicitly decided.

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
- [x] 12. Persistence writes behind repository only (Accepted)
- [x] 13. Verdict priority tables in one module (Accepted, order separate from wording)
- [ ] 14. One opening subscription per workspace
- [x] 15. Dissolve `state.ts` god reducer (Accepted — delete the file, split into slices)
- [ ] 16. Tests / scripts / docs trim (active; docs half done 2026-10-08)

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

## Accepted (condensed; full proposals in git history)

- 1. Shared HTTP envelope helper — one `decodeSingle` + `mapEngineError`; per-endpoint caps only where load-bearing.
- 2. Generic `execute<T>` for SF + Maia — unified cache→run→validate→store→release behind a per-model interface; thin `source`-keyed composition at request time, no combined stored row. Remaining: backend `reviews.go` untouched, frontend `objective/` twins not yet collapsed to one `source`-param caller.
- 3. Shared admission helper `admit()` — central wait + acquire + error map; timeouts, slot routing, and process lifecycle stay per engine.
- 4. Shared store plumbing — shared `withTx`/JSON helpers; games vs cache tables and write strategies stay separate.
- 5. Single strict-decode path — one entry point with merged null + WDL walk; no layered re-verification.
- 6. Batch fairness — keep rotation + dual caps + 429 wait-once (fairness-without-auth for self-host scaling); FIFO + tripwire rejected.
- 7. Single frontend restore path — one `store.restore` with visible-pair-first inside; two Maia lanes stay (game-level findability + 2400 grading truth); Stockfish keeps mate scores + rank-1 PV for material preview only.
- 8. Merge `useBulkPrime` into `useServerBatch` — one `useLookupRestore`; native EventSource for ticks, status endpoint as ground truth.
- 9. Unify `useReview` / `usePlayFeedback` — one `useReviewPipeline` with room config (target set + eagerness).
- 10. Single transport + play `/move` through coordinator — one sender; play rides the coordinator with tighter params; per-endpoint error codes kept.
- 12. Persistence writes behind repository only — one shared write path (lock + compare-swap + corrupt handling); error surfacing differs per caller.
- 13. Verdict priority tables in one module — ordered name list separate from rule wording.
- 15. Dissolve `state.ts` god reducer — delete the file, split into play / analysis / display-settings slices.

## 11. Single timeline selector / FEN-scan fan-out (active)

### Proposal in plain language

Today every panel re-derives board facts on its own per render: workspace shells rebuild the move list, material strips replay the line, theory helpers re-parse the same position string, charts re-split the same counters. Terms: "timeline" = the built list of positions from the game start to now (one row per move); "FEN" = the standard text encoding of one board position; "fan-out" = N panels each parsing the same FEN / replaying the same line independently per render.

Proposal: build the timeline once per line change, then expose memoized selectors (row-at-ply, tip position, precomputed move labels, incremental material) that all panels read. Same facts, computed once. Largest per-ply render-cost cut in the UI set.

### Guessed justification for the current shape

Each panel was built to be self-sufficient (compute what you render from props), which is the natural React shape and keeps panels independently testable. The shared `domain.ts` builders exist, but no shared selector layer, so each render walks from a different level.

### Open questions for you

1. Panels staying independently testable matters to you — selectors as pure functions over the built timeline keep that. Any panel whose derivation you consider load-bearing-local and want excluded?

## 14. One opening subscription per workspace

No proposal written yet.

## 16. Tests / scripts / docs trim (active)

Docs half done 2026-10-08: deleted `deployment/` pointer folder and `PLAN.md`, trimmed this file to active items plus a condensed accepted log, trimmed root README editorial. Remaining: tests/scripts half.
