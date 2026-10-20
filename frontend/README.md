# Maia Board frontend

React + React Router for Play, Analyze, History workspaces. Vite builds a
static app served by Go in production. `chess.js` supplies legal moves and
game-history rules. `ChessBoard.tsx` adapts Chessground (owns board DOM;
React owns surrounding UI).

Product behavior is in the [root README](../README.md). Wire shapes are in
[backend/API.md](../backend/API.md); terminology, lanes, and limits in
[spec/GLOSSARY.md](../spec/GLOSSARY.md).

## Commands

From `frontend/` with Node.js 22:

```sh
npm ci
npm test
npm run typecheck
npm run build:bundle
```

Full gate (incl. `--frontend-only`): `scripts/verify.sh` — command list lives
in the [root README](../README.md#checks).

`npm run build` = typecheck + bundle. `npm run dev` starts Vite;
`npm run preview` serves a built bundle. Set `MAIA_API_TARGET` to a backend
URL to proxy `/move`, `/move/analysis`, `/evaluate`, `/evaluations`
(covers `/evaluations/lookup`), `/reviews` (covers `/reviews/:id`),
`/games`, `/openings`. `/imports`, `/auth`, `/me`, `/healthz` are not
proxied; point the browser at the backend for those. `MAIA_BUILD_DIR`
overrides the build destination (default `dist`).

## State boundaries

- `BoardRouter.tsx` maps `/play`, `/analyze`, `/history`, `/settings`.
  Analysis URLs carry UCI moves + optional custom initial FEN. The reducer
  mirrors the destination as execution context before request effects run.
  URL restores analysis content on Back/Forward.
- `state/` slices + `useBotBoard.ts` coordinate game actions and the session.
  Historical Play positions are read-only; returning to the tip resumes live
  play.
- `domain.ts`: chess-domain data/rules. Full history needed for repetition;
  a FEN alone is insufficient.
- `evaluationStore.ts`, `reviewCoordinator.ts`, `useReview.ts`: cached
  results, request coordination, analysis lifecycle.
- `gameRepository.ts`: saves/deletes, pending writes, paged server sync.
  Browser document `maia-board.games.v2` holds records, current marker, and
  pending ops. Ack removes its op version, preserving newer work.
  `serverGames.ts` sends requests (gameClient); `storage.ts` supplies
  browser storage. Preferences and analysis inputs are browser-local.
- `reviewMetrics.ts` derives move grades from objective points (best move +
  mover-relative expected score), not engine responses directly.
  `src/objective/grader.ts` is the grading role (best + expected per
  position, currently bot 2400); `src/objective/winrate.ts`
  owns candidate-display math. Candidates and previous-move grading refer to
  different positions.
- Two bot roles: game-level bot (findability + candidate lists at game
  settings) and grading bot 2400 (objective truth). Stockfish keeps
  mate scores + rank-1 PV for material preview.

### Chess timeline and evaluation

Each timeline stores its move sequence once plus one row per position
(including root). Rows hold position, turn, last move, history-derived
draw/checkmate outcomes. Eval references pair timeline + ply; no per-row
move-prefix arrays. Transport materializes the prefix. Selecting positions
reads existing rows.

`domain.ts` retains a bounded timeline cache (see
[limits](../spec/GLOSSARY.md#limits)). Shared history rows keep local numeric
ids across branches/takebacks. These are browser memory keys only; rebuilds
can reassign them and restore evals from the server. Never server cache
identity (see [GLOSSARY](../spec/GLOSSARY.md#position-identity)).

`EvaluationStore` retains a bounded number of settled results across both
engines (oldest evicted; see [limits](../spec/GLOSSARY.md#limits)). Coordinators own requests/failures/queues; leaving a
workspace cancels its requests without clearing shared results. One request
per engine per coordinator; viewed position first; explicit batch work
queued. Late replies checked against the active request before store.

Restore uses bounded `POST /evaluations/lookup` chunks (see
[limits](../spec/GLOSSARY.md#limits) and
[API](../backend/API.md#post-evaluationslookup)). Missing/invalid rows stay misses. Restore never starts whole-line
inference; foreground analysis + explicit batch generate results. Terminal
scoring comes from timeline outcomes (`outcomeEvaluation.ts`). Batch progress uses native EventSource as
optimization; status endpoint is ground truth. Status + restore refetch on
mount, focus, visible, online, stream error. A broken stream costs speed
only.

Server owns cache writes/repair. Frontend validates Stockfish policy before
displaying compatible results and slices candidates without changing
provenance. Bot fallback rows keep `model_used`/`degraded`.

### Game durability and recovery

Repository loads the `maia-board.games.v2` document (game records, current
marker, pending ops), keeping ids. Page sync merges server
records with pending local changes; creates no ops. Older pages merge in;
an incomplete page is never the full collection.

Saves/deletes write browser storage before send. Each pending op has a
version; ack removes that version only. Storage failure stops send and
surfaces via recovery UI. Rejected ops and malformed data stay available
for export or discard. Discard infers no server deletion. Local play during
fetch wins: arriving page is neither merged nor dropped; skipped range stays
loadable via Load more.

Where supported, browser locks serialize writes/sync across tabs.
Repository compares the document before overwrite. Conflict stops syncing
and asks to export this tab's pending work before reload; local play
continues in memory. Recovery exports include local games, current marker,
pending ops, retained malformed records.

### Opening book

Sequences resolve to ECO names via `POST /openings`: transpositions
converge; branches resolve through their full line. Server owns table +
lookup; client fetches once per loaded line (cached by line, aborted on
navigation) and derives the viewed position's deepest ancestor locally.
`src/openings.ts` owns fetch + derivation. `MovesPanel.tsx` swaps the eval
badge for a book chip on in-book moves; `ReviewOverview.tsx` names the
viewed line first. `InsightPanel.tsx` verdict order: terminals first, then
book hits, then quality-by-rarity (`src/theory.ts`). `PlayVerdict.tsx`
renders the same sentence in Play for user moves only (needs `feedback` +
`playVerdict`); no explore-line button. Table source/pin/regeneration: see
[backend README](../backend/README.md#openings-table).

## Browser checks

```sh
npx playwright install chromium
npm run test:browser
npm run test:browser:strict
```

Playwright serves the static fixture bundle via interception and mocks the
API; no dev server needed. `test:browser:strict` builds with development
React for StrictMode effect cleanup. `test:browser:run` executes an
already-built bundle; run typecheck + build first.

Named run with isolated outputs (build first):

```sh
MAIA_BUILD_DIR=dist-browser npm run build
PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/local \
  npm run test:browser:run -- --reporter=line,html --output=test-results/local
```

Screenshots use per-test output paths. Production and StrictMode share
`dist-browser`; fixtures read that directory directly. Serialize builds and
suites needing different bundles; isolated report dirs do not isolate build
inputs.

## Simulated-client performance

`npm run test:perf` builds `dist-profiling` (React profiling entry) and runs
the opt-in client simulation: play, generated analysis line, batch analysis,
scrubbing, rating changes, exploration with mocked latency. Measures
frontend interaction cost, not model inference.

`PERF_SEED` selects the line; `PERF_PLIES` defaults 40; `PERF_PLAY_MOVES`
controls play length. `PERF_MAIA_MS`/`PERF_SF_MS`/`PERF_CACHE_MS` default
900/750/25 ms. Longer lines may need a larger timeout in
`playwright.perf.config.ts`.

Report attaches `perf-metrics.json` (interaction timings, React commits,
network rows, early-vs-late scrub). `CommitRecorder` collects commits only
when the fixture registers `window.__perfCommits`; normal builds use the
ordinary React entry.
