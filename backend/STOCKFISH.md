# Stockfish evaluation

`POST /evaluate` runs native Stockfish 19 through a Python helper. Go owns
the admission slot and cancellation. Route contract is in
[docs/API.md](../../docs/API.md#opIdevaluate) (generated from
[spec/openapi.yaml](../spec/openapi.yaml); regenerate with
`npm run api:md`); terms and limits in
[../spec/GLOSSARY.md](../spec/GLOSSARY.md).
The helper runs persistent (`--serve`): one warm interpreter + one warm
engine per admission slot.

## Request and position history

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "moves": []
}
```

`initial_fen` optionally sets a custom start; default is the standard
start. `moves` holds UCI moves (e.g. `e2e4`, `a7a8q`) from that start. The
helper validates both positions, replays legal moves, and compares the
result with `fen`, including counters. FEN comparison normalizes castling
and en-passant via python-chess; uncapturable en-passant targets normalize
to `-`. Both sides to move supported.

Send the full available history, including for earlier positions.
Repetition and search depend on it. Custom-start FEN cannot reconstruct
earlier repetitions. Threads and memory are fixed by the default policy
below; the binary path comes from server config.

Optional `settings`:

```json
{ "time_ms": 2000, "lines": 5, "depth": 18 }
```

`time_ms` 250–30000; `lines` 1–5; `depth` 0–40 (default 0). Time and lines
required when settings supplied. Depth 0 has no depth target. Explicit
search stops at the first reached time/depth limit. Policy id is
`sf19-ms{time_ms}-mpv{lines}-d{depth}-t4-h128-v3`. Omitting settings keeps
the default policy below. The two forms differ by one segment: nil settings
resolve to the default `SearchPolicy` (with `n100k`), explicit settings to
`Policy()` (without it). Canonical limits live in
[spec/GLOSSARY.md](../spec/GLOSSARY.md#limits).

Settings page stores Stockfish prefs in this browser (initially 750 ms, 2
lines, depth 0). Prefs join position-cache and completed-analysis identity.
Maia analysis is independent of them.

Cache reuse: exact settings match first; compatible reuse needs same
time/depth with more lines. Reused rows keep their `search_policy`;
`actual_settings` names the producing search. Candidate-count reuse is
approximate.

## Response and score perspective

```json
{
  "engine": "Stockfish 19",
  "search_policy": "sf19-n100k-ms750-mpv2-t4-h128-v3",
  "depth": 15,
  "terminal": null,
  "best_move": "e2e4",
  "score": { "type": "cp", "value": 27 },
  "lines": [
    { "move": "e2e4", "score": { "type": "cp", "value": 27 }, "depth": 15 },
    { "move": "d2d4", "score": { "type": "cp", "value": 20 }, "depth": 15 }
  ]
}
```

Moves/scores/depths vary by search. All scores are White-perspective. `cp`
is centipawns (`+100` favors White). `mate` is signed moves to mate with
`winning_side: white|black`. Terminal mate uses `value: 0` plus explicit
`winning_side`.

`terminal` is `null`, `white_win`, `black_win`, or `draw`. Terminals return
200 without starting Stockfish: `depth: 0`, `best_move: null`, `lines: []`.
Draws score 0 cp. Mate outranks the move-clock draw rule.

Draws cover stalemate, insufficient material, existing threefold
repetition, and the 100-halfmove clock (chess.js automatic game-over
treatment of those claimable draws). A draw claimable only after the next
move does not end the current position, so the helper uses
existing-position repetition/clock checks, not `claim_draw=True`.
Fivefold/75-move also covered by python-chess outcome check.

`lines` holds up to the requested ranked root moves (2 default), distinct
first moves. `best_move`/`score` come from line 1. Depths are the engine's
reported depths; top-level depth is the minimum across lines. The helper
keeps the deepest iteration with exact scores for all requested lines,
drops bounds-only/incomplete iterations, and errors when none is complete.

## Resource and failure behavior

Default policy: 4 threads, 128 MiB hash, `MultiPV=2`, `Limit(nodes=100000,
time=0.75)`. Position validation adds time beyond the search clock. Depth is
observed, never a target. Wall-clock limit means results vary under load.

Two admission slots (interactive Focus + Batch) so Focus never queues
behind an in-flight Batch search. Helper spawns its engine once per slot
(version-checked, configured at startup); 128 MiB hash persists per slot.
Concurrent evaluations on one slot get `503 engine_busy` + `Retry-After: 1`;
no queue for single evaluations (whole games go through `POST /reviews` in
[docs/API.md](../../docs/API.md#opIdreviews-submit)). Whole op timeout 8 s tied to HTTP cancellation. Go starts
a separate process group; python-chess starts Stockfish with `setpgrp=False`
so both share it. Dead engine respawns once and retries; other failures
(timeout, unreachable helper, unusable output) kill the helper's group; next
lookup restarts warm. Explicit settings add the search time to the 8 s
timeout. Each slot stays held for the search; batch applies the budget per
position. Pipe waits cap at 1 s. Cleanup also kills survivors after a
wrapper crash and reaps adopted members when the server is PID 1.

Errors use the [generated API reference](../../docs/API.md) (`info.description`
in [spec/openapi.yaml](../spec/openapi.yaml) documents the envelope); `Code`
below rides in `errors[0].message`:

| HTTP | Code                 | Meaning                                                  |
| ---- | -------------------- | -------------------------------------------------------- |
| 400  | (none)               | Malformed JSON or trailing values                        |
| 422  | (none)               | Unknown fields, missing keys, misshapen settings         |
| 413  | (none)               | Body at or over the limit                                |
| 400  | `invalid_fen`        | Malformed FEN                                            |
| 400  | `invalid_position`   | Invalid position or illegal/malformed move               |
| 400  | `position_mismatch`  | Replay does not produce the supplied FEN                 |
| 400  | `history_too_long`   | More than 256 plies                                      |
| 405  | `method_not_allowed` | Method is not POST                                       |
| 503  | `engine_busy`        | Slot occupied                                            |
| 502  | `engine_unavailable` | Timeout, process failure, wrong version, unusable output |

Client errors carry no engine stderr or system paths. Operator config
(`PYTHON`, `STOCKFISH_WORKER`, `STOCKFISH_BINARY`) is in the
[backend README](README.md#runtime-configuration-and-upstream).

## Timing traces

Worker log lines (`stockfish_timing outcome=ok ...` plus `outcome=error`
with `total_ms`) split each evaluation into process-spawn vs actual search.

`search_ms` near requested `time_ms` points at the search budget; `spawn_ms`
near zero on a warm engine, nonzero after restart. Compare `plies` for
history-length effects.

## Build provenance and redistribution

Engine inputs pinned by `backend/Dockerfile`:

- Official source: https://github.com/official-stockfish/Stockfish (`sf_19`, commit `edb0d9db6731067ec50ce619ff372b463bc4dd5d`)
- Source archive: https://github.com/official-stockfish/Stockfish/archive/refs/tags/sf_19.tar.gz
- Archive SHA-256: `519b653d0d1ffb96531d982ccbe5c6a19425e8388e0e3c2f70f34b424ab32d76`
- Embedded network: `nn-1a298aa575a0.nnue` — SHA-256 `1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2`
- Network URL: https://tests.stockfishchess.org/api/nn/nn-1a298aa575a0.nnue
- Python packages: `python-chess==1.999`, `chess==1.11.2`

Stockfish is GPL-3.0. The runtime image includes its `COPYING`, source
archive, and this document under `/app/licenses/`. Preserve source, network
access, license, and build recipe when redistributing binaries.

## Verification

Engine-only checks (worker tests plus the gated Go HTTP/cancellation test).
Shared Go suite (`go test`, `go vet`) is in the
[backend README](README.md#local-verification):

```sh
cd backend/workers && STOCKFISH_BINARY=/app/stockfish python3 -m unittest -v test_stockfish_worker test_engine_settings
STOCKFISH_BINARY=/app/stockfish go test ./internal/server/ -v -run TestRealStockfishHTTPAndCancellation
```

Python discovery runs from `backend/workers/`.

Worker modules combine mocked searches with real helper subprocesses and the
native engine; real searches skip when `STOCKFISH_BINARY` is unset. Covers
start/middle/endgame, score signs, mates, terminals without engine,
full-history repetition, invalid positions, custom-start replay.

Engine-only verification from the repo root:

```sh
docker build --target stockfish-build -f backend/Dockerfile -t maia-board-stockfish-check:engine .
container=$(docker create maia-board-stockfish-check:engine)
docker cp "$container:/stockfish/src/stockfish" /tmp/stockfish
docker rm "$container"
cd backend/workers && STOCKFISH_BINARY=/tmp/stockfish python3 -m unittest -v test_stockfish_worker test_engine_settings
```

Same extraction supports host verification of `test_engine_settings` and
the Go HTTP/cancellation test with Python 3.12 and pinned chess packages.
