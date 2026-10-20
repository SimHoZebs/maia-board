# Maia Board backend

Go HTTP server: request validation, SQLite persistence, engine process
lifecycle. Python adapters do history-aware validation and call Maia3 or
native Stockfish. Maia uses the pinned `Maia3UCIEngine` API; Go is the HTTP
boundary.

## Openings table

Chess truth is `workers/openings_lookup.py` (python-chess); Go owns HTTP
and the process boundary. Table is `workers/openings_table.json`, generated
from the pinned
[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
TSVs (CC0). Regenerate after changing the pin (from `frontend/`):

```sh
node scripts/build-openings-table.mjs          # rewrite backend/workers/openings_table.json
node scripts/build-openings-table.mjs --check  # fail when stale
```

## Storage and cache

SQLite with pure-Go driver and WAL. `DB_PATH` selects the file (default
`maia-board.db`). Persist its directory, including companion files. Back up
with the SQLite backup API or `VACUUM INTO` from a live connection; copying
only the main file can omit WAL writes.

Games and the current-game marker persist independently of eval rows.
Migrations run at store open. Browser pending writes belong to the
frontend persistence layer.

`POST /move`, `/move/analysis`, `/evaluate` can reuse stored evaluations.
`X-Eval-Cache: hit|miss` (contract in [`API.md`](API.md#envelope-and-limits)).
Only deterministic Maia requests participate; sampled play moves and
degraded fallbacks are not persisted. Invalid cached rows fall through to
inference. Eviction drops old writes past the v2 row cap in
[limits](../spec/GLOSSARY.md#limits); games are never evicted.

## Maia worker lifecycle

Go talks to a warm Python worker over JSON-lines stdin/stdout (64 KiB max).
After load Python emits `{"ready": true}`; each request gets a result or
typed error. Diagnostics go to stderr; Go keeps bounded output in logs.

The adapter uses the pinned upstream arg parser, `Maia3UCIEngine`
constructor, model loader, option handling, full-history position command,
and `score_moves`. Every request resets ratings, candidate count, and
temperature. The worker replays `moves` from the starting position and
compares the result with `fen`, then validates positions/moves before
upstream, then validates candidates, probability ordering, and WDL before
replying.

One serial slot per model replica. Admission waits at most 100 ms;
identical deterministic work joins the running op. Sampled play requests
never share. Startup deadline 300 s; inference deadline 120 s. A cancelled
caller stops waiting while the op holds the slot until drained. Hard timeout
or protocol failure kills and reaps the worker process group before release.
Success keeps the warm process.

Workers idle past `MAIA3_IDLE_TIMEOUT` stop to free GPU memory; the next
request cold-starts. The sweep never touches running or queued work.

`/move` and `/move/analysis` wait with client cancellation detached from the
bounded worker op. A disconnected client still validates and persists a
deterministic result under its canonical identity. Sampled/degraded results
stay excluded from persistent cache.

## Backend performance

`scripts/backend-perf.sh` runs the mock-engine harness
(`TestBackendPerfMock` in `perf_mock_test.go`) over a seed × plies matrix:

```sh
scripts/backend-perf.sh                 # defaults: seed 1, 40 plies
scripts/backend-perf.sh --seed 1,2 --plies 40,80 --maia-ms 5
```

It stubs inference with a fixed `PERF_MAIA_MS` sleep: boot reply, line
lookup, whole-line batch drain (first/second-half split), lookup sweep,
rating-change foreground, Play+Focus collision, SF cache-hit serve. Hits
measure the real SQLite read path; misses never touch a subprocess. Each
cell writes `test-results/backend-perf-s<seed>-p<plies>.json`. Runs only
with `PERF_MODE=mock`. `PERF_LINE_JSON` optionally points at
`scripts/gen-perf-line.py --seed N --plies M` output for the shared seeded
line; otherwise a synthetic line is used.

### Live-engine profiling

Mock harness cannot show how inputs change latency (history length, search
budget, model size, cold workers). Profile against a real backend:

```sh
node scripts/backend-perf-live.mjs --url http://debian-server:8080 \
  --seed 1 --plies 40 --cache-bust 37
```

Drives a seeded chess.js line through cold start, per-ply miss curve, hit
curve, 3-lane whole-line batch, foreground-during-batch priority,
per-lane contention, supersede storm, join proof, abort write-through,
256-ply batch, 429 cap probe, SF time×lines grid, 79M vs 5M. Miss scenarios
use Elo offsets plus `--cache-bust` so a lived-in cache cannot turn misses
into hits; 503/409/429 are recorded, not retried. Cold load can take
minutes; single requests time out at 3 min, cold probe at 10. See `--help`
for the scenario list and `--scenarios` for a subset.

## Local verification

Backend-local checks. Full gate (incl. `--backend-only`): `scripts/verify.sh`
— command list lives in the [root README](../README.md#checks).

From `backend/`:

```sh
CGO_ENABLED=0 go test ./...
CGO_ENABLED=0 go vet ./...
```

Python 3.12 venv outside tracked source:

```sh
python3 -m venv /path/to/maia-test-venv
/path/to/maia-test-venv/bin/python -m pip install python-chess==1.999 chess==1.11.2
```

Test discovery from `backend/workers/`:

```sh
cd backend/workers
/path/to/maia-test-venv/bin/python -m unittest discover -v
```

Default suite uses python-chess, a stub Maia module, and engine mocks (no
torch/weights). Real Stockfish cases skip unless `STOCKFISH_BINARY` is set.
For real-engine checks, build the pinned engine from `Dockerfile`, extract
the binary as in [STOCKFISH.md](STOCKFISH.md#verification), and run
`test_stockfish_worker` plus `test_engine_settings` on the host before the
Go HTTP/cancellation test.

Real Maia test skips unless `MAIA3_TEST_MODEL` names a locally cached model.
Run where pinned Maia runtime deps and cached weights exist (e.g. combined
image with the test file supplied):

```sh
cd backend/workers && MAIA3_TEST_MODEL=5m python -m unittest -v test_maia3_real
```

That test uses local files only. Mocks do not measure model quality or
cold-load time.

## Runtime configuration and upstream

| Variable                 | Default                    | Purpose                                                                         |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------- |
| `PORT`                   | `8080`                     | HTTP listening port                                                             |
| `STATIC_DIR`             | `/app/static`              | Frontend build                                                                  |
| `DB_PATH`                | `maia-board.db`            | SQLite database                                                                 |
| `PYTHON`                 | `python3`                  | Worker interpreter                                                              |
| `MAIA3_WORKER`           | `/app/maia3_worker.py`     | Maia adapter                                                                    |
| `MAIA3_MODEL_79M`        | `79m`                      | Primary-model alias                                                             |
| `MAIA3_MODEL_5M`         | `5m`                       | Fallback-model alias                                                            |
| `MAIA3_WORKERS`          | `1`                        | Primary-model replicas sharing one priority scheduler                           |
| `MAIA3_FALLBACK_MODEL`   | `5m`                       | `5m` keeps 79M→5M fallback; `off` runs single-model (explicit 5m rejected)      |
| `MAIA3_FALLBACK_WORKERS` | `1`                        | Fallback-model replicas; ignored with warning when fallback is off              |
| `MAIA3_DEVICE`           | `auto`                     | Torch device for both Maia workers: `auto`, `cpu`, `cuda[:N]`. CUDA enables AMP |
| `MAIA3_IDLE_TIMEOUT`     | `10m`                      | Idle worker lifetime before stop (`0` disables). Invalid values fail fast       |
| `STOCKFISH_WORKER`       | `/app/stockfish_worker.py` | Stockfish adapter                                                               |
| `STOCKFISH_BINARY`       | `/app/stockfish`           | Native engine                                                                   |

[Dockerfile](Dockerfile) pins the Torch wheel index and Maia3 revision
`1e13597c42d4858b7cfd7cfdae01e297263364b2`. It bakes both Maia3 checkpoints
(79M + 5M) into `/models/huggingface` via `maia3-cache`
(`--build-arg HF_TOKEN=...` for higher rate limits; never lands in the
image). At runtime the server passes `--local-files-only` and sets
`HF_HUB_OFFLINE=1`. Named volumes seeded from the image keep working
offline. Build from the repo root as in
[root README](../README.md#combined-container-and-hosting).

## GPU inference

CUDA PyTorch build (`TORCH_INDEX_URL`, default cu126): GPU where visible,
CPU elsewhere, no config change (`MAIA3_DEVICE=auto`). Both workers (79M +
5M, under 500 MiB plus two CUDA contexts) fit 4 GiB. Requirements:

- NVIDIA driver for the image's CUDA generation (cu126 needs R560+).
- NVIDIA container toolkit + granted GPU access (`gpus: all` or equivalent).
- Slim CPU-only image: `--build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu`.

Idle workers (`MAIA3_IDLE_TIMEOUT`, default 10 min) unload from GPU until
the next request. Stockfish always runs on CPU.

- [Pinned Maia3 source](https://github.com/CSSLab/maia3/tree/1e13597c42d4858b7cfd7cfdae01e297263364b2)
- [Pinned model API](https://github.com/CSSLab/maia3/blob/1e13597c42d4858b7cfd7cfdae01e297263364b2/maia3/uci.py)
- [uv installation](https://docs.astral.sh/uv/getting-started/installation/)
- [uv-managed Python runtimes](https://docs.astral.sh/uv/guides/install-python/)
