# Refactor plan — separate subsystems instead of guarding them (v2)

Historical planning record. The findings and proposed phases below retain their
original context. See [README.md](README.md) for current usage and links to
the maintained frontend and backend architecture documentation.

Source: external evaluation (2026-09-14, 7 findings) + local verification
against `frontend/src`. Plan only; no behavior changes yet.
Review: plan-reviewer v1 returned REVISE (2 blockers, 8 majors); addressed below.

## Finding → phase map

| # | Evaluation finding | Phase |
|---|--------------------|-------|
| 1 | `App` mounts Play + Analysis engines always (`active`, `subscribeNone`, `suspend`, mode guards) | 1 — workspace split (do first) |
| 4 | Duplicated "what is this position?" (`nodes`, `terminalFlags`, `replay`, `isMaiaPosition`, `lineRecord`, `currentPosition`) | 2 — canonical timeline (with 1) |
| 3 | Maia Elo/pinning/staleness second state machine in `useReview` | 3 — collapse into cache identity |
| 2 | `ReviewCoordinator` as task framework (~46 KB, foreground can invalidate UI) | 4 — store vs scheduler split |
| 5 | Sync compensating for rerenders (`ANIMATION_DEFERRAL_MS = 250`) | 5 — session vs sync state |
| 6 | Outbox snapshot amplification O(N²) | 6 — coalescing (cheap, early) |
| 7 | Whole-line `AnalysisRecord`s overlapping eval cache | 7 — coverage-derived completion (backend, last) |

Target: `route/page → canonical chess timeline → evaluation store →
simple prioritized evaluator`, sync beside render path. No wholesale rewrite.

## Verified baseline

- `App.tsx:70-71` calls both `useReview(state)` and `usePlayFeedback(state)`
  unconditionally. `useReview.ts:131-136` stays mounted-but-unsubscribed via
  `subscribeNone`; `:254` suspends on cleanup.
- `reviewCoordinator.ts` 831 lines; `useReview.ts` 486 lines; coordinator test
  1024 lines. Coordinator owns LRU, keys, prime/restore, foreground/batch,
  abort/preempt, retries, stall resume, progress, failure, versions, timing,
  Stockfish-superset reuse, terminals.
- `useReview.ts:177-253,427-454`: `maiaMemory`, `prevMaia`, `lastFocusRef`,
  `pinnedIdentity`, `selectMaiaDisplay`/`backfillMaiaMemory`, render-phase setState.
- `reviewKey` already folds Elo/model/policy/`MAIA_REF` (`reviewCoordinator.ts:54-56`);
  `settingsForNode` already pins Maia moves (`useReview.ts:173-176`).
- Prime/restore is explicitly NOT record-gated (`useReview.ts:321-335`,
  `reviewCoordinator.ts:611-672 primeLine`, `ReadPanels.tsx:107-109`).
- Commands: `npm test` = `vitest run src`; `npm run test:browser` = build +
  `playwright test` (`tests/board|games|review|settings|badge-loading|stockfish-dup.spec.ts`);
  `npm run test:perf` = profiling build + `playwright.perf.config.ts`.

## Phase 0 — guardrails

> Browser-suite baseline (2026-09-14, verified against clean HEAD worktree):
> 10 `review.spec` failures (overview/graphs :144/:168/:221/:255/:268,
> :320/:346/:402/:412) + `settings.spec` 360px + flaky :433 fail identically
> on unmodified HEAD — pre-existing, not refactor regressions. `games.spec`
> (3 tests incl. offline-boot/retry) passes solo; `games:98` flakes under
> parallel combined runs on both trees (worker contention). Per-phase
> acceptance is therefore "failure set identical to HEAD", not "green".
> The wiped E2E-session WIP had been adapting specs to default-on bottomNav.

- Clean tree first (audit 2026-09-14): `frontend/src/useReview.ts`
  TEMP-DIAG `__primeLog` tracing + 5 dirty spec files must be reverted or
  committed before any baseline; `REFACTOR_PLAN.md` itself is untracked.
  Record `npm test` + `npm run test:browser` (review/games specs) green after.
- Safe set (behavior-preserving, lands with Phase 0): remove TEMP-DIAG,
  dev-gate `reviewCoordinator.ts:504` batch-timing log, lazy-load or
  DEV-gate `EvalLoadingLab` (`BoardRouter.tsx:12`, ships as `lab-page` in
  prod bundle ~132 KB gzip single chunk), move `testNodes` out of prod
  `domain.ts:75` into test-utils, add `.env.example`
  (`MAIA_API_TARGET`, `MAIA_BUILD_DIR`). Minimal CI (test + typecheck +
  build) as guardrail work — repo has no workflows/lint today.

