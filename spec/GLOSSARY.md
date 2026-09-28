# Glossary — terminology

Single definition site. All other docs and code comments link here instead of
re-defining. One name per concept — no aliases.

## Position identity

- `position = (initialFen, prefix)` — one board plus the history that produced
  it. `prefix = moves[:ply]`. FEN alone is never identity (repetition and
  custom starts need history).
- `line = (initialFen, full moves)` — the whole loaded game or explored
  continuation. Wire casing `BatchLine {initial_fen, moves}` is the same value.
- `posId = JSON([initialFen, prefix])` — content key for one position.
  Call shapes (same value, different inputs — no new names):
  `posId(initialFen, prefix)` (tuple) vs `stablePositionKey(node)` (node).
  `posId` is also the timeline cache key.
  See `frontend/src/domain.ts:posId`,
  `frontend/src/evaluationStore.ts:stablePositionKey`.
- `lineKey = posId(initialFen, full moves)` — content key for one line.
  Tuple-input: `lineKeyFor(initialFen, moves)`. Node-input wrapper:
  `lineKeyForNode(node)` (takes a ReviewNode, not a tuple). Pinned-settings
  wrapper: `gradingMaiaKey(node)` (grading lane). Abort scopes
  (`{lineKey, gameId?}`) key foreground work by this. The same field name
  recurs for other owners: `PersistedBatch.lineKey` (batch identity,
  `batchReview.ts`) and the openings-cache local (openings fetch guard).
  See `frontend/src/domain.ts:lineKeyFor`.
- `reviewKey = JSON([posId, engine, settingsHash])` — cache key for one engine
  reading. `settingsHash` is `stockfishPolicy` for SF, `[eloMaia, eloUser,
  model, valueElos?]` for Maia. See
  `frontend/src/evaluationStore.ts:reviewKey`.
- `gameId` — durable user-game identity (saved games, current-game marker).
  Never cache identity. Deleting a game orphans nothing. `currentId` is the
  marker, not the identity. `${gameId}|${userColor}` memo scopes and
  `job_id` batch IDs (shared `newHexID` generator, separate namespaces:
  SQLite games vs in-memory review jobs) are not identities.
- `pos_hash / cache_hash / cache_key` — log-only or legacy-client fields.
  Live `/move`, `/move/analysis`, `/evaluate` accept-and-ignore them;
  bulk `/evaluations/lookup`, `/reviews` accept only `pos_hash` and reject
  `cache_hash`/`cache_key` as unknown fields. Server derives identity from
  `(fen, initial_fen, moves)`. See `backend/evaluation_identity.go`.
  Backend identity: `evaluationIdentity.coordinates()` =
  `v2:JSON(engine, fen, initial_fen, moves, settings|elos, model, revision)`.
  Frontend `posId ~= (initialFen, prefix)` slice; `reviewKey ~= hash +
  engine + policy/elos`.

## Evaluation pipeline

One pipeline, named by stage:

1. `evaluation` — one settled engine row. SF `Evaluation` (cp/mate + lines) or
   Maia `MoveResponse` (top_moves + WDL). Stored in `evaluations_v2`, in-memory
   `EvaluationStore`, fetched via `/evaluate`, `/move/analysis`, or bulk.
2. `EngineGrade` — engine-only judgment from loss/criticality
   (`Forced | Allowed mate | Blunder | Mistake | Inaccuracy | Critical | Top |
   Holds | Unreviewed`). No praise, no rarity. Produced by `reviewMove`.
3. `Quality` — displayed judgment after `effectiveQuality + alienUpgrade`
   (engine `Critical → Excellent/Great/Best`, `Top → Best`, `Holds → Good`).
   Badge vocabulary.
4. `verdict` — one-sentence rendering via `describeMove`
   (`quality × rarity + notes`). Never a grade object. Returns `string | null`
   (null = unreviewed/off-book). `QualityMemoEntry` is the memo entry,
   not the string.
5. `candidate` — one entry of `ObjectiveCandidates.entries`
   (`{uci, expected, prob?, delta?}`) rendered by candidate lists.
   Wire shape is `TopMove{move, prob, wdl, delta?}`;
   `move` (wire) vs `uci` (UI) is the only difference.

`review` as a noun is reserved for the retrospective per-move pipeline
(`useReviewPipeline`, `reviewMetrics`). Whole-game server batch jobs are
`batch reviews` (`POST /reviews`) — same grading math, different delivery.

## Value representation

