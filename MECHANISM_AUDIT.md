# Mechanism audit: undocumented intent in the evaluation paths

Rule: if the codebase doesn't describe a mechanism's intent, the mechanism is
either unneeded or needs documentation. Each item below has a plain-language
description, a guess at why it is the way it is, the open question, and a
candidate resolution. Work through them one by one; fix after the tour.

## 1. Batch preemption kills foreign jobs — DOCUMENTED, fix proposed
- Where: `frontend/src/useServerBatch.ts` (busy-path cancel + resubmit; intent comment at the submit handler)
- What: on 409 against different content, DELETEs the running batch and submits ours.
- Guess: newest visible line wins so a forgotten tab can't hold the only slot hostage; finished plies survive in cache.
- Open: branch can't tell our own dying job (DELETE race on line change) from a foreign tab's live job.
- Candidate: ownership distinction — cancel + resubmit only for own jobs (plus tombstone for just-cancelled id), wait politely otherwise.

## 2. Prime lookup aborted on every line change
- Where: `frontend/src/useBulkPrime.ts:39` (abort on `loadKey` change)
- What: in-flight read-only `/evaluations/lookup` is aborted per move and re-asked from scratch.
- Guess: one teardown path for everything; nobody distinguished invalidated work (batch on wrong line) from still-valid work (content-keyed cache reads).
- Open: why pay for the same lookups twice plus badge flicker, instead of letting it land and merging rows?
- Candidate: let lookups land; abort only when superseded by a newer lookup for the same content.

## 3. Running foreground fetch killed when superseded — DOCUMENTED, fix proposed
- Where: `frontend/src/reviewCoordinator.ts:124` (latest-wins preempt aborts the running fetch)
- What: a superseded request is aborted even mid-flight.
- Agreed: two states want opposite handling. Queued (never sent): dropping from the queue is free and correct. Running (fetch in flight, engine possibly computing): aborting saves nothing — the server slot is non-preemptive, so the work completes and caches regardless; the abort only blinds this tab to a paid-for answer.
- Direction: stop aborting running fetches; drop only still-queued ones; keep storing everything that validates (content keys make landing always safe; takebacks may reuse it). Pending flags already follow latest-wins, so spinners stay honest. Wrinkle: the coordinator tracks one running slot per engine — widen to a small set with generation checks.
- Not yet implemented.

## 4. Play retry budget 3 x 2s, then blank forever — DOCUMENTED, fix proposed
- Where: `frontend/src/usePlayFeedback.ts` (foreground retry bucket)
- What: 3 attempts, 2s backoff per line+settings; persistent failure blanks badges with no further retry and no surfaced state.
- Agreed: the numbers cover transient blips during reply churn, but one budget treats unlike failures alike.
- Direction: three behaviors — quick bounded retries for transient errors; no retries while offline, one retry on the browser `online` event (analysis batch tracking already listens for it); a visible error, not a blank badge, for sustained server failure.
- Not yet implemented.

## 5. Sync admission waits and engine_busy retries
- Where: `frontend/src/evaluationTransport.ts:23` (2 retries, Retry-After clamped 100ms-5s); `backend/engine.go:42` (30s Play / 10s Focus waits)
- What: fixed retry counts and waits around the single engine slot.
- Guess: tuned so interactive lanes ride out one batch op, per the "waits at most one batch op" yield.
- Open: what busy duration counts as transient vs a sustained drain that should surface? Why 30 vs 10?
- Candidate: derive the numbers from engine budgets in a comment, or expose busy state in UI.

## 6. Global 150s fetch deadline
- Where: `frontend/src/evaluationTransport.ts:3`
- What: every engine fetch fails after 150s.
- Guess: backstop above the slowest legitimate op (`moveWait` 120s) so hung fetches can't hold UI/scheduler state.
- Open: what slow-but-legit search is assumed dead at 150s? Callers map it to unreachable/busy — is that honest?
- Candidate: document the mapping to engine budgets, or split deadlines per lane.

## 7. Batch join-retry loop attempts
- Where: `backend/reviews.go:83`
- What: `executeSF`/`executeMaia` re-read cache on `ErrJoined`, up to 3 attempts.
- Guess: assumes the join/cancel race (cancelled owner, joiner re-enqueues) settles quickly.
- Open: what if it doesn't — does a batch index fail permanently needing manual resubmit?
- Candidate: document the assumed race, or surface join-exhaustion distinctly.

## 8. 79m-to-5m silent fallback
- Where: `backend/engine.go:437`
- What: unexpected 79m errors fall back to 5m, served `degraded:true`, with no intent comment.
- Guess: partial predictions beat no predictions during play.
- Open: why fallback instead of failing — what assumes the small model succeeds when the large crashed, vs masking a 79m outage?
- Candidate: document when fallback is (in)appropriate, or fail loudly for protocol-level 79m errors.

## 9. Single persisted-batch slot across tabs
- Where: `frontend/src/batchReview.ts:18`
- What: one `{jobId,lineKey,keysHash}` entry; a second tab/line overwrites it.
- Guess: "server runs one batch, so latest submit is the active job" — single-actor assumption again.
- Open: what reattaches the orphaned tab — reload shows Analyze while its job still runs?
- Candidate: per-tab entries, or document the overwrite as accepted with the attach-on-resubmit path as recovery.

## 10. History hydration dropped on epoch move / any delete
- Where: `frontend/src/gameRepository.ts:191`, `:119`
- What: arrived page dropped if epoch moved; any delete aborts all hydration.
- Guess: local play wins over background fetches; deletion invalidates the list being built.
- Open: why drop vs merge the page; why does an unrelated delete abort everything — is the resulting gap noticed?
- Candidate: merge pages by id, scope delete-abort to the deleted game, or document.

## 11. Migration defaults without validation
- Where: `backend/game_migrations.go:6` (`temperature DEFAULT 0`, `result DEFAULT ''`)
- What: old DBs backfilled silently; 0 means deterministic/cacheable, changing cache identity.
- Guess: no pre-temperature sampled games exist in practice.
- Open: is that true — could a legacy sampled game be silently misgraded?
- Candidate: validate or version-gate the backfill, or document the assumption.

## 12. (Reference) Well-documented intent — the bar
- `backend/evaluations.go:78-85`: DELETE-then-INSERT for LRU-rowid refresh, plus why no read-touch.
- `backend/reviews.go:481-484`: batch yields per entry so interactive waits at most one op.
