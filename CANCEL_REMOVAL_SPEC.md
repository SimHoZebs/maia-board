# Cancel removal: no cancel paths, rotation-ordered batch lane

Status: SPEC v6 CONFIRMED by review (rounds v1–v5 addressed). Awaiting
implementation approval. Not implemented.)

Supersedes: per-submit round-robin sketch (cursor unspecified), key-recency
ordering (wall-clock ties, NTP hazards, unbounded stale starvation). The
full jobless rewrite (`JOBLESS_BATCH_SPEC.md`) stays superseded: jobs remain
as progress records.

Threat model (agreed, see `MECHANISM_AUDIT.md`): trusted LAN/tailnet, single
household, no auth. No adversarial abuse; bounds exist for runaway clients
and worst-case waits. Per-client fairness waits for internet exposure.

## 1. Ordering: rotation across submit groups, FIFO within

Batch-lane tickets carry `submitSeq`, a scheduler-local ordering nonce
assigned once per accepted submit from a process-wide atomic counter. This
is NOT an identifier: never exposed via any API (negative test: absent from
GET/SSE/429 bodies and logs), never persisted, never used for
cancel/ownership/attach. Threading (explicit, replacing `batchID` at every
site): intake sets `entry.submitSeq` from one atomic increment per accepted
submit; `executeSF`/`executeMaia` pass it through `predict`/`run` into
`Acquire` into `ticket` — the same signature path `batchID` uses today
(`scheduler.go:39,79,143`; `engine.go:86,143,419`; `evaluate.go:179`;
`reviews.go:75,112`), enumerated so none is missed.

Scheduler keeps `batchCursor uint64` (last-served submitSeq) **per
scheduler** — one cursor each for the evaluator and worker schedulers, since
SF and Maia drain independently and never share a lane. The submit nonce
comes from **one process-wide atomic**, incremented once per accepted submit
**after** the cap check passes (rejected submits consume nothing).
`uint64` never wraps practically; no handling. Gaps are expected (an
SF-only submit advances the shared counter without creating Maia tickets)
and harmless under the wrap rule. Sync tickets carry sentinel `0`,
excluded from the batch-lane scan, and sync grants never touch the cursor.
Threading: `batchEntry` gains `submitSeq`, set at intake; `runSFEntry`/`runMaiaEntry` pass the entry's stamp (never a
fresh value at lazy-`Acquire` time — re-stamping at admission would void the
ordering proof) through `predict` (`engine.go:143,419`) / `run` (`evaluate.go:179`) into `Acquire`
(`scheduler.go:79`, `engine.go:163`, `evaluate.go:186`) into `ticket`
(`scheduler.go:39,143`). Grant rule for the batch lane, under `s.mu`: among queued batch tickets, serve the smallest
submitSeq strictly greater than the cursor; if none, the smallest present
(wrap); within the group, FIFO by existing global `seq`. Update the cursor on
grant. Drained groups stop matching by absence; no explicit removal.

- Solo submit: one group → head-pick every grant → bit-identical to FIFO.
- A then B: A,B,A,B… — B starts on the second grant; each completes within
  ~2× solo time. New group C joins the rotation on the next grant.
- Orphans drain fairly and vanish by absence. Dedup-join is orthogonal
  (joiners inherit position; no requeue). Sync lanes and Play>Focus>Batch
  priority untouched; `cancelLocked` untouched.
- Fairness unit is per-submit, not per-client: alternating submitters share
  1/N each. Accepted under the threat model (no attribution without auth).
- Scan cost O(queue) per batch grant, ~1 grant per engine op: trivial.

## 2. Admission: two caps, both counted at the job-record layer

Lazy drain defeats scheduler-depth counting (a submit holds hundreds of
pending entries while showing ~1 queued ticket), so both caps count
accepted-but-unresolved work by scanning unfinished jobs at intake, in two
phases so a large submit never stalls status reads: snapshot the counts
under `js.mu`, release, resolve outside the lock, then re-acquire and
re-check before insert, retrying the whole intake at most once on a lost
race (a concurrent insert landing between check and insert) and 429ing past
that — no unbounded spin; a second collision is backpressure, honestly
reported. Resolve performs only
cache reads with no `ReviewJobs` reentry, so no lock cycle; the re-check
keeps overshoot at zero:

- (a) Unresolved misses per engine scheduler ≤ 512 (`maxBatchRequests`):
  SF misses vs the evaluator scheduler; Maia misses vs their destination
  scheduler — large, or small when `model == "5m"` — and fallback-eligible
  (defined conservatively as every large-model miss: eligibility is
  failure-dependent and unknowable at intake, and over-counting small only
  ever rejects early, never over-admits) large misses additionally count
  against small, since a large outage would
  otherwise pile uncounted work onto it. Once small is over cap, large- and
  5m-destined submits 429 alike — no reservation for either side. Cached hits never queue, never
  count. Basis: worst-case newcomer wait per
  engine equals today's single-active worst case exactly. Per-entry duration
  logs are the named retune trigger.
