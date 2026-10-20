# Refactor decisions (living)

Deliberation stays in git history. Items stay pending until decided.
Status: `Pending` | `Accepted` | `Rejected` | `Needs-doc`.

## Queue

- [x] 1. Shared HTTP envelope helper (Accepted)
- [x] 2. Generic `execute<T>` for SF + Maia (Accepted, interface form)
- [x] 3. Shared admission helper `admit()` (Accepted)
- [x] 4. Shared store plumbing (Accepted)
- [x] 5. Single strict-decode path + merged walker (Accepted)
- [x] 6. Batch fairness: rotation + dual caps (Accepted, keep)
- [x] 7. Single frontend restore path (Accepted, corrected)
- [x] 8. Merge `useBulkPrime` into `useServerBatch` (Accepted)
- [x] 9. Unify `useReview` / `usePlayFeedback` (Accepted)
- [x] 10. Single transport + play `/move` through coordinator (Accepted)
- [ ] 11. Single timeline selector / FEN-scan fan-out (active; proposal below)
- [x] 12. Persistence writes behind repository only (Accepted)
- [x] 13. Verdict priority tables in one module (Accepted)
- [ ] 14. One opening subscription per workspace (no proposal yet)
- [x] 15. Dissolve `state.ts` god reducer (Accepted — split into slices)
- [ ] 16. Tests / scripts / docs trim (active)

## Settled architecture (REFACTOR_PLAN, 2026-09-15)

LAN-first: Play vs Maia + Analyze (Maia + Stockfish) + History. Single
container. Server owns ordering, identity, persistence.

1. Scheduler: endpoint-implied lanes, slots per lane, Play > Focus > Batch,
   dedup-by-key per scheduler.
2. Abort scopes `{lineKey, gameId?}`: line change/unmount aborts foreground; game delete cancels restore, keeps settled cache.
3. Persistence: versioned outbox + pending-wins + compare-swap + recovery/export.
4. Cache: superset reuse + `initialFen`; validate once on write, shape-check on read.
5. Executor: one `resolve() + execute()`; `lookup` read-only; forgiving-live vs strict-batch flag.
6. Timeline: `posId`/`reviewKey` content keys with prefix-sharing LRU.
7. Grades: one `computeQualities` call site; single `reviewState` drives the button.
8. Tests/docs: `go test` + pure-logic vitest + 1 Playwright smoke.

Retired specs (removed 2026-09-22; in git history): `CANCEL_REMOVAL_SPEC.md`, `JOBLESS_BATCH_SPEC.md`, `MECHANISM_AUDIT.md`, `USEEFFECT_CLEANUP_NOTES.md`, `REFACTOR_PLAN.md`.

## Accepted (one line each)

- 1. One `decodeSingle` + `mapEngineError`; per-endpoint caps only where load-bearing.
- 2. Unified cache→run→validate→store→release behind per-model interface; `source`-keyed composition at request time. Remaining: `reviews.go`, frontend `objective/` twins.
- 3. Central wait + acquire + error map; timeouts/routing/lifecycle stay per engine.
- 4. Shared `withTx`/JSON helpers; game vs cache write strategies stay separate.
- 5. One strict-decode entry with merged null + WDL walk.
- 6. Rotation + dual caps + 429 wait-once.
- 7. One `store.restore` with visible-pair-first; two bot roles (findability + 2400 truth); Stockfish mate + rank-1 PV for material preview.
- 8. One `useLookupRestore`; EventSource ticks, status endpoint ground truth.
- 9. One `useReviewPipeline` with room config.
- 10. One sender; play rides coordinator with tighter params; per-endpoint codes kept.
- 12. One shared write path (lock + compare-swap + corrupt handling).
- 13. Ordered name list separate from wording, one module.
- 15. Delete `state.ts`; split into play/analysis/display-settings slices.

## 11. Single timeline selector / FEN-scan fan-out (active)

Panels re-derive board facts per render with no shared selector layer.
Build the timeline once per line change; expose memoized selectors
(row-at-ply, tip, move labels, incremental material) for all panels.