- Keep `terminalFlags` vs per-prefix replay equivalence (`state.test.ts:499-518`);
  record `npm test` + `npm run test:browser` (review, games specs) baseline green on master.
- Outbox growth probe: measure N offline saves → storage entries/bytes, record
  as baseline. The bounded-storage assertion is **fail-first / expected-fail**
  until Phase 6 (current `pushOutbox` appends full snapshots by design,
  `serverGames.ts:131-135`); do not gate Phase 0 on it. (F4)
- Suites that must stay green through every phase unless deliberately
  reorganized in a separate commit: `reviewCoordinator.test.ts`,
  `maiaMemory.test.ts`, `serverGames.test.ts`, `analysisRecords.test.ts`,
  `state.test.ts`, `usePlayFeedback.test.tsx`. (F9)

## Phase 1 — mount Play/Analysis independently (do first)

Goal: analysis coordinator does not exist while on Play and vice versa.

- Introduce `PlayWorkspace` / `AnalysisWorkspace` under `App`. `useReview`
  mounts in analysis subtree only; `usePlayFeedback` in play subtree only.
- Assign every `review.*` read in the shared shell before splitting (F1):
  - Analysis-owned → move into `AnalysisWorkspace` with the hook:
    `App.tsx:80` `review.nodes[ply]` position, `:105` `review.nodes[last].sanMoves`,
    `:110` `arrowMoves` (**currently unguarded** — must become analysis-only),
    `:111-112` quality/uci, `:161` `review.tooLong/current/currentError` eval bar,
    `:171` `InsightPanel review={...}` (+ downstream `Review` consumers:
    `ReadPanels.tsx:41,63,140,304`, `ReviewCharts.tsx:2`, `ReviewOverview.tsx:4`).
  - Shared-but-split: `:164` `MovesPanel` takes only `qualities`
    (`ReadPanels.tsx:730-758`), so each workspace passes its own
    (`review.qualities` vs `moveFeedback.qualities`) — no `Review` prop to share.
  - Correction to v1 risk note: `MovesPanel` is NOT a `Review` consumer;
    `InsightPanel`/MoveAnalysis/`ReviewOverview`/`ReviewCharts`/`StockfishBar`
    inputs are. (F1)
- Delete dead guards after the move: `active` plumbing, `subscribeNone` usage,
  `suspend()`-on-inactive, "must not re-render play" comments,
  `App.tsx:79-115` mode ternaries that the split subsumes.
- Keep hook return shapes unchanged in this phase; only mount points move.
- Acceptance (greppable, F9/N2): play↔analysis↔history navigation green;
  `npm test` + `test:browser` review/games specs pass with mount-only test
  updates in a separate commit; new spy asserts **zero `/move`+`/evaluate`
  analysis requests during a play-only session** (request-count harness, not
  "timing log"); coordinator suites pass **unmodified** in this phase.

## Phase 2 — canonical chess timeline (with Phase 1)

Goal: one pure producer; hooks and reducer do lookups.

- Add pure builder in `domain.ts` (same level as `terminalFlags`/`lineRecord`),
  NOT hook-local (F2 — `state.ts` reducer cannot read hook memos; `commitMove`
  `:91` parses per commit today):
  `buildTimeline(initialFen, moves) → rows[]` with single row type (F3/N1):
  `{ ply, uci, san, fen, turn, terminal, lastMove }` where `terminal` uses the
  ONE representation agreed here (`Evaluation | null`, replacing the current
  three: `LineRecord.terminal`, `terminalFlags` boolean, inline
  `terminalEvaluation`), `ply` + shared move-array prefix reference (no per-node
  `moves`/`sanMoves` array copies — fixes the O(N²) memory shape v1 preserved).
  Must cover `START_FEN` play lines and arbitrary-`initialFen`/branch analysis
  lines, with repetition draws identical to per-prefix `replay`.
- Call sites: `useReview` walk becomes one call; `usePlayFeedback.ts:188-210`
  walk + `:80-111` fen-walk migrate to it; `state.ts:56 currentPosition` and
  analysis `commitMove` legality path read from it; `isMaiaPosition` drops its
  `replay` + `new Chess(fen)` (takes `turn`/`terminal` from the row).
