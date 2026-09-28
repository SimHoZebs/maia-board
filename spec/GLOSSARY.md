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
  Tuple-input form: `posId(initialFen, prefix)` (`domain.ts`). Node-input
  wrapper (same value, different call shape): `stablePositionKey(node)`.
  See `frontend/src/domain.ts:posId`,
  `frontend/src/evaluationStore.ts:stablePositionKey`.
- `lineKey = posId(initialFen, full moves)` — content key for one line.
  Tuple-input: `lineKeyFor(initialFen, moves)`. Node-input wrapper:
  `lineKeyForNode(node)` (takes a ReviewNode, not a tuple). Abort scopes
  (`{lineKey, gameId?}`) key foreground work by this.
  See `frontend/src/domain.ts:lineKeyFor`.
- `reviewKey = JSON([posId, engine, settingsHash])` — cache key for one engine
  reading. `settingsHash` is `stockfishPolicy` for SF, `[eloMaia, eloUser,
  model, valueElos?]` for Maia. See
  `frontend/src/evaluationStore.ts:reviewKey`.
- `gameId` — durable user-game identity (saved games, current-game marker).
  Never cache identity. Deleting a game orphans nothing.
- `pos_hash / cache_hash / cache_key` — log-only or legacy-client fields.
  Ignored for identity; server derives identity from `(fen, initial_fen,
  moves)`. See `backend/evaluation_identity.go`.

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
   (null = unreviewed/off-book).
5. `candidate` — one entry of `ObjectiveCandidates.entries`
   (`{uci, expected, prob?, delta?}`) rendered by candidate lists.

`review` as a noun is reserved for the retrospective per-move pipeline
(`useReviewPipeline`, `reviewMetrics`). Whole-game server batch jobs are
`batch reviews` (`POST /reviews`) — same grading math, different delivery.

## Value representation

- `expected` — mover-relative expected score 0–100. The only number grading
  cutoffs (`classifyLoss 20/10/5`) read. Maia: `100*(win+0.5*draw)`. SF:
  `whiteWin(cp)` then pov-invert for Black.
- `whiteExpected(turn, expected)` — White-relative view for bars/graphs.
  `whiteWin`, `maiaWhiteExpected`, `maiaWhiteWdl` are the same conversion at
  different boundaries; do not re-define.
- `top` — objective best move (`top_moves[0].move` / `best_move`), null when
  degraded/missing/terminal.
- `score` — SF White-perspective `{cp|mate}`. `WDL` — Maia choosing-side
  `[loss, draw, win]`. Same position value, different projection.
- `delta / baseline` — read-time derivation
  (`wdlExpected(candidate) − wdlExpected(grading-2400-row)`), never stored.
- `objective = {top, expected}` — request-time composition over per-model
  caches, never a stored combined row. Provider switch changes fetches, never
  grading math.

## Cache-fill (one operation)

Canonical verb: `restore`. `store.restore → coordinator.restore →
restoreLookup / useLookupRestore` is one path (cache-fill + visible-pair-first
ordering inside the store). `lookup` is the endpoint name
(`POST /evaluations/lookup`, read-only, never infers). `execute` runs + stores.
Old prose terms for the same operation (no such exports — do not use):
`prime`, `bulk prime`, `hydrate`, `reconcile`, `backfill`.
Coverage: `restoreCoverage`. Lane descriptor: `restoreDescriptor`.

## Send path

- `transport` — the shared JSON-POST sender (`postJson /
  fetchJsonWithBusyRetry`). One shape for play/eval/batch.
- `coordinator` — foreground scheduler (`ReviewCoordinator`): at most one live
  request per engine, latest-wins. "Scheduler" in frontend prose means this.
- `flight` — one tracked in-flight request (`AbortController` record:
  `playFlight`, restore `flights` map).
- `admission` — backend-only (`admit() → Scheduler.Acquire`): wait + acquire +
  error map. No frontend symbol.
- Game-request senders (`serverGames.ts`) are `gameClient`, never `transport`.

## Lanes

Endpoint-implied, backend-owned: `POST /move → Play`, `POST /move/analysis →
Focus`, `POST /evaluate → Focus`, `POST /reviews → Batch`. One slot per
engine, non-preemptive, grant order `Play > Focus > Batch`. Frontend
`ensure({priority})` = foreground pump; `restore` = settled rows.

## Snapshot / store (disambiguated)

- `AnalysisSnapshot` — board position + cursor + branch for refresh restore
  (`maia-board.analysis-snapshot.v1`).
- `RepositorySnapshot` — durable `maia-board.games.v2` document (records +
  current marker + pending). `GameRepository.snapshot()` returns this object.
- `snapshot()` on `EvaluationStore` / `ReviewCoordinator` — monotonic version
  counter for subscriptions, not board state.
- SSE `initialStatus` (docs say "snapshot") — first status event for reconnect
  reconcile. Not board state.
- `capSample` (docs say "snapshot" in batch admission) — point-in-time cap
  counts. Not board state.

## Limits (single table)

| Scope | Limit |
| --- | --- |
| Engine request plies (`/move`, `/move/analysis`, `/evaluate`) | 256 |
| Shared line plies (`/lookup`, `/reviews`, `/games`, `/openings`) | 4096 |
| Request body (`/move`, `/evaluate`, `/games`, `/openings`) | 64 KiB |
| Bulk body (`/reviews`, `/lookup`) | 4 MiB |
| Lookup chunk | 1024 entries |
| Batch entries (`POST /reviews`) | 768 |
| Unfinished batch jobs | 8 |
| In-memory settled results (both engines) | 4096 |
| Timelines retained | 64 |
| SQLite v2 cache rows | 25000 |

Endpoints link here; they do not re-declare limits.
