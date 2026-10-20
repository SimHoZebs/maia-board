# Glossary — terminology

Single definition site. Other docs and code comments link here. One name per
concept.

## Position identity

- `position = (initialFen, prefix)` — board + producing history.
  `prefix = moves[:ply]`. FEN alone is never identity.
- `line = (initialFen, full moves)` — whole loaded game or explored
  continuation. Wire `BatchLine {initial_fen, moves}` is the same value.
- `posId = JSON([initialFen, prefix])` — content key for one position.
  `posId(initialFen, prefix)` (tuple) vs `stablePositionKey(node)` (node).
  Also the timeline cache key.
  See `frontend/src/shared/domain.ts:posId`,
  `frontend/src/eval/evaluationStore.ts:stablePositionKey`.
- `lineKey = posId(initialFen, full moves)` — content key for one line.
  `lineKeyFor(initialFen, moves)` (tuple), `lineKeyForNode(node)` (ReviewNode),
  `gradingBotKey(node)` (grading lane). Abort scopes (`{lineKey, gameId?}`)
  key foreground work by this. Same field name recurs: `PersistedBatch.lineKey`
  (`batchReview.ts`), openings-cache local (fetch guard).
  See `frontend/src/shared/domain.ts:lineKeyFor`.
- `reviewKey = JSON([posId, engine, settingsHash])` — key for one engine
  reading. `settingsHash` is `stockfishPolicy` (SF) or `[botElo, userElo,
model, valueElos?]` (bot). See
  `frontend/src/eval/evaluationStore.ts:reviewKey`.
- `gameId` — durable user-game identity (saved games, current marker).
  Data/wire name is `games` (`/games`, `GameStore`, `serverGames`);
  frontend destination is `history` (mode/route/folder). Never cache
  identity. Deleting a game orphans nothing. `currentId` is the marker.
  `${gameId}|${userColor}` memo scopes and `job_id` batch ids (shared
  `newHexID`, separate namespaces) are not identities.
- Server identity derives from `(fen, initial_fen, moves)` — no client
  coordinates. Legacy `pos_hash / cache_hash / cache_key` are rejected as
  unknown fields on strict bulk bodies, ignored elsewhere.
  See `backend/internal/server/identity.go`.
  Backend: `evaluationIdentity.coordinates()` =
  `v2:JSON(engine, fen, initial_fen, moves, settings|elos, model, revision)`.
  Frontend `posId ~= (initialFen, prefix)`; `reviewKey ~= hash + engine +
policy/elos`.

## Evaluation pipeline

1. `evaluation` — one settled engine row. SF `Evaluation` (cp/mate + lines)
   or Bot `MoveResponse` (top_moves + WDL). Stored in `evaluations_v2`,
   in-memory `EvaluationStore`, fetched via `/evaluate`, `/move/analysis`,
   or bulk.
2. `EngineGrade` — engine-only judgment from loss/criticality
   (`Forced | Allowed mate | Blunder | Mistake | Inaccuracy | Critical | Top |
Holds | Unreviewed`). No praise, no rarity. From `reviewMove`.
3. `Quality` — displayed judgment after `effectiveQuality + alienUpgrade`
   (`Critical → Excellent/Great/Best`, `Top → Best`, `Holds → Good`).
4. `verdict` — one-sentence rendering via `describeMove`
   (`quality × rarity + notes`). Never a grade object. `string | null`
   (null = unreviewed/off-book). `QualityMemoEntry` is the memo entry.
5. `candidate` — one `ObjectiveCandidates.entries` row
   (`{uci, expected, prob?, delta?}`); wire shape is
   `TopMove{move, prob, wdl, delta?}` (`move` wire vs `uci` UI only).

`review` (noun) = retrospective per-move pipeline (`useReviewPipeline`,
`reviewMetrics`). Whole-game server jobs are `batch reviews`
(`POST /reviews`).

## Value representation

- `expected` — mover-relative expected score 0–100. Grading cutoffs
  (`classifyLoss 20/10/5`) read only this. Bot: `100*(win+0.5*draw)`. SF:
  `whiteWin(cp)`, pov-inverted for Black. Badge classifies the Stockfish
  loss; settled 2400 loss rides as `maiaLoss` context for the footnote.