- Explicit scope: play `lineRecord` memo stays only until all play readers
  (`App.tsx:85-105`, `maiaTurn`, feedback) move to the builder; no third
  timeline implementation is added — v1's "keep lineRecord, unify later" is
  replaced by this migration list. (F3)
- Acceptance: equivalence test (rows == per-prefix `replay`, incl. repetition)
  in `state.test.ts` or `domain` suite; `replay` gone from `isMaiaPosition`
  and analysis render path; new observable (F5): count `buildTimeline` builds
  per `lineKey` (or replay-call spy on analysis path) and assert arrow-key
  steps do zero rebuilds — named counter, not "lineRecordMisses-style".
- Implemented deviation (perf-justified): the play tip (`maiaTurn`,
  `PlayWorkspace` tip derivations) stays on the `lineRecord` memo for O(1)
  view/step commits; a tip-equivalence test (`lineRecord` vs builder) pins
  parity. `computePlayQualities` keeps its single-pass O(N) walk (it needs
  prefix slices for lookups anyway). Full play migration waits for the Phase
  4 store split.

## Phase 3 — collapse Maia pinning/staleness into cache identity

Goal: delete the per-ply temporal memory system. Scoped to UI deletion (F8).

- Reuse existing keys — `reviewKey` + `settingsForNode` already encode the
  per-node identity. No rekeying in this phase; key-function ownership moves
  to Phase 4.
- Delete `maiaMemory`/`prevMaia`/`lastFocusRef`/`selectMaiaDisplay`/
  `backfillMaiaMemory`/render-phase setState (`useReview.ts:177-253,427-454`);
  display rule: ask `{ node, requestedIdentity }`, show most-recent cached row
  while requested loads.
- Acceptance: `maiaMemory.test.ts` scenarios rewritten as cache-identity
  display tests against the UNCHANGED coordinator API (Phase 4 reshapes it —
  keep these tests UI-level so they survive); own-game pinning behavior
  preserved; net deletion of the state machine.

## Phase 4 — split evaluation store from job scheduler

Goal: `foregroundAt()` cannot invalidate the analysis UI.

- Store owns: `reviewKey`/`cacheHash`, LRU/memory cache, result/error/pending
  reads, version bump. Scheduler owns: foreground-pair → batch-rest priority,
  abort/preempt, retry, stall resume. Timing, Stockfish-superset slicing,
  terminal short-circuit move behind seams. (F8: key ownership lands HERE.)
- Acceptance (behavioral first, F9): coordinator suites pass **unmodified**
  first; store/scheduler reorganization lands as a separate commit;
  regression test: foreground navigation never clears settled rows. Drop v1's
  `< ~400 lines` target as a gate — size is an observation, not proof.

## Phase 5 — separate GameSessionState from HistorySyncState

Goal: delete `ANIMATION_DEFERRAL_MS` without reintroducing the hitch. (F6)

- Enumerate the seam before moving: writers `state.ts:28,51-54,163,267-290`
  (`sync`/`sync-error`/`sync-pending`/`retry-sync`), effects
  `useMaiaBoard.ts:83-153` (persist/delete/flush keyed on
  `state.play`/`state.saved`/`flushNonce` — flush triggers necessarily keep
  subscribing to game state); readers `App.tsx:154` banner,
  `ReadPanels.tsx:902-906` saved-panel `syncPending`/`historyTotal`.
- New home: separate sync store/context + isolated indicator/banner components
  subscribed to sync state only. Game reducer stops carrying `syncPending`.
- Acceptance (automated, not manual): board-stage render/commit count unchanged
  across a `sync-pending` dispatch (or equivalent commit-count assertion);
  update `state.test.ts:464-487` `createDeferredDispatcher` tests to the new
  boundary; then remove `ANIMATION_DEFERRAL_MS` + dispatcher; offline→online
  retry still works (`games.spec.ts`).

## Phase 6 — outbox coalescing (after Phase 0, anytime)

Precise rule (F10):

- In `pushOutbox`, collapse within **consecutive-only runs** for the same game
  id: a run breaks on `delete` or a foreign-id op. Within a run keep the latest
  snapshot; `current` marker = last op in the run that carries `current:true`
  (never inherit `false` over an earlier `true`, never cross a `delete`).