- (b) Unfinished jobs ≤ 8 (mirrors `maxKeptJobs` family): bounds records,
  goroutines (3/job: drain + 2 engine loops), and the `order` growth that
  ticket caps cannot see. Eviction loop, exact: while `len(order)` exceeds
  `maxKeptJobs`, remove the first *finished* job anywhere in `order`; break
  when none is finished. Records therefore stay ≤ 8 unfinished admitted +
  8 retained finished = 16 worst case (each ≤512 entries).
- Past either cap: reject the whole submit with 429 + `Retry-After: 5`
  (provisional value carried over from the removed 409 signal) and a new
  body code (not `batch_busy`). Client path, intercepted in `submitBatch`
  before the generic branch: parse the header (clamp 1..30s, default 5),
  wait once, resubmit once, else surface engine-busy. Old tabs during skew
  hit the same 429 into their generic error path (accepted;
  single-container deploys bound the window) — covered by two tests,
  neither of which sleeps: a unit test on the header parse +
  single-resubmit guard, and a skew test feeding a 429 into the old generic
  path asserting no crash and the generic message. Invalid entries keep
  today's all-or-nothing submit 400.

## 3. Deletions / keeps (complete)

Delete: single-active gate + 409 producer; DELETE handler (removed route
answers 405 via the existing default; old-tab teardowns already swallow);
`EnginePool.cancelBatch` + evaluator `CancelBatch` call;
`scheduler.CancelBatch`; dead `scheduler.CancelQueued` (zero callers);
`reviewCoordinator.cancelJob` + import and coordinator `cancelQueued` (both
zero callers — dead-code sweep folded in, not a behavior change);
`scheduler.CancelBatch` callers (pool + evaluator, both via the deleted
DELETE path only); drain
`isCancelled` checks + `cancelled` field + `isCancelled` (old-tab
truthiness checks treat absent as false — identical; removal is outright,
no always-false interim); batch
`ErrSuperseded→"cancelled"` mappings (unreachable: detached batch contexts,
supersede touches Play/Focus only); `active`/`activeProgress`;
`BatchBusyError` + producer + branch; `classifyBusyJob` + tombstones +
foreign-wait (incl. the `waiting` return field); `cancelBatch` helper;
`useServerBatch` rewiring: all five cancel sites deleted (busy self-resubmit,
stale orphan, scope teardown, active-false, game-delete broadcast), busy
branch + 409 import removed, stale-orphan guard keeps dropping local
optimism only, scope/teardown comments rewritten to state nothing cancels;
`useLineScope`/`useReview` scope comments updated where they promise batch
cancellation; `ApiErrorCode.batch_busy` + message +
test row; `batchReview.test.ts` busy/cancel cases; backend 409/DELETE tests
(reworked below); `review.spec.ts` DELETE/busy mocks deleted (events-stream
mock stays: SSE is unchanged); `gameRepository.ts:118`
DELETE comment; `batchID` threading at every site above (§1) plus the
`runSFEntry`/`runMaiaEntry` `job.id` arguments they supply; scheduler struct
fields (`batchCursor` added per scheduler).
Keep: job records, status GET, SSE events, `maxKeptJobs` eviction, persisted
single-entry reattach, intake resolve+cache-filter, `maxBatchRequests`,
strictBatch, per-entry logging (job id retained for correlation), yield,
client pending-map prune of never-sent jobs.

## 4. Sequencing and verification

1. Rotation + deterministic scheduler unit tests (exact grant sequences, no
   timing; scheduler has no gate concept so fully isolated). Includes the
   submitSeq non-exposure negative test (absent from GET/SSE/429 bodies and
   logs).
2. Counter helpers as pure functions over job snapshots + cap unit tests
   directly (no HTTP gate involved — the gate only fronts POST, never the
   counting logic).
3. Gate/DELETE/client/mocks/tests atomically, since cap-integration tests
   need the gate down (pre-gate, a second submit 409s first): backend busy
   test becomes two-job interleaved-logs concurrency test, plus the
   check-then-insert race test (two concurrent submits colliding mid-intake:
   overshoot stays zero, loser retries once per §2, then 429s);
   `scheduler CancelBatch` test reworked; `reviews` 409/DELETE tests split
   (409 cases deleted, DELETE-404 case becomes DELETE-405);
   `api.test.ts` `batch_busy` row + `api.ts` union/message deleted;
   `evaluationTransport` 503-only retry untouched (429 is handled in
   `submitBatch`, never reaches it); frontend batchReview minus busy/cancel
   (incl. tombstone-era `classifyBusyJob` ownership cases, superseded with
   the code); browser `review.spec` (DELETE/busy mocks deleted, progress
   text unchanged) + `play-feedback.spec` (regression net).
Suites pre-merge: Go (`reviews`, `scheduler`, `engine`), vitest, browser
review + play-feedback.
