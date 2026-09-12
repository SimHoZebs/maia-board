# Maia Board frontend

The frontend is a Vite-built static page. It uses `chess.js` for legal moves,
PGN handling, and FEN timelines, and `chessground` for board rendering. Settings,
the current game, recent games, and the last analysis inputs are stored in the
browser's local storage.

## Local checks

```sh
npm ci
npm test
npm run build
npm run test:browser
npm run test:browser:strict
```

The production container is built from the repository root so the Dockerfile
can access both `frontend/` and `backend/`:

```sh
docker build -f backend/Dockerfile .
```

The Go server serves the resulting `dist` directory at `/app/static`. Set
`STATIC_DIR` to use another path. `/move`, `/evaluate`, and `/healthz` are API routes.

## Workspaces

- **Play:** choose Maia rating and side, then Start. Starting a new game sets both
  engine Elo inputs to the chosen rating. Random side resolves once at Start using
  a cryptographic random bit; the game stores the resolved White or Black side.
  Starting a new game keeps the current game in History; Cancel keeps playing.
  During play, player strips show the
  active turn; horizontal notation and position navigation sit below the board.
  Flip, takeback, and position navigation share a compact icon toolbar with labels
  for assistive tech. New game
  lives in the header above the board; completed games offer Review game.
- **Analyze:** load History, PGN (game notation), FEN (a starting position), or the
  standard starting position. Import closes after loading; clicking the Analyze
  tab while a game is loaded reopens the chooser. Analysis has its own
  rating and model. After a 200 ms pause, the selected position automatically
  requests Maia probabilities and Stockfish evaluation, plus evaluation of the
  preceding position to grade the last played move. Analyze entire game reviews
  the complete imported line; Analyze explored line reviews the current branch.
  Rating and model selectors share a row with the generation action and are disabled during a batch.
  Review graphs, quality badges, and suggestion arrows appear in Analyze.
  Move notation scrolls horizontally in a single row below the board. Exploring adds
  a second row beneath the branch's origin; the original line stays on the first row. Original moves after the branch
  point are read-only; the toolbar's return arrow exits exploration. Export and copy-link
  actions follow the analysis results. Translucent White/Red/Blue arrows show
  the played continuation, Maia's top choice, and Stockfish's best move, widest
  to narrowest so agreeing moves remain visible. The Maia and Stockfish sections
  carry matching red and blue markers, lead with comparable White-win heroes,
   present their top moves side by side, and highlight the move actually played.
   Hovering or focusing a candidate previews its arrow; activating the
   candidate explores that move on the board.
  Played blunders and mistakes also get ?? / ? destination badges on the board.
- **History:** games from the server, with Resume for unfinished games,
  Analyze, Export, and Delete. Deleting the current saved game also clears its
  current-game record. The list shows a total count when the server holds more
  rows than displayed.

Left/Right and Home/End navigate positions outside form controls and dialogs.
Dialogs support Escape and restore focus to the opening control.

## Server game history

The server owns game history (`GET/POST /games`, `DELETE /games/:id`). The
browser keeps its previous localStorage keys as a read cache plus a
write-ahead outbox (`maia-board.outbox.v1`): every save, delete, and
current-game marker applies locally first, then flushes in order. Entries leave
the outbox only on acknowledgement, so reloads and offline stretches never
lose games; a pending indicator and a Retry control surface the backlog.
Pre-database libraries migrate once, oldest first with ids preserved, and the
8-game cap is gone. Boot reconciles server rows with pending ops (pending
wins, last marker wins); an in-flight Maia reply for the same tip is never
replaced by the sync. Settings and analysis inputs remain local-only.

## State and request ownership

React Router's declarative routes expose `/play`, `/analyze`, and `/history`.
Root and unknown URLs replace their history entry with `/play`. Header links,
Review, and saved-game Resume update the URL; Back and Forward select the same
destinations. A loaded analysis owns a content URL,
`/analyze?moves=e2e4,e7e5` plus `fen=` for custom starts, so each game is
linkable and Back walks loaded games. The empty starting position is bare
`/analyze`. The browser fixture serves the static entry page for frontend URLs.

`BoardRouter.tsx` keeps `useMaiaBoard` mounted above the route views. The URL owns
the destination; reducer `mode` is the execution context used for legal actions
and request payloads. The initializer receives the route mode, and a guarded
render-time update synchronizes later URL changes before effects commit. Direct
Analyze and History visits therefore restore the game without requesting a play
move. Review and Resume batch their reducer action with navigation. Returning to
Play requests once when Maia is still to move; returning to Analyze automatically
uses or requests results for the selected position. Game viewing and analysis branches survive
client-side navigation; refreshing restores the existing local-storage records.

`state.ts` owns workflow transitions. Play's `viewedPly` is `null` when following
the live tip, or a fixed historical ply (one half-move). Looking back leaves the
live request intact. A reply advances the game while historical viewing stays
fixed; Return to game follows the tip again. Historical boards are read-only.
Setup drafts and opening/cancelling dialogs preserve requests. Starting a game,
switching destinations, resuming a saved game, takeback, and analysis context
changes retire obsolete requests. `useMaiaBoard.ts` retains the StrictMode-safe
effect cleanup and request-identity guard.