- `whiteExpected(turn, expected)` — White-relative view for bars/graphs.
  Converters (same value, different boundaries): `whiteWin(Score→mover)`,
  `botExpected(WDL→mover)`, `whiteExpected(mover→white)`,
  `botWhiteWdl(mover WDL→white %)`, `outcomeExpected(terminal→mover)`.
- `top` — best move per provider (`top_moves[0].move` bot, `best_move` SF),
  null when degraded/missing/terminal. Badge reads Stockfish best; bot top
  feeds `maiaLoss` baseline + rarity axis. Backend asymmetry: SF `BestMove
*string` nil for terminal vs Bot `Move string + Degraded bool`.
- `score` — SF White-perspective `{cp|mate}`. `WDL` — bot choosing-side
  `[loss, draw, win]`.
- `delta / baseline` — read-time derivation
  (`wdlExpected(candidate) − wdlExpected(grading-2400-row)`), never stored.
  Server-attached preferred (`delta_baseline` on served rows), local
  fallback exact (`selectDeltaParts` vs `botDisplayParts`).
- `objective = {top, expected}` — request-time composition over per-model
  caches, never stored (no backend route; frontend composes). Seam is
  role-keyed (`objective/grader`: 2400 context + rarity;
  `objective/winrate`: candidate-display math), not model-keyed. Badge math
  is `review/reviewMetrics` (`gradedReviewMove`: Stockfish owns badge, 2400
  rides as `maiaLoss`). Backend `wdlExpected` is the sole backend
  `expected` spelling; `whiteExpected` is frontend view only.

## Cache-fill

Canonical verb: `restore`. `store.restore → coordinator.restore →
restoreLookup / useLookupRestore` is one path (cache-fill +
visible-pair-first ordering in the store). `lookup` is the endpoint
(`POST /evaluations/lookup`, read-only). `execute` runs + stores (single
job); `pump` steps the per-engine queue; `ensure({priority})` queues
foreground work. Coordinator owns `ensure/pump/execute/playMove`; store owns
`restore`; hook owns `restoreLookup` throttling. Do not use: `prime`,
`bulk prime`, `hydrate`, `reconcile`, `backfill` (no such exports).
Coverage: `restoreCoverage`. Lane descriptor: `restoreDescriptor`.
Display/grading states: `displayRestore/gradeRestore` (`retryRestore`).

## Send path

- `transport` — shared JSON-POST sender (`postJson /
fetchJsonWithBusyRetry`). One shape for play/eval/batch. Worker stdio
  ("JSON-lines transport") is a different layer — qualify it.
- `coordinator` — foreground scheduler (`ReviewCoordinator`): max one live
  request per engine, latest-wins. Frontend "scheduler" means this; prefer
  `coordinator`. Capital `Scheduler` is backend-only.
- `flight` — one tracked in-flight request (`AbortController` record:
  `playMove`, `restoreFlights`, `foregroundFlights`, `PlayFiringIdentity`).
  Qualify the map.
- `admission` — backend-only (`admit() → Scheduler.Acquire`). No frontend
  symbol.
- Game-request senders (`serverGames.ts`) are `gameClient`, never `transport`.

## Lanes

Endpoint-implied, backend-owned: `POST /move → Play`, `POST /move/analysis →
Focus`, `POST /evaluate → Focus`, `POST /reviews → Batch`. Frontend
`analysis` mode rides Focus; `lane` (scheduler) vs `mode` (UI) is the scoped
spelling. Maia: one scheduler; Stockfish: two (interactive + batch, dedup
per-scheduler). Non-preemptive, grant order `Play > Focus > Batch`. Batch
shares by rotation with dual caps (429 on excess). Batch entries carry
`engine` (slot routing) + `role` (`grade` for grading-2400 rows, `display`
otherwise); runners stay engine-keyed, grading reads the role. Frontend
`ensure({priority})` = foreground pump; `restore` = settled rows.
`supersede` = `ErrSuperseded`/`cancelLocked`; `join` = waiter path;
`dedup-by-key` = key policy (empty key never joins).

## Snapshot / store

- `AnalysisSnapshot` — board + cursor + branch for refresh restore
  (`maia-board.analysis-snapshot.v1`).
- `RepositorySnapshot` — durable `maia-board.games.v2` document (records +
  marker + pending). `GameRepository.snapshot()` returns it.
