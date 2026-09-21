# Maia Board backend

The Go HTTP server owns request validation, SQLite persistence, and engine process
lifecycle. Python adapters perform history-aware chess validation and call Maia3
or native Stockfish. Maia inference uses the pinned upstream `Maia3UCIEngine`
API; Go remains the HTTP boundary.

## Game and engine API

The [root README](../README.md) defines FEN (a position), UCI coordinate moves,
ply (one player's move), and PGN game notation.

`POST /move` accepts a history-aware Maia request:

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "moves": ["e2e4"],
  "elo_maia": 1500,
  "elo_user": 1300,
  "model": "79m",
  "maia_color": "black",
  "temperature": 0
}
```

For standard-start history, omit `initial_fen` or supply the standard starting
FEN. Supply `initial_fen` explicitly for a custom starting position. The worker
replays `moves` from that position and compares the result with `fen` before inference.
Elo inputs accept 0–5000; model names are `79m` and `5m` (default `79m`).
Inference accepts at most 256 plies. Position history and FEN must describe the
same board, and `maia_color` must match the side to move.

Temperature accepts 0–2 and defaults to 0 at the API. Zero chooses the highest
policy move; 1 samples the original distribution. Play's new-game setup defaults
to 1; saved games retain their temperature and legacy games default to 0.

Responses contain the selected `move`, ranked `top_moves` with model policy
probabilities, and normalized `[loss, draw, win]` `wdl` for the first candidate.
Sampling can select a move outside the displayed candidates. `model_used` and
`degraded` identify fallback from 79M to 5M. Served rows (not stored rows)
also carry `delta_baseline` (the before-position 2400 point) and per-candidate
`delta` values, computed at read time from the grading row behind the request;
without a grading row the fields stay absent and the client falls back to its
list-max comparison. Busy responses return 503; a failed
79M operation can fall back to 5M, while an explicit 5M request uses only that model.

`POST /move/analysis` accepts the same payload for retrospective Maia analysis
(deterministic; omit `temperature`). It admits on the Focus lane while `/move`
admits on Play, so a live reply and its move feedback queue instead of
superseding each other.

`POST /evaluate` performs a Stockfish search. Its settings, score perspective,
history validation, limits, and process cleanup are documented in
[`STOCKFISH.md`](STOCKFISH.md). Errors use `{code, message}`. `/healthz` supplies
the server health endpoint.

`POST /openings` resolves ECO opening names for a line. It accepts
`{initial_fen, moves}` (UCI, at most 4096 plies) and returns every exact book
hit as `{matches: [{ply, eco, name}], book_flags}` where `book_flags[i]` names
the position after `moves[i]`. The book is defined from the standard start
only: custom-start lines return empty matches and all-false flags, never an
error. A missing table degrades the same way with `"degraded": true`.
Chess truth lives in `openings_lookup.py` (python-chess); Go owns HTTP
validation and the process boundary. The table is `openings_table.json`,
generated from the pinned
[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings)
TSVs (CC0). Regenerate after changing the pin (from `frontend/`, needs its
`node_modules` for chess.js):

```sh
node scripts/build-openings-table.mjs          # rewrite backend/openings_table.json
node scripts/build-openings-table.mjs --check  # fail when the artifact is stale
```

`GET /games?limit=200&offset=0` lists saved games with `games`, `current_id`,
`current_game`, `total`, and `next_offset`. The default page size is 200 and the
maximum is 500. `next_offset: null` ends pagination; `current_game` also supplies
the active game when it is outside the page.
`POST /games` creates or updates a game. `GET /games/:id` retrieves a game;
`DELETE /games/:id` is idempotent and clears a matching current-game marker.
Games retain their identifier, settings, move history, and creation time.
Re-saving unchanged game content preserves its recency position.
Game saves accept at most 4096 plies within the 64 KiB JSON body limit. A game
can exceed the engine's 256-ply history budget and still be saved.

## Storage and cache

SQLite uses a pure-Go driver and write-ahead logging. `DB_PATH` selects the file
(default `maia-board.db`). Persist its directory, including SQLite's companion
files, across container replacement. Take a consistent SQLite backup using the
SQLite backup API or `VACUUM INTO` from a live connection; copying only an active
database's main file can omit writes still in its write-ahead log.

Games and the current-game marker persist independently of evaluation rows.
Schema migrations run when the store opens. Browser pending writes are managed
by the frontend's persistence layer.

`POST /move`, `POST /move/analysis`, and `POST /evaluate` can reuse stored evaluations before starting
inference. `X-Eval-Cache` distinguishes `hit` and `miss`. Only deterministic Maia
requests participate; sampled play moves and degraded fallback responses are not
persisted as deterministic analysis. Invalid cached results fall through to engine
evaluation. The cache evicts old writes beyond 25000 v2 rows, without deleting games.

The server derives v2 cache identity from the current FEN, initial FEN, full move
history, engine revision, and applicable settings. Legacy client cache coordinates
do not determine this identity; the legacy table is dropped when the store opens
and its misses recompute through the engine endpoints. Evaluation writes are
server-owned, and corrupt results are recomputed by the engine endpoints.
Cache rows stay per-model by design: Stockfish and Maia shapes, validators,
and settings differ, so one combined row would bust the Stockfish half on a
Maia rating change. Composition stays request-time over per-model reads;
no combined row is ever stored.

`POST /evaluations/lookup` accepts `{requests: [...]}` with at most 1024 requests
and a 4 MiB body. Each entry supplies `engine: "sf" | "maia"`, `fen`, `initial_fen`,
and `moves`; Stockfish may supply `settings`, while Maia supplies `elo_maia`,
`elo_user`, and `model`. The response is
`{results: [{index, value, actual_settings?}]}`. Missing indexes are cache misses.
This read-only endpoint never starts inference; invalid requests return a typed 400.

Stockfish exact settings take precedence. Compatible reuse requires matching time
and depth with more candidate lines. Returned `search_policy` and `actual_settings`
describe the original search. Such reuse is approximate: a search with more
candidates can allocate its budget differently from an independent smaller search.
The frontend validates the reported policy and settings, then slices displayed
candidates without relabelling their original search. Legacy cache-repair PUTs are
rejected; malformed lookup values remain misses until an engine endpoint recomputes
them. Maia identity includes both ratings and the pinned upstream model revision.

Within the batch lane, submits share fairly by rotation (A,B,A,B) with dual
admission caps (misses per engine + unfinished jobs, 429 wait-once). This is
fairness-without-auth for self-host scaling to family/friends; priority
lanes (Play > Focus > Batch) stay regardless.

## Maia worker lifecycle

Go communicates with a warm Python worker using JSON-lines: one JSON object per
line on standard input/output, bounded to 64 KiB. After loading, Python emits
`{"ready": true}`; each request receives a result or typed error. Diagnostics go
to standard error and Go retains bounded diagnostic output in its logs.

The adapter uses the pinned upstream argument parser, `Maia3UCIEngine` constructor,
model loader, option handling, full-history position command, and `score_moves`.
Every request resets both ratings, candidate count, and temperature. The worker
validates positions and moves before invoking upstream, then validates legal
candidates, probability ordering, and win/draw/loss values before replying.

Each model worker has one serial operation slot. Admission waits at most 100 ms;
identical deterministic work can join the running operation. Sampled play requests
do not share results. Startup has a 300-second deadline and inference has a separate
120-second deadline. A cancelled worker caller stops waiting while the operation
continues to own its slot until the reply is drained. A hard timeout or protocol
failure kills and reaps the worker process group before releasing admission.
Successful operations preserve the warm process for the next request.

The `/move` and `/move/analysis` HTTP handlers wait with client cancellation detached from that bounded
worker operation. A disconnected client therefore leaves the handler waiting long
enough to validate and persist a successful deterministic result under its canonical
cache identity. The worker's caller API still supports cancellation of an individual
waiter. Neither path releases the serial slot before the operation is drained or
terminated. Sampled and degraded responses remain excluded from persistent caching.

Stockfish uses one warm helper per admission slot whose cancellation kills its process
group, as described in [STOCKFISH.md](STOCKFISH.md#resource-and-failure-behavior).

## Local verification

Run from `backend/`:

```sh
CGO_ENABLED=0 go test ./...
CGO_ENABLED=0 go vet ./...
```

Create a Python 3.12 virtual environment in a location outside tracked source:

```sh
python3 -m venv /path/to/maia-test-venv
/path/to/maia-test-venv/bin/python -m pip install python-chess==1.999 chess==1.11.2
```

Use that interpreter for test discovery:

```sh
/path/to/maia-test-venv/bin/python -m unittest discover -v
```

The default suite uses `python-chess`, a stub Maia module, and engine mocks, without
Torch or weights. Real Stockfish cases skip unless `STOCKFISH_BINARY` names the
engine. CI builds the pinned engine from `Dockerfile`, extracts the binary, and
runs `test_stockfish_worker` plus `test_engine_settings` on the host before the
Go HTTP/cancellation integration test.

The real Maia test skips unless `MAIA3_TEST_MODEL` names a locally cached model.
Run it in an environment with the pinned Maia runtime dependencies and cached
weights, such as the combined image with the test file supplied:

```sh
MAIA3_TEST_MODEL=5m python -m unittest -v test_maia3_real
```

That test requests local files only. It checks deterministic history-aware inference;
mock tests do not measure model quality or cold-loading performance.

## Runtime configuration and upstream

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listening port |
| `STATIC_DIR` | `/app/static` | Frontend build |
| `DB_PATH` | `maia-board.db` | SQLite database |
| `PYTHON` | `python3` | Worker interpreter |
| `MAIA3_WORKER` | `/app/maia3_worker.py` | Maia adapter |
| `MAIA3_MODEL_79M` | `79m` | Large-model alias |
| `MAIA3_MODEL_5M` | `5m` | Fallback-model alias |
| `MAIA3_DEVICE` | `auto` | Torch device for both Maia workers: `auto` (upstream default — CUDA when torch sees a GPU, else CPU), `cpu`, or `cuda[:N]`. CUDA also enables AMP; explicit `cpu` keeps AMP off. Invalid values fail fast at startup. |
| `STOCKFISH_WORKER` | `/app/stockfish_worker.py` | Stockfish adapter |
| `STOCKFISH_BINARY` | `/app/stockfish` | Native engine |

The [combined Dockerfile](Dockerfile) pins the Torch wheel index and Maia3 revision
`1e13597c42d4858b7cfd7cfdae01e297263364b2`. Its `/models/huggingface` cache holds
downloaded model files. Build from the repository root as described in the
[root README](../README.md#combined-container-and-hosting).

## GPU inference

The image ships a CUDA PyTorch build (`TORCH_INDEX_URL`, default cu126),
so the same image runs GPU inference where a GPU is visible and CPU
elsewhere with no config change (`MAIA3_DEVICE=auto`). Both workers (79M +
5M, under 500 MiB of weights plus two CUDA contexts) fit comfortably on a
4 GiB card. Requirements on the host:

- NVIDIA driver at or above what the image's CUDA generation needs (cu126
  needs R560+); a mismatch surfaces as worker startup failure in the logs.
- NVIDIA container toolkit installed, and the service granted GPU access
  (compose `gpus: all` or equivalent).
- To build a slim CPU-only image instead, pass
  `--build-arg TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu`.

Stockfish always runs on CPU and is unaffected.

- [Pinned Maia3 source](https://github.com/CSSLab/maia3/tree/1e13597c42d4858b7cfd7cfdae01e297263364b2)
- [Pinned model API](https://github.com/CSSLab/maia3/blob/1e13597c42d4858b7cfd7cfdae01e297263364b2/maia3/uci.py)
- [uv installation](https://docs.astral.sh/uv/getting-started/installation/)
- [uv-managed Python runtimes](https://docs.astral.sh/uv/guides/install-python/)