Analysis exploration uses one temporary branch: `branchFromPly` marks its origin
in the original game and `branchMoves` holds its moves. Both colors can move;
editing an earlier scratch position replaces its continuation. Starting elsewhere
requires Return to original first. Original and explored PGN copies are separate.
The branch and viewed position are ephemeral. The four v1 storage keys and their
record formats are preserved; analysis preferences last for the current session.

`analysisLine` constructs the displayed FEN and request moves from the same replay:
the initial FEN, original prefix, then temporary branch. `ChessBoard.tsx` wraps
official Chessground, with React owning its container and Chessground owning the
descendants. A separate `setAutoShapes` effect draws translucent White next-played,
Red Maia-top, and Blue Stockfish-best arrows with widths 12/8/4. Distinct SVG hashes
preserve widest-first ordering when arrows coincide. Optional
candidate previews use a thin gold arrow; activating a candidate branches
into that move.

## Review coordination and scoring

`useReview.ts` owns the analysis lifecycle. `reviewCoordinator.ts` keeps one request
in flight per engine, up to two foreground Stockfish jobs and one Maia job, and
pulls batch work one node at a time. Foreground work takes priority between jobs:
navigating aborts a stale in-flight batch job so the viewed position never waits
behind slow inference, while jobs already targeting the new view finish undisturbed.
Scrubbing replaces queued foreground work. Results are read only by their exact
position/settings key; completed obsolete requests cannot replace another
position's displayed results. Aborted batch nodes stay at the cursor and replay
later, so progress always completes. Batch snapshots survive index navigation and are
discarded by line loads/edits, rating/model changes, or leaving Analyze.
Batches support at most 256 plies (257 positions).

Separate successful-result caches retain the 512 most recently used entries for
each engine. Stockfish keys include normalized initial FEN, complete move history,
and `sf19-n100k-ms750-mpv2-t1-h64-v1`. Maia keys also include both ratings, model,
and the pinned upstream revision linked below. Fallback Maia entries expire after
30 seconds. Busy responses retry twice at most, respecting Retry-After with a
one-second minimum. Other failures require Retry failed. Terminal positions are
determined from full chess.js history, synthesized locally, and never sent to Maia.

Behind the memory caches sits the server evaluation cache (5000
least-recently-written-first rows). `POST /evaluate` and `POST /move` are
read-through: each request carries its cache coordinates, so one round-trip
covers lookup, inference, and persistence with no separate probe, and the
`X-Eval-Cache` response header tells hits from live inference for timing.
Degraded Maia answers never persist. Cached rows pass the same response
validation as live ones before display, and a corrupt or unexpected row falls
back to live inference instead of failing the position. `PUT/GET
/evaluations/:hash` remain for read-only line priming, which must never
trigger engine work.

`reviewMetrics.ts` defines `maia-board-review-v1`. Canonical White scores become
winning chances using the [Lichess formula](https://lichess.org/page/accuracy).
Mate scores preserve the winning side and ignore distance for accuracy. Loss is
the decrease in winning chance from the mover's perspective. Thresholds are 5
percentage points for Inaccuracy, 10 for Mistake, and 20 for Blunder. Great requires
Stockfish's top move, loss at most 1 point, at least two legal choices, and a
10-point gap to the second evaluated centipawn alternative. This project-specific
heuristic does not reproduce Chess.com's grading or detect brilliant moves.
Other low-loss moves are Best when matching Stockfish, otherwise Good.

A single legal choice is Forced with accuracy 100. Missing/failed evaluation pairs remain
Unreviewed and leave graph gaps. Graph points navigate the line and expose score, actual
depth, and quality through accessible labels. Engine grades are
estimates at the reported depth.

Maia probabilities are displayed as returned, without scaling the displayed top
five to 100%. The win/draw/loss estimate belongs only to the first candidate.
Upstream [`score_moves`](https://github.com/CSSLab/maia3/blob/1e13597c42d4858b7cfd7cfdae01e297263364b2/maia3/uci.py)
evaluates after that move and inverts the result back to the choosing side.
`absoluteWdl` uses the request FEN's turn to label White win, Draw, and Black win.

## Browser verification

Playwright intercepts a static `dist-browser` build and `/move` and `/evaluate` responses; it
requires no running server. Both production React and development StrictMode
exercise gameplay, stale responses, imports, exploration, dialogs, touch, and
layout. Review fixtures also use native browser fetch, inspect rendered coincident
and mixed arrow SVGs, navigate graphs, test batch completion and
terminal handling, and resolve both random-side outcomes. Geometry checks cover
1366×768, 1440×900, 360×800, and 390×844, with
screenshots under ignored `test-results/`. Screenshots wait for piece animations
to finish. Real inference and deployment are outside these browser fixtures.
