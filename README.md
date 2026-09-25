# Maia Board

A minimal self-hosted chess app with **Play**, **Analyze**, and **History**.
Play against Maia's rating-conditioned move model, explore positions with Maia
and Stockfish, and keep games on your own server. The combined container serves
the web interface and Go API and runs both engines locally.

## Using the app

- **Play** starts or resumes a game against Maia. The selected rating conditions
  the model's move choices. Temperature controls sampling: 0 chooses its highest
  probability move; 1 samples its original distribution.
- **Analyze** imports a game or starting position, examines the selected position,
  and explores a temporary continuation. Whole-line analysis evaluates positions
  across the loaded game or explored line.
- **History** stores games on the server for resuming, analysis, export, and deletion.
  Browser storage holds preferences, local game records, and pending writes for retry.

A **ply** is one player's move. **UCI** (Universal Chess Interface) coordinate
notation encodes a move as `e2e4` or `a7a8q` for promotion. **FEN**
(Forsyth–Edwards Notation) describes one position, including the turn, castling
rights, and move counters. **PGN** (Portable Game Notation) describes a game with
its move sequence and metadata. A FEN alone cannot establish threefold repetition;
analysis needs the move history from its starting position.

### Reading analysis

Current-position candidates answer “what could be played from this board?”
Retrospective move grades compare evaluations before and after a played move.
A starting position can have candidates without having a previous move to grade.
An explored continuation has its own positions; candidate previews and actions
belong to the board position that produced them.

Maia reports model move probabilities conditioned on rating and position. These
are predictions, not measured percentages of people who play a move. Its displayed
top candidates need not sum to 100%. The win/draw/loss estimate describes the first
candidate after that move, expressed for the choosing side by the API. A response's
`model_used` and `degraded` fields identify a 79M-to-5M fallback, which the
interface labels with the model actually used.

Scores, the balance bar, and graphs show Maia 2400 White winning chances
from human-like play, not centipawns. Move grades compare Maia 2400
expectations before and after the played move; the top Maia 2400 choice is
the objective best. Forced mates and the concrete "this line wins material"
notes still come from Stockfish running underneath, as does praise for
finding the engine's only good move. Grades are project-specific estimates,
rather than guarantees about a move's quality.

