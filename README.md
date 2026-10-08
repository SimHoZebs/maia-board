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
analysis needs the move history from its starting position. Canonical terms for
position/line/posId/reviewKey, eval stages, restore, lanes, and limits live in
[spec/GLOSSARY.md](spec/GLOSSARY.md).

### Reading analysis

Current-position candidates answer "what could be played from this board?"
Retrospective move grades compare evaluations before and after a played move.
A starting position has candidates but no previous move to grade; an explored
continuation owns its positions, and candidate previews belong to the board
position that produced them.

Maia `top_moves` carry model policy probabilities per rating; they need not
sum to 100%. WDL describes the first candidate, choosing-side perspective.
`model_used` and `degraded` flag 79M-to-5M fallback. Scores show Maia 2400
White winning chances, not centipawns; mates and material notes come from
Stockfish underneath. Grades derive from Maia 2400 expectation deltas and are
estimates, not guarantees.

Deterministic evaluations reuse from browser memory and the server SQLite
cache, keyed on position history plus engine identity, ratings/model for Maia,
and search settings for Stockfish. Sampled play moves and degraded fallbacks
bypass the server cache. Saved games are independent of cache eviction.
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
scripts/backend-perf.sh         # mock-engine backend perf matrix (no weights/GPU)
node scripts/backend-perf-live.mjs --url <backend>  # live-engine latency (needs real server)
scripts/serve.sh                # preview an existing build
node scripts/chess.mjs "<fen>"  # position legality/SAN/UCI/material as JSON
scripts/env-setup.sh            # Stockfish and Python venv bootstrap
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

From the repository root:

```sh
docker compose up --build
```

Open `http://localhost:8080`. The image bundles the static frontend, Go server,
Python workers, Stockfish 19, and both Maia weights (79M + 5M, under 500 MiB),
so starts never touch Hugging Face at runtime. The [`compose.yaml`](compose.yaml) persists
games in `maia-board-data`; `maia-board-models` seeds from the image on first use
and keeps existing caches working offline unchanged.

Hardware: NVIDIA (driver R560+, container toolkit, uncomment the `deploy`
block for GPU access), AMD, Intel, or no GPU all work — Maia falls back to CPU
automatically where torch sees no CUDA device. A slim CPU-only image is one
commented build arg away; see the comments in `compose.yaml`. Stockfish always
runs on CPU. Builds assume x86-64 Linux; ARM hosts are not covered. No ROCm
build is provided.

Managed hosting lives in the separate `home-server` repository
(`maia-board/compose.yaml`, `maia-board/maia-board-komodo.toml`, and the
`maia-board` entry in `services.toml`). It serves
`https://chess.home.simho.xyz` on the LAN through Traefik; tailnet clients use
the service-directory Tailnet port link (`http://debian-server.<tailnet>:18080`,
bound to the tailnet interface only).

## Source ownership

| Location | Responsibility |
| --- | --- |
| `frontend/src/` | Routing, Play/Analyze/History state, chess rules and board rendering, evaluation scheduling, browser persistence |
| `backend/cmd/server/` | HTTP wiring: env config, route registration, process entrypoint |
| `backend/internal/server/` | HTTP validation, batch orchestration, SQLite-backed handlers |
| `backend/internal/store/` | SQLite games and evaluation-cache persistence |
| `backend/internal/engine/` | Engine admission, Maia/Stockfish process lifecycle, value validation |
| `backend/internal/sched/` | Priority-lane admission scheduler |
| `backend/internal/evalcache/` | Cache identities, strict document decoding, shape gates |
| `backend/internal/openings/` | ECO opening-book process boundary |
| `backend/internal/chess/` | FEN/UCI/Elo/temperature validation |
| `backend/internal/ipc/` | JSON-lines pipe bounds and worker diagnostics |
| `backend/internal/apierror/` | Shared request-error type |
| `backend/workers/maia3_worker.py` | Adapter to the pinned upstream Maia3 model API |
| `backend/workers/stockfish_worker.py` | History-aware position validation and native Stockfish search |
| `backend/workers/openings_lookup.py` | One-shot ECO opening-book lookup |
| `backend/Dockerfile` | Combined build, pinned engine inputs and runtime dependencies |

The [frontend architecture](frontend/README.md#state-boundaries) describes timeline,
session, evaluation, and persistence ownership. The [backend README](backend/README.md)
defines the HTTP and worker boundaries.

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
