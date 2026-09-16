# Jobless batches: dissolve the review job into keyed single evals

Status: SUPERSEDED (not implemented). The cancel-removal direction
(`CANCEL_REMOVAL_SPEC.md`) keeps jobs as progress records and achieves the
goals without dissolving the job layer. Retained as a record of the
rejected alternative and its review findings.

## 1. Claim

A review batch is N single evaluations at the compute layer (one shared
resolve + execute path for `/move`, `/evaluate`, and `/reviews` entries,
`backend/reviews.go:25-33`, writing through to the same `evaluations_v2`
cache). Everything job-shaped about it — ID, single-active slot, 409 busy,
attach/reattach, persisted entries, tombstones — is client-UX bookkeeping
that creates more problems than it solves:

- Item #1 (preemption/ownership): only exists because one job holds the slot.
- Item #9 (single persisted slot across tabs): only exists to reattach to jobs.
- Per-ply cancel/resubmit churn (just removed from play): only needed because
  a stale *job* blocks the slot.

Dissolve the job. Every entry becomes an anonymous scheduler ticket keyed by
content identity. What remains is enqueue (FIFO), cancel by key, cache
write-through, and client-side progress counting. No slot to hold, so nothing
to preempt, steal, or reattach to.

## 2. Goals / non-goals

Goals: no 409s ever; no cross-tab kills (you can only cancel your own keys);
reload recovery falls out of the normal path (resubmit misses); duplicate
submits coalesce via scheduler join; failure visibility without job state.
Non-goals: changing compute, cache identity, or sync `/evaluate`/`/move`
semantics; per-client fairness beyond FIFO; durable (restart-proof) queues.

## 3. Current mechanics being replaced

- `POST /reviews` validates + intake cache-filters (`resolveBatchEntry`,
  `reviews.go:302-331`), 409s when a job is active (`:360-370`), creates a
  job record (`maxKeptJobs = 8`), drains per engine in background on detached
  contexts (`drain`, `:485-534`), and serves status/DELETE/SSE off the record
  (`:441-473`, `:594-673`).