- `expected` — mover-relative expected score 0–100. The only number grading
  cutoffs (`classifyLoss 20/10/5`) read. Maia: `100*(win+0.5*draw)`. SF:
  `whiteWin(cp)` then pov-invert for Black.
- `whiteExpected(turn, expected)` — White-relative view for bars/graphs.
  Converter table (same value, different boundaries — do not add variants):
  `whiteWin(Score→mover)`, `maiaExpected(WDL→mover)`,
  `whiteExpected(mover→white)`, `maiaWhiteWdl(mover WDL→white %)`,
  `outcomeExpected(terminal→mover)`.
- `top` — objective best move (`top_moves[0].move` / `best_move`), null when
  degraded/missing/terminal. Backend asymmetry: SF `BestMove *string` nil for
  terminal vs Maia `Move string + Degraded bool` — document, do not merge.
- `score` — SF White-perspective `{cp|mate}`. `WDL` — Maia choosing-side
  `[loss, draw, win]`. Same position value, different projection.
- `delta / baseline` — read-time derivation
  (`wdlExpected(candidate) − wdlExpected(grading-2400-row)`), never stored.
  Server-attached preferred (`delta_baseline` on served rows), local fallback
  exact (`selectDeltaParts` vs `maiaDisplayParts`).
- `objective = {top, expected}` — request-time composition pattern over
  per-model caches, never a stored combined row (no backend route; frontend
  composes). The seam is role-keyed (`objective/grader`: grading;
  `objective/winrate`: candidate-display math), not model-keyed — swapping
  the grader implementation changes fetches, never grading math. Backend
  `wdlExpected` is the sole backend `expected` spelling; `whiteExpected` is
  frontend view only.

## Cache-fill (one operation)

Canonical verb: `restore`. `store.restore → coordinator.restore →
restoreLookup / useLookupRestore` is one path (cache-fill + visible-pair-first
ordering inside the store). `lookup` is the endpoint name
(`POST /evaluations/lookup`, read-only, never infers). `execute` runs + stores
(single job); `pump` steps the per-engine queue; `ensure({priority})` queues
foreground work. Ownership: coordinator owns `ensure/pump/execute/playMove`;
store owns `restore`; hook owns `restoreLookup` throttling.
Old prose terms for the same operation (no such exports — do not use):
`prime`, `bulk prime`, `hydrate`, `reconcile`, `backfill`.
Coverage: `restoreCoverage`. Lane descriptor: `restoreDescriptor`.
Display/grading restore states are `displayRestore/gradeRestore`
(`retryRestore`).

## Send path

- `transport` — the shared JSON-POST sender (`postJson /
  fetchJsonWithBusyRetry`). One shape for play/eval/batch. Worker stdio
  ("JSON-lines transport") is a different layer — qualify it.
- `coordinator` — foreground scheduler (`ReviewCoordinator`): at most one live
  request per engine, latest-wins. "Scheduler" in frontend prose means this;
  prefer `coordinator`. Capital `Scheduler` is backend-only.
- `flight` — one tracked in-flight request (`AbortController` record:
  `playMove` single, `restoreFlights` map, `foregroundFlights` per-engine sets,
  `PlayFiringIdentity` firing record). Generic noun; qualify the map.
- `admission` — backend-only (`admit() → Scheduler.Acquire`): wait + acquire +
  error map. No frontend symbol.
- Game-request senders (`serverGames.ts`) are `gameClient`, never `transport`.

## Lanes

Endpoint-implied, backend-owned: `POST /move → Play`, `POST /move/analysis →
Focus`, `POST /evaluate → Focus`, `POST /reviews → Batch`. Maia: one
scheduler; Stockfish: two (interactive + batch, dedup per-scheduler).
Non-preemptive, grant order `Play > Focus > Batch` within a scheduler.
Batch shares fairly by rotation with dual admission caps (fail-visible 429).
Batch entries carry `engine` (slot routing: which admission slot drains the
entry) plus `role` (`grade` for grading-2400 Maia rows, `display` for
everything else); runners stay engine-keyed, grading treatment reads the role.
Frontend `ensure({priority})` = foreground pump; `restore` = settled rows.
`supersede` (verb) = `ErrSuperseded`/`cancelLocked` mechanism; `join` =
waiter path, `dedup-by-key` = key policy (empty key never joins).

## Snapshot / store (disambiguated)

- `AnalysisSnapshot` — board position + cursor + branch for refresh restore
  (`maia-board.analysis-snapshot.v1`).
