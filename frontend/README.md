# Maia Board frontend

React and React Router provide the Play, Analyze, and History workspaces. Vite
builds a static app; the Go server serves it in production. `chess.js` supplies
legal moves and game-history rules. `ChessBoard.tsx` adapts Chessground, which owns
the board container's descendants while React owns the surrounding interface.

See the [root README](../README.md) for product behavior and the definitions of
FEN, UCI, ply, and PGN.

## Commands

Run from `frontend/` with Node.js 22:

```sh
npm ci
npm test
npm run typecheck
npm run build:bundle
```

`npm run build` combines the last two commands. `npm run dev` starts Vite;
`npm run preview` serves a built bundle. Set `MAIA_API_TARGET` to an existing
backend URL to proxy `/move`, `/move/analysis`, `/evaluate`, `/evaluations`, `/games`, and `/openings`.
`MAIA_BUILD_DIR` overrides the build destination (default `dist`).

## State boundaries

- `BoardRouter.tsx` maps `/play`, `/analyze`, `/history`, and `/settings` to their
  workspaces. Analysis URLs carry UCI moves and an optional custom initial FEN.
  The reducer mirrors the destination as an explicit execution context, synchronized
  before request effects run. Navigation and reducer actions cooperate when loading
  or resuming a game; the URL also restores analysis content on Back/Forward.
- `state.ts` and `useMaiaBoard.ts` coordinate game actions and the active session.
  Historical Play positions are read-only; returning to the tip follows live play.
- `domain.ts` contains chess-domain data and rules. Full accumulated history is
  needed for repetition; a selected FEN cannot supply that history by itself.
- `evaluationStore.ts`, `reviewCoordinator.ts`, and `useReview.ts` separate cached
  engine results, request scheduling, and the analysis view's lifecycle.
- `gameRepository.ts` owns explicit save/delete operations, pending writes, and
  paged server hydration. Its `maia-board.games.v2` browser document stores game
  records, the current marker, and pending operations together. A successful
  request removes the operation with its version, preserving newer work.
  `serverGames.ts` transports game requests; `storage.ts` supplies browser storage
  and legacy record readers. Preferences and analysis inputs are browser-local.
- `reviewMetrics.ts` derives retrospective move grades from objective points
  (best move + mover-relative expected score), never from engine responses
  directly. `src/objective/maia.ts` and `src/objective/stockfish.ts` expose
  identical provider functions; `src/objective/index.ts` re-exports the
  active one, so switching sources is a one-line import flip with no call
  site changes. Current-position candidates and previous-move grading refer
  to different positions.

### Chess timeline and evaluation

Each timeline stores its move sequence once and a row for every position, including
the root. Rows contain position, turn, last move, and history-derived draw/checkmate
outcomes. Internal evaluation references pair a timeline with a ply; they do not
store a move-prefix array per position. HTTP requests materialize the required
prefix at the transport boundary. Selecting positions reads existing rows.

`domain.ts` retains at most 64 timelines. Shared history rows keep local numeric
identifiers across retained branches and takebacks. These identifiers are browser
memory keys; rebuilding an evicted history can assign new ones and restore its
evaluations from the server. They never determine the server's durable cache identity.

The shared `EvaluationStore` retains at most 4096 settled results **across both
engines**, evicting the oldest stored entry. Workspace coordinators own requests,
failures, and queues; leaving a workspace cancels its requests without clearing
the shared results. Each coordinator runs one request per engine, prioritizes the
viewed position, and keeps explicit batch work queued. Late replies are checked
against the active request before being stored.

Restoration uses bounded `POST /evaluations/lookup` chunks, limited to 1024 requests
and 4 MiB each. Missing or invalid rows remain misses. Restoration does not start
whole-line inference; foreground analysis and the explicit batch action generate
results. Terminal scoring comes from the timeline's recorded outcomes through
`outcomeEvaluation.ts`. Engine inference is limited to 256 plies.

The server owns cache writes and repair. The frontend validates Stockfish's actual
search policy before displaying a compatible result and limits displayed candidates
without changing its provenance. A larger candidate search with the same time and
depth is approximate reuse. Maia fallback results retain `model_used` and `degraded`
so the interface can name the actual model.