- Decide write-time (`pushOutbox`) coalescing; flush order otherwise unchanged.
- Acceptance: offline N-move game = one save entry, O(N) move data;
  `serverGames.test.ts` green + new test covering save→delete→save (no
  resurrection) and `current`-marker preservation; `mergeSync`
  touched-ordering asserted for coalesced vs uncoalesced inputs.

## Phase 7 — derive line completion from coverage (backend, last)

Narrowed scope (F7):

- Keep `primeLine` (`reviewCoordinator.ts:611-672`) — it is NOT record-gated
  today. Delete only record status/write-back: `checking/fresh/stale/none`
  effects, `putAnalysisRecord`/`isFreshRecord` gating, `analysisRecords.ts`
  APIs.
- Backend-first: new `line coverage` endpoint returning cached
  evaluations/coverage for `{ initialFen, moves, settings }`; frontend derives
  fresh/stale/completed from actual rows. Landing order: endpoint (or stubbed
  contract) first so each side stays green.
- Implemented 2026-09-14 (Option A): `GET /evaluations/coverage?hash=…`
  (≤1024 hex hashes, chunked `IN` query) returns
  `{rows: {hash: {engine, key, value}}}`. Single image → no version skew.
  `/analyses` routes, `analyses.go` + tests, table DDL, README section
  removed (old DBs keep an unread `analyses` table). Store seeds from one
  bulk round trip (`fetchCoverage` with the same stuck-socket race as
  probes); per-job probes only for misses. Record status derives from
  prime+coverage; `analysisRecords.ts` deleted; spec mocks serve coverage.
- Doc fix: contract goes in root `PLAN.md` API section (product contract —
  exists), not this file. (F7 doc-path correction.) Done (PLAN.md
  Analysis persistence section).
- Acceptance: cold full-coverage load renders with zero inference; partial
  coverage gates exactly missing positions behind one explicit click —
  without `analysisRecords.ts`.
- Open (C3): answered — Option A, `GET /evaluations/coverage`, backend-first,
  implemented same session.

## Order, verification, non-goals

- Order: 0 → 1 + 2 → 6 (cheap) → 3 → 4 → 5 → 7.
- Per-phase: name suites that pass unmodified first; reorganization/updates as
  separate commits; pipeline gates `npm test` always, `test:browser`
  (review/games/settings/board specs) for Phases 1/2/5, `test:perf` only if a
  phase claims a perf win.
- Non-goals: no second-engine work, no UI redesign, no inference-chain
  (79M→5M) or Elo-mapping changes, no public exposure.
- No phase adds new cross-subsystem guards — separation, not memoization.

## Code review (CHANGE v1) disposition

- ACCEPT F1 (parseEvaluation winner branch restored verbatim), F2
  (same-identity stale shows kept row, stale=false), F3 (clear-before-write
  effect order + exhaustive deps), F4 (reset-key narrowing documented as
  intentional — cross-mode nav remounts workspaces), N1 (dup comment), N2
  (effect deps), C5 (merge-equivalence test added).
- REJECT N3 (repo uses npm; `package-lock.json` committed, no pnpm lockfile).
- Evidence: `tsc --noEmit` clean + `npm test` 212 pass on this diff; browser
  parity verified against clean-HEAD worktree builds (identical failure sets;
  pre-existing failures listed above). Coordinator suite grew by pure addition
  (foreground regression test); reducer/sync/memory suites updated where the
  plan deletes the actions/helpers they covered. Render-count infra absent
  (no RTL) — structural key-absence test + `games.spec` offline/retry green
  stand in.
- Residual: `legalPrefixLength` vs builder FEN normalization edge untested;
  `timelineBuilds` counts throws (test-only counter).

## Code review (CHANGE v3/v4) disposition — Phase 7

- ACCEPT F1 (prime-dep line identity restored), F2 (corrupt row skips,
  chunk survives), F3 (bulk degraded test added), N1 (dead proxy),
  N2 (dead Loading arm dropped). Delta review: all discharged, no new defects.
- Evidence: `CGO_ENABLED=0 go vet` + `go test ./...` pass (this env lacks
  libc headers for default cgo); `tsc` clean; `npm test` 208 pass;
  browser parity — converted stale-record test and badge-loading now pass,
  games 3/3 green, remaining failures identical to HEAD.

## Reviewer disposition (v1 → v2)

- ACCEPT F1–F10, C1–C2, N1–N2 (all applied above).
- NEEDS DECISION C3: answered (Option A) and implemented as Phase 7 above.
