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
`STATIC_DIR` to use another path. `/move` and `/healthz` remain API routes.

## Workspaces

- **Play:** choose Maia rating and side, then Start. Starting a new game sets both
  engine Elo inputs to the chosen rating. During play, player strips show the
  active turn; horizontal notation and position navigation sit below the board.
  New game opens cancellable setup. Completed games offer Review game.
- **Analyze:** load History, PGN (game notation), FEN (a starting position), or the
  standard starting position. Import closes after loading. Analysis has its own
  rating and model; Analyze position explicitly requests human move probabilities.
  Changing the position, rating, or model clears the previous answer.
- **History:** recent games on this device, with Resume for unfinished games,
  Analyze, Export, and Delete. Deleting the current saved game also clears its
  current-game record.

Left/Right and Home/End navigate positions outside form controls and dialogs.
Dialogs support Escape and restore focus to the opening control.

## State and request ownership

React Router's declarative routes expose `/play`, `/analyze`, and `/history`.
Root and unknown URLs replace their history entry with `/play`. Header links,
Review, and saved-game Resume update the URL; Back and Forward select the same
destinations. The browser fixture serves the static entry page for frontend URLs.

`BoardRouter.tsx` keeps `useMaiaBoard` mounted above the route views. The URL owns
the destination; reducer `mode` is the execution context used for legal actions
and request payloads. The initializer receives the route mode, and a guarded
render-time update synchronizes later URL changes before effects commit. Direct
Analyze and History visits therefore restore the game without requesting a play
move. Review and Resume batch their reducer action with navigation. Returning to
Play requests once when Maia is still to move; returning to Analyze requires an
explicit Analyze position action. Game viewing and analysis branches survive
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
requires Return to original first. Original and explored PGN exports are separate.
The branch and viewed position are ephemeral. The four v1 storage keys and their
record formats are preserved; analysis preferences last for the current session.

`analysisLine` constructs the displayed FEN and request moves from the same replay:
the initial FEN, original prefix, then temporary branch. `ChessBoard.tsx` wraps
official Chessground, with React owning its container and Chessground owning the
descendants. Candidate preview arrows use a separate `setAutoShapes` effect.

Maia probabilities are displayed as returned, without scaling the displayed top
five to 100%. The win/draw/loss estimate belongs only to the first candidate.
Upstream [`score_moves`](https://github.com/CSSLab/maia3/blob/1e13597c42d4858b7cfd7cfdae01e297263364b2/maia3/uci.py)
evaluates after that move and inverts the result back to the choosing side.
`absoluteWdl` uses the request FEN's turn to label White win, Draw, and Black win.

## Browser verification

Playwright intercepts a static `dist-browser` build and `/move` responses; it
requires no running server. Both production React and development StrictMode
exercise gameplay, stale responses, imports, exploration, dialogs, touch, and
layout. Geometry checks cover 1366×768, 1440×900, 360×800, and 390×844, with
screenshots under ignored `test-results/`. Screenshots wait for piece animations
to finish. Real inference and deployment are outside these browser fixtures.