- Client (`frontend/src/useServerBatch.ts`, `batchReview.ts`): submit,
  busy-attach-or-cancel, SSE + poll progress, prime on progress, persisted
  reattach entry, tombstones (just added for #1).
- Untouched: scheduler lanes and priorities, ticket dedup/join
  (`backend/scheduler.go`), intake resolve + cache-filter logic, cache schema,
  sync endpoints, SSE *mechanism* (deleted with its only consumer).

## 4. Proposed API

`POST /evaluations/compute { requests: lookupRequest[] }` (same entry shape
as today, `maxBatchRequests = 512` retained):

- Resolve each entry with the shared resolve (invalid entries do NOT fail the
  submit; see response shape).
- Cache-filter; misses spawn a detached per-submit pump (one goroutine per
  engine over the miss list, mirroring `drain` without the job record).
- `200 { results: [{ index, status: 'cached' | 'queued' | 'failed' | 'invalid',
  error? }] }`. `failed` covers synchronous failures (e.g. evaluator absent
  with SF misses — today's 502 becomes per-index). `invalid` carries the
  entry's resolve error. Partial accept is the point: one bad entry never
  blocks the rest.

`DELETE /evaluations/compute { requests: lookupRequest[] }`:

- Resolve each to its scheduler ticket key(s) and `CancelQueued` them.
- `200 { cancelled: n }`; unknown/already-running keys are no-ops (running
  work always finishes + caches, as today). Cancellation stays an
  optimization (skip the queue for the new line), never correctness.

`POST /evaluations/lookup` gains failure visibility: alongside `results`,
return `failed: { "<index>": "<message>" }` for requested keys present in the
failed registry (below). Without this, a failed key is indistinguishable from
a queued one and the client can never stop retrying.

## 5. Server design

- Pump per submit: for each engine with misses, one goroutine claims entries
  pending→running (in-memory list, same as `claim`), executes via the shared
  `executeSF`/`executeMaia` with `PriorityBatch`, detached contexts, and the
  existing join-retry + write-through. Delete `ReviewJobs`, `batchJob`,
  `activeProgress`, `maxKeptJobs`, job IDs, and the per-entry SSE fanout.
- Ticket keys (must match exactly what the runner enqueues):
  - SF: `sfIdentity(req).coordinates()` hash (`evaluate.go:180`).
  - Maia: `maiaIdentity(req, workerName).coordinates()` hash **per worker**
    (`engine.go:152-155`) — or `""` when `Temperature != 0` (no dedup, no
    cancel; batch maia is always deterministic/temperature-0, state this as
    an invariant). Cancel fans out across both worker schedulers + evaluator,
    each deriving its own worker-specific key from the resolved request.
  - Batch lane keeps today's unbounded wait (detached, no client deadline).
- Join coalescing replaces 409: a duplicate key (double-click Analyze,
  reload resubmit, two tabs) joins the in-flight ticket and re-reads the
  cache on completion (`scheduler.join`). No busy path, no attach logic.
- Failed registry (replaces per-index job errors): map content-key →
  `{ message, time }`, bounded (~512 entries, evict oldest) with TTL (~10
  min); cleared when the key later caches successfully. Keyed by the same
  content identity, so a failure is meaningful to every client, unlike job
  progress. In-memory only: restart loses it, and the next resubmit
  rediscovers failures (documented, same as today's eviction story).
- Logging: keep the per-key timing line (today's per-entry line in
  `job.complete`) and the submit cached/pending counts; drop job-id fields
  (or log a submit id purely for correlation — no lifecycle attached).
- Strictness preserved: batch entries keep `strictBatch=true` (degraded Maia
  fallback fails per-key instead of caching).

## 6. Client design (analysis only; play is already batch-free)

Replace `useServerBatch` with a small compute-queue hook (~80 lines):

- `start(requests)`: POST compute, keep the wanted key set (content keys in
  the client's scheme). No persisted entry, no teardown DELETE of anything
  but our own keys (optional cancel of the previous wanted set on line
  change — optimization only).
- Progress = `primeCoverage` over the wanted set (already exists): no server
  progress to track. Prime on an interval (~2s while uncovered) plus on
  foreground settles and `online` events.
- Failures from the lookup `failed` map; Retry button resubmits missing keys.
- Reload/reattach falls out: remount recomputes the wanted set from the line
  and submits misses — identical to the fresh path. Delete `BATCH_PERSIST_KEY`,
  mount reconciliation, the SSE+poll tracker, `classifyBusyJob`/tombstones
  (#1's machinery — removed by this design, not worked around), and the
  game-delete broadcast cancel (orphaned pumps drain harmlessly into cache;
  optionally cancel own keys).
- `ReviewActionButton` progress text switches from batch progress to
  covered/total from prime coverage.

## 7. Migration

1. Add the two endpoints + failed registry alongside `/reviews` (no client change).
2. Migrate the analysis client to the new hook; keep `/reviews` server code until cutover.
3. Delete `ReviewJobs`, job endpoints + SSE, client batch machinery, tombstones.
4. Backend Go tests for the new endpoints (per-index verdicts, cancel-by-key incl. per-worker fan-out, failed-registry TTL/clear-on-success, join coalescing, invalid-entry partial accept). Frontend: rewrite the analysis batch specs around submit/miss/retry; play specs untouched.

## 8. Edge cases

- Double submit / reload mid-run / two tabs same line: join coalescing, zero special cases.
- Line change mid-run: old pump drains into cache (useful on takeback); client optionally cancels its old keys.
- Restart mid-run: pumps die; client resubmits misses (same as today).
- Duplicate keys in one submit: dedup at intake (second gets `queued`, joins).
- Evaluator absent: synchronous per-index `failed`, no pump.
- Abuse: tight resubmit loops re-enqueue FIFO tickets; same exposure as today's lane, minus the 409 backstop — note, monitor via submit logs, rate-limit later if real.
- Prime-poll cost: one small lookup per ~2s while uncovered; bounded by completion, no stream to leak.

## 9. Open questions for review

- Failed-registry cap/TTL numbers (512/10min proposed without measurement).
- Prime-poll interval while uncovered (2s proposed).
- Correlation id on submit logs: keep a lightweight one or drop entirely?
- Keep `Retry-After` anywhere (no 409/503 from this path anymore; sync lanes keep theirs)?
