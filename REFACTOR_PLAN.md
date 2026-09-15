# Refactor plan (living, from review thread 2026-09-15)

## Intent
LAN-first self-hosted Play vs Maia + Analyze (Maia + Stockfish) + History. Single container. Server owns ordering, identity, persistence. Browser owns rendering + what it still needs.

## 1. Scheduler: 3 lanes, endpoint-implied — AGREED
`POST /move` → Play, `POST /evaluate` → Focus, `POST /reviews` → Batch. No `X-Priority` header. One slot per engine, non-preemptive, grant order Play > Focus > Batch. Play depth 1 latest-wins, Focus depth 1 latest-wins, Batch FIFO per jobID. Dedup-by-hash across lanes, empty key never dedups. `superseded` = replaced (don't retry), `503 + Retry-After` = overload, `409 batch_busy + runningJobId` = single-active background. Batch drain yields to interactive between entries.

## 2. Abort scopes — AGREED
Scope `{ lineKey, gameId? }`. Line change/unmount aborts foreground controller (disconnect → server drops ticket) + `DELETE /reviews/:jobId` on scope match. Game delete cancels its jobs, drops pending UI, keeps settled cache. Branch collapse = line change. Backgrounding never aborts batch. Delete `clearForeground/suspend/JOB_STALL_MS` paths.

## 3. Persistence: keep guard, trim implementation — AGREED
Keep versioned outbox + pending-wins + compare-swap + recovery/export. Delete v1 migration branch, second lock name, `durableVersions` set, half-coalescer, `HistorySyncStore` mirror. Document epoch/page subtlety.

## 4. Cache identity: keep semantics, simplify mechanism — AGREED
Keep superset reuse (5→2 lines must not recompute) + `initialFen` (custom-start future, repetition history). Change: reject inconsistent triples (never file invalid rows); single lookup by `(position, policy-without-lines)` storing max lines instead of 0..5 rebuild loop; validate once on write, shape-check on read (drop recursive strict walkers + 3x unmarshal); frontend cache-dumb via opaque `{key, value, actual_settings}`.

## 5. Single executor: unify, keep strictness flag — AGREED
One `resolve() + execute()` for `/move`, `/evaluate`, `/reviews` entries; `lookup` reuses `resolve` read-only. `/move|/evaluate` = size-1 batch. Keep forgiving-live vs strict-batch as a flag (live serves degraded fallback, batch per-index fails for live retry), keep detached background contexts + intake filter + write-through. Delete tripled admission/timeout/probe + fourth lookup switch.

## 6. Timeline: delete historyId, unify keys — AGREED
Delete unstable `historyId`. Add `getRow(timeline, ply)` + `tip(timeline)` views, memoize tip per moves reference, stop full re-walks per read. One `posId = hash(initialFen, prefix)`, `reviewKey = posId + engine + settingsHash`. Keep history-aware terminals + prefix-sharing LRU.

## 7. Review grades: compute once — AGREED
One `computeQualities` call site. `summarizeReview(nodes, qualities)` reads turn/ply from typed rows, reuses averaged accuracy, shares labels. Delete dead narrow panels, single `reviewState: loading|partial|complete|failed` drives the action button. Split god `State` into play/analysis/ui slices, move nav side-effect to effect.

## 8. Tests/build/docs/openings — AGREED
Tests to `go test` + pure-logic vitest + 1 Playwright smoke; demote perf sim, StrictMode rebuild, real-engine tests to nightly/manual. Dockerfile: keep layer cache (rebuild cost negligible), but remove `go test` from build, delete `Dockerfile.stockfish-test`, consider monthly prebuilt engine image. Docs to usage README + generated architecture limits; delete stale coverage section, fix command names. Openings artifact to lazy asset/endpoint or drop if label-only.