- `RepositorySnapshot` — durable `maia-board.games.v2` document (records +
  current marker + pending). `GameRepository.snapshot()` returns this object.
- `snapshot()` on `EvaluationStore` / `ReviewCoordinator` — monotonic version
  counter for subscriptions, not board state.
- `HistorySyncStore.snapshot()` — revision counter (same pattern, named
  revision inside). `GameRepository.snapshot()` is the full document, not a
  counter. Local `renderKey` / `restoredSession` / `getSnapshot` are not
  snapshots.
- Backend names (no aliases): `Worker.workerStatus()`,
  `batchJob.progress()`, `capTallies()` (admission counts), `intakeRows`
  (bulk-read rows), SSE `initialProgress`. `initialStatus`/`capSample`
  notes below stay as doc pointers.
- SSE `initialStatus` (docs say "snapshot") — first status event for reconnect
  restore. Not board state.
- `capSample` (docs say "snapshot" in batch admission) — point-in-time cap
  counts. Not board state.

## Verdict inputs (disambiguated)

- `theory` — board-computable facts, no engine (terminals, mates, draws,
  en passant, promotion, escape, parry).
- `material` — material + tactic wording over the best-line window
  (`TACTIC_VALUES` owned by `moveFacts.ts`).
- `openings` — named book from the server (`OpeningMatch` wire,
  `OpeningRef` display, `NoveltyRef` prior-book reference).
- `rarity` — Maia sociology (`maiaRarity` bands 0.6/⅓, tiny <5%).
- `criticality` — engine-only `Critical/Top` fact before `effectiveQuality`.
  Precedence: opening/terminal > material > pawn > second-pool/praise.

## Durability verbs (qualified always)

- `pending`: `evalPending` (in-flight review keys) vs `repoPending`
  (`PendingGameOperation[]` durable ops) vs `syncPending` (display count).
- `version`: `opVersion` (UUID per op) vs `storeVersion` (subscription
  counter). `failedVersion` is an op id.
- `persist`: repository document (`maia-board.games.v2`) vs batch reattach
  (`maia-board.review-batch.v1`) vs settings keys — different lifetimes,
  one verb qualified by key.
- `hydration` = boot read only (`initialState` from
  `repository.snapshot() + readSnapshot()`), never cache-fill. History page
  fetch is page sync, not hydration.
- Frontend owns `outbox/pending-wins/compare-swap/recovery/export`;
  backend owns `withTx` atomicity (disposable LRU `evaluations_v2` vs
  durable `games+meta`). Do not port outbox to backend.
- Version inventory: cache envelope `Version=2` vs Maia `ValueRev 1/2` vs
  `maiaRevision` (weights SHA) vs SF `SearchPolicy/policy()` vs additive
  unversioned game DDL.

## Workers (backend topology)

5 processes, 3 schedulers + 1 mutex: 2×Maia (`MaiaRequest/MaiaResult/
MaiaCandidate`, `EnginePool` fallback, `maiaInflight` op) + 2×SF slots
(interactive + batch helpers) + 1×openings (`OpeningsLookup`, mutex, no
scheduler). Reserve `helper` = Python binary, `worker` = Go owner.
`slot` = admission slot; `Grant/ticket` = mechanism. Verbs are intentional:
`predict` (Maia, with fallback) vs `run` (SF) vs `query` (openings).

## Limits (single table)

| Scope | Limit |
| --- | --- |
| Backend engine request plies (`/move`, `/move/analysis`, `/evaluate`) | 256 |
| Backend history/line plies (`/lookup`, `/reviews`, `/games`, `/openings`) | 4096 |
| Backend request body (`/move`, `/evaluate`, `/games`, `/openings`) | 64 KiB |
| Backend bulk body (`/reviews`, `/lookup`) | 4 MiB |
| Backend lookup chunk | 1024 entries |
| Backend batch entries (`POST /reviews`) | 768 |
| Backend unfinished batch jobs (admission cap; cf. retained `maxKeptJobs=8`) | 8 |
| Frontend in-memory settled results (both engines) | 4096 |
| Frontend timelines retained | 64 |
| Backend SQLite v2 cache rows | 25000 |

Endpoints link here; they do not re-declare limits. Confusables: retained
`maxKeptJobs=8` vs admission `maxUnfinishedJobs=8` (same number, opposite
meanings); HTTP 64 KiB body cap vs `workerLineLimit` pipe-line cap (same
number, different domain); games pagination default 200 / max 500 and
key/value byte bounds live with their owners.
