# Maia Board

Minimal self-hosted chess app with **Play**, **Analyze**, and **History**.
Play against rating-conditioned Maia, explore positions with Maia and
Stockfish, and keep games on your own server. One container serves the web
interface and Go API and runs both engines locally.

## Using the app

- **Play** starts or resumes a game against Maia. Selected rating conditions
  the model. Temperature 0 takes the top-probability move; 1 samples the
  distribution.
- **Analyze** imports a game or starting position, examines the selected
  position, and explores a temporary continuation. Whole-line analysis
  evaluates positions across the loaded game or line.
- **History** stores games on the server for resume, analysis, export, and
  deletion. Browser storage holds preferences, local records, and pending
  writes for retry.

### Reading analysis

Candidates answer "what can be played here". Grades compare evaluations
before and after the played move. A starting position has no previous move
to grade; explored lines own their positions.

Evaluations reuse browser memory and the server SQLite cache; sampled play
moves and degraded fallbacks bypass it. Saved games are independent of
cache eviction. See [backend storage and cache](backend/README.md#storage-and-cache).

History pages load explicitly. Failed writes stay available for retry or
export. If another tab changes the browser repository, this tab stops
syncing and asks for export before reload.

## Development

Requires Node.js 22, Go (see [`backend/go.mod`](backend/go.mod)), Python 3.12.

Setup (once):

```sh
scripts/env-setup.sh   # backend/bin/stockfish, ~/.venvs/maia-board
(cd frontend && npm ci)
```

Run everything:

```sh
docker compose up --build
```

Open http://localhost:8080.

Or run backend and frontend separately. Backend, from `backend/`:

```sh
STOCKFISH_BINARY=$PWD/bin/stockfish STOCKFISH_WORKER=$PWD/workers/stockfish_worker.py \
OPENINGS_LOOKUP=$PWD/workers/openings_lookup.py PYTHON=$HOME/.venvs/maia-board/bin/python \
go run ./cmd/server
```

Listens on http://localhost:8080. `/move` needs the container (host venv
has no torch/weights).

Frontend, from `frontend/`:

```sh
MAIA_API_TARGET=http://127.0.0.1:8080 npm run dev
```

Open http://localhost:5173. `MAIA_API_TARGET` is the backend URL.
`MAIA_API_TARGET=http://127.0.0.1:8080 npm run preview` serves the last
production build at http://localhost:4173. Frontend details are in
[`frontend/README.md`](frontend/README.md).

### Checks

Run checks via `scripts/` (each supports `--help`):

```sh
scripts/verify.sh               # typecheck + vitest + go vet/test
scripts/e2e.sh <spec>           # build dist-browser, preview, run a Playwright spec
scripts/perf.sh                 # profiling build + PERF_SEED/PERF_PLIES matrix
scripts/backend-perf.sh         # mock-engine backend perf matrix (no weights/GPU)
node scripts/backend-perf-live.mjs --url <backend>  # live-engine latency
scripts/serve.sh                # preview an existing build
node scripts/chess.mjs "<fen>"  # position legality/SAN/UCI/material as JSON
scripts/env-setup.sh            # Stockfish and Python venv bootstrap
```

Browser fixtures mock engine responses. Browser specs need
`npx playwright install chromium` once. Keep concurrent runs' output
directories separate; see [`frontend/README.md`](frontend/README.md).

Python/worker details are in [`backend/README.md`](backend/README.md) and
[`backend/STOCKFISH.md`](backend/STOCKFISH.md). No CI; local verification
runs the same stages in order: Go/mock-worker checks, frontend typecheck,
packaged Stockfish extraction, browser fixture build.

## Combined container and hosting

From the repository root:

```sh
docker compose up --build
```

Open `http://localhost:8080`. The image bundles the static frontend, Go
server, Python workers, Stockfish 19, and both Maia weights (79M + 5M,
under 500 MiB). Reads only from the baked-in cache at runtime. [`compose.yaml`](compose.yaml)
persists games in `maia-board-data`; `maia-board-models` seeds from the
image on first use.

Hardware: NVIDIA (driver R560+, container toolkit, uncomment `deploy` for
GPU), AMD, Intel, or no GPU. Details are in
[`backend/README.md`](backend/README.md#gpu-inference). Stockfish runs on
CPU. Builds assume x86-64 Linux; no ARM or ROCm build.

Upstream: [Maia3](https://github.com/CSSLab/maia3/tree/1e13597c42d4858b7cfd7cfdae01e297263364b2),
[Stockfish](https://github.com/official-stockfish/Stockfish/tree/sf_19),
[chess.js](https://github.com/jhlywa/chess.js),
[Chessground](https://github.com/lichess-org/chessground). Stockfish
redistribution inputs are in [`backend/STOCKFISH.md`](backend/STOCKFISH.md).
HTTP routes are in [`backend/API.md`](backend/API.md).