- `snapshot()` on `EvaluationStore` / `ReviewCoordinator` — monotonic
  version counter for subscriptions, not board state.
- `HistorySyncStore.snapshot()` — revision counter. `GameRepository.snapshot()`
  is the full document. `renderKey` / `restoredSession` / `getSnapshot` are
  not snapshots.
- Backend (no aliases): `Worker.workerStatus()`, `batchJob.progress()`,
  `capTallies()`, `intakeRows`, SSE `initialProgress`.
- SSE `initialStatus` ("snapshot" in docs) — first status event for
  reconnect. Not board state.
- `capSample` ("snapshot" in batch admission) — point-in-time cap counts.
  Not board state.

## Verdict inputs

- `theory` — board-computable facts, no engine (terminals, mates, draws, en
  passant, promotion, escape, parry).
- `material` — material + tactic wording over the best-line window
  (`TACTIC_VALUES` in `moveFacts.ts`). Window source:
  `theory/bestLineSource.ts` (`BEST_LINE_SOURCE`, default Stockfish rank-1
  PV; `maia` reselects bot-2400 tops with Stockfish veto).
- `openings` — server book (`OpeningMatch` wire, `OpeningRef` display,
  `NoveltyRef` prior-book reference).
- `rarity` — bot sociology (`botRarity` bands 0.6/⅓, tiny <5%).
- `criticality` — engine-only `Critical/Top` before `effectiveQuality`.
  Precedence: opening/terminal > material > pawn > second-pool/praise.

## Durability verbs

- `pending`: `evalPending` (in-flight review keys) vs `repoPending`
  (`PendingGameOperation[]`) vs `syncPending` (display count).
- `version`: `opVersion` (UUID per op) vs `storeVersion` (subscription
  counter). `failedVersion` is an op id.
- `persist`: repository document (`maia-board.games.v2`) vs batch reattach
  (`maia-board.review-batch.v1`) vs settings keys — qualify by key.
- `hydration` = boot read only (`initialState` from
  `repository.snapshot() + readSnapshot()`), never cache-fill. History fetch
  is page sync.
- Frontend: `outbox/pending-wins/compare-swap/recovery/export`; backend:
  `withTx` atomicity (disposable LRU `evaluations_v2` vs durable
  `games+meta`). Do not port outbox to backend.
- Versions: cache envelope `Version=2` vs Maia `ValueRev 1/2` vs
  `maiaRevision` (weights SHA) vs SF `SearchPolicy/policy()` vs additive
  unversioned game DDL.

## Workers (backend topology)

5 processes, 3 schedulers + 1 mutex: 2×Maia (`MaiaRequest/MaiaResult/
MaiaCandidate`, `EnginePool` fallback, `maiaInflight` op) + 2×SF slots
(interactive + batch) + 1×openings (`OpeningsLookup`, mutex, no scheduler).
`helper` = Python binary, `worker` = Go owner. `slot` = admission slot;
`Grant/ticket` = mechanism. Verbs: `predict` (Maia) vs `run` (SF) vs
`query` (openings).

## Limits

| Scope                                                                       | Limit        |
| --------------------------------------------------------------------------- | ------------ |
| Backend engine request plies (`/move`, `/move/analysis`, `/evaluate`)       | 256          |
| Backend history/line plies (`/lookup`, `/reviews`, `/games`, `/openings`)   | 4096         |
| Backend request body (`/move`, `/evaluate`, `/games`, `/openings`)          | 64 KiB       |
| Backend bulk body (`/reviews`, `/lookup`)                                   | 4 MiB        |
| Backend lookup chunk                                                        | 1024 entries |
| Backend batch entries (`POST /reviews`)                                     | 768          |
| Backend unfinished batch jobs (admission cap; cf. retained `maxKeptJobs=8`) | 8            |
| Frontend in-memory settled results (both engines)                           | 4096         |
| Frontend timelines retained                                                 | 64           |
| Backend SQLite v2 cache rows                                                | 25000        |

Confusables (same number, different meaning): `maxKeptJobs=8` (finished jobs
retained) vs `maxUnfinishedJobs=8` (admission cap); HTTP 64 KiB body cap vs
`workerLineLimit` pipe-line cap; games pagination default 200 / max 500 and
key/value byte bounds live with their owners.