Successful evaluations can be reused from browser memory and the server's SQLite
cache. Reuse depends on position history, engine identity, ratings/model for Maia,
and search settings for Stockfish. Restoring cached analysis and generating missing
analysis are separate operations. Sampled Maia play moves and degraded fallback
results do not populate the deterministic server cache. Saved games are independent
of evaluation-cache eviction. Server-derived versioned cache identities are
independent of saved games and pending browser writes.
See [backend storage and cache](backend/README.md#storage-and-cache).

Games can be saved with up to 4096 plies within a 64 KiB request. Engine analysis
accepts at most 256 plies; a longer game's save remains independent of that limit.
History loads older pages explicitly. Failed pending writes remain available for
retry or export. If another tab changes the browser repository, this tab stops
syncing and asks you to export its pending work before reloading.

## Development and checks

Use Node.js 22, Go as specified in [`backend/go.mod`](backend/go.mod), and Python
3.12 for worker tests. Bootstrap once with `scripts/env-setup.sh`, plus `npm ci`
in `frontend/` and `npx playwright install chromium` for browser tests.

Run checks via `scripts/` (each supports `--help`):

```sh
scripts/verify.sh               # typecheck + vitest + go vet/test
scripts/e2e.sh <spec>           # build dist-browser, preview, run a Playwright spec
scripts/perf.sh                 # profiling build + PERF_SEED/PERF_PLIES matrix
scripts/serve.sh                # preview an existing build
node scripts/chess.mjs "<fen>"  # position legality/SAN/UCI/material as JSON
scripts/env-setup.sh            # Stockfish, Python venv, JRE + tla2tools bootstrap
```

Browser fixtures mock engine responses. They do not exercise
real model inference. Keep concurrent browser runs' output directories separate; see
[`frontend/README.md`](frontend/README.md).

Python setup details, mocked-worker commands, and real-engine checks are in
[`backend/README.md`](backend/README.md) and [`backend/STOCKFISH.md`](backend/STOCKFISH.md).
There is no CI workflow; local verification runs the same stages in order:
Go/mock-worker checks, the frontend typecheck, then the packaged Stockfish
engine extraction and browser fixture build. Run the TypeScript typecheck
once before building the browser fixtures.

### Agent checks

Agents run `scripts/verify.sh` before finishing any code task.
Use `--frontend-only`, `--backend-only`, or `--file <vitest-path>` for scoped changes.
Pre-commit runs staged typecheck/vet/gofmt; pre-push runs the full verify.

For a frontend development server or preview against an existing backend:

```sh
# frontend/
MAIA_API_TARGET=http://127.0.0.1:8080 npm run dev
# After npm run build:
MAIA_API_TARGET=http://127.0.0.1:8080 npm run preview
```

Vite proxies game and engine API requests to `MAIA_API_TARGET`. Without that setting,
Vite serves the frontend only. The default local URLs are `http://localhost:5173`
for development and `http://localhost:4173` for preview.

## Combined container and hosting

Build from the repository root:

```sh
docker build -f backend/Dockerfile -t maia-board:local .
docker run --rm --name maia-board \
  --publish 127.0.0.1:8080:8080 \
  --env DB_PATH=/data/maia-board.db \
  --mount type=volume,src=maia-board-data,dst=/data \
  --mount type=volume,src=maia-board-models,dst=/models \
  maia-board:local
```

Open `http://localhost:8080`. The image bundles the static frontend, Go server,
Python workers, and Stockfish 19. Maia weights use the persistent `/models` cache;
initial loading can require a download. Preserve the `/data` volume for games.

Managed hosting lives in the separate `home-server` repository. It serves
`https://chess.home.simho.xyz` on the LAN through Traefik; tailnet access uses the
service-directory link described in [`deployment/README.md`](deployment/README.md).
Compose and Komodo configuration belong to that repository.

## Source ownership

| Location | Responsibility |
| --- | --- |
| `frontend/src/` | Routing, Play/Analyze/History state, chess rules and board rendering, evaluation scheduling, browser persistence |
| `backend/` Go files | HTTP validation, SQLite games/cache, engine admission and process lifecycle |
| `backend/maia3_worker.py` | Adapter to the pinned upstream Maia3 model API |
| `backend/stockfish_worker.py` | History-aware position validation and native Stockfish search |
| `backend/Dockerfile` | Combined build, pinned engine inputs and runtime dependencies |
| `deployment/README.md` | Pointer to separately owned hosting configuration |

The [frontend architecture](frontend/README.md#state-boundaries) describes timeline,
session, evaluation, and persistence ownership. The [backend README](backend/README.md)
defines the HTTP and worker boundaries. [`PLAN.md`](PLAN.md) retains the original
product decisions for historical context.

Upstream dependencies: [Maia3](https://github.com/CSSLab/maia3/tree/1e13597c42d4858b7cfd7cfdae01e297263364b2),
[Stockfish](https://github.com/official-stockfish/Stockfish/tree/sf_19),
[chess.js](https://github.com/jhlywa/chess.js), and
[Chessground](https://github.com/lichess-org/chessground). Stockfish redistribution
inputs and license locations are documented in [`backend/STOCKFISH.md`](backend/STOCKFISH.md).
HTTP route reference lives in [`backend/API.md`](backend/API.md).

## License

This project is licensed under AGPL-3.0-only (see `LICENSE`). If you run a
modified version on a server, you must offer all users interacting with it over
the network the Corresponding Source of your version, including the pinned
Maia3 adapter input, Stockfish source archive, and build recipe documented in
`backend/STOCKFISH.md`.