### Game durability and recovery

The repository imports legacy saved games and pending operations, retaining game
identifiers and the original legacy outbox. It continues to use the v2 document key
`maia-board.games.v2`. Page hydration merges server records with pending local
changes and creates no save/delete operation. Older pages merge into the library;
an incomplete page is never treated as the full collection.

A save/delete is written to browser storage before transmission. Each pending
operation has a version; its acknowledgement removes only that version. Storage
failures stop transmission and surface through the recovery interface. Rejected
operations and malformed pending data remain available for export or explicit
discard. Discarding a pending operation does not infer a server deletion.
Local play during a history fetch wins: the arriving page is neither merged
nor dropped, and the skipped range stays explicitly loadable with Load more.

Where supported, browser locks serialize repository writes and sync across tabs.
The repository also compares the stored document before overwriting it. A conflict
stops syncing and asks the user to export this tab's pending work before reloading;
local play can continue in memory. Recovery exports include local games, the current
marker, pending operations, and malformed records retained for recovery.

### Opening book

Move sequences resolve to ECO names through `POST /openings`, so
transpositions converge and branches resolve through their full line. The
server owns the book table and lookup; the client fetches once per loaded
line (cached by line, aborted on navigation) and derives the viewed
position's deepest ancestor locally. `src/openings.ts` owns that fetch plus
the ancestor derivation. `MovesPanel.tsx` swaps the eval badge slot for a
book chip on in-book moves; `ReviewOverview.tsx` names the viewed line
first. The move verdict in `InsightPanel.tsx` reports terminal facts first
(mate with miniature names, stalemate, repetition, fifty-move), then exact
book hits, then the quality-by-rarity synthesis with novelty and
pawn-damage notes for mistakes (`src/theory.ts`), and the single strongest
  why for good moves — fresh mate force, only move to hold, promotion,
  fork, en passant, immediate material gain, or escape from
  check — instead of restating engine grades. `PlayVerdict.tsx` renders the
  same sentence under the move list in Play when both `feedback` and the
  `playVerdict` option are on; it grades the user's moves only and has no
  explore-line button. Table source, pin, and regeneration are
documented in [backend README](../backend/README.md#game-and-engine-api).

## Browser checks

```sh
npx playwright install chromium
npm run test:browser
npm run test:browser:strict
```

Playwright serves the static fixture bundle through request interception and mocks
the API. No development server is needed. `test:browser:strict` builds with
development React so StrictMode exercises effect cleanup. `test:browser:run`
executes an already-built fixture bundle and is used by CI after its separate
typecheck and build steps.

For a separately named run, build first, then isolate Playwright's results and HTML
report:

```sh
MAIA_BUILD_DIR=dist-browser npm run build
PLAYWRIGHT_HTML_OUTPUT_DIR=playwright-report/local \
  npm run test:browser:run -- --reporter=line,html --output=test-results/local
```

Screenshots use Playwright's per-test output paths. The production and StrictMode
scripts still share `dist-browser`, and the browser fixtures read that directory
directly. Serialize builds and suites that require different bundles; isolated
report directories alone do not isolate their build inputs.

## Simulated-client performance

`npm run test:perf` builds `dist-profiling` with React's profiling entry and runs
the opt-in client simulation. It covers play, a generated analysis line, batch
analysis, scrubbing, rating changes, and exploration with mocked engine latency.
It measures frontend interaction costs rather than real model inference speed.

`PERF_SEED` selects a reproducible line; `PERF_PLIES` defaults to 40 and
`PERF_PLAY_MOVES` controls play length. `PERF_MAIA_MS`, `PERF_SF_MS`, and
`PERF_CACHE_MS` default to 900, 750, and 25 milliseconds. Longer lines may require
a larger timeout in `playwright.perf.config.ts`.

The report attaches `perf-metrics.json` with interaction timings, React commits,
network rows, and early-versus-late scrub costs. `CommitRecorder` collects React
commits only when the fixture registers `window.__perfCommits`; normal builds use
the ordinary React entry point.
