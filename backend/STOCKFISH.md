# Stockfish evaluation

`POST /evaluate` runs native Stockfish 19 through a separate Python helper.
The Go server owns its admission slot and request cancellation. See the
[backend README](README.md) for the other API endpoints and the
[root README](../README.md) for FEN (position), UCI (coordinate move), and ply
(one player's move) terminology.

## Request and position history

```json
{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","moves":[]}
```

`initial_fen` optionally supplies a custom starting position; otherwise the
standard starting position applies. `moves` contains UCI coordinate moves
(for example `e2e4` or `a7a8q`) from that starting position. The helper checks
both positions for semantic validity, replays legal moves, and compares the
result with `fen`, including counters. FEN comparison normalizes castling and
en-passant representation through python-chess; uncapturable en-passant targets
normalize to `-`. Both sides to move are supported.

Send the full available history, including when examining an earlier position.
Repetition and Stockfish search depend on that history. A custom starting FEN
cannot reconstruct repetitions before that position. Requests accept at most
64 KiB of JSON and 256 plies (individual player moves). Unknown JSON fields and
trailing JSON values are rejected. Executables, threads, and memory come from
server configuration.

Optional `settings` configures the search:

```json
{"time_ms":2000,"lines":5,"depth":18}
```

`time_ms` is an integer from 250 to 30000; `lines` is an integer from 1 to 5;
`depth` is an integer from 0 to 40, defaulting to 0. Time and lines are required
when supplying settings. Depth 0 has no depth target. An explicit search uses time and optional
depth limits, with no node-count limit; the first reached limit stops the search.
Its policy identifier is `sf19-ms{time_ms}-mpv{lines}-d{depth}-t1-h64-v2`.
Omitting settings retains the legacy policy shown below.

The frontend Settings page saves Stockfish preferences in this browser, initially
750 ms, 2 lines, and depth 0. Preferences are included in position-cache and
completed-analysis identities. Maia analysis remains independent of these settings.

The server derives evaluation cache identity from the request and engine revision.
An exact settings match takes precedence over compatible reuse with the same time
and depth but more candidate lines. Reused results retain their original
`search_policy`; `actual_settings` identifies the search that produced them.
Candidate-count reuse is approximate because a larger search can divide its time
differently. The [backend README](README.md#storage-and-cache) describes bulk lookup.

## Response and score perspective

```json
{
  "engine": "Stockfish 19",
  "search_policy": "sf19-n100k-ms750-mpv2-t1-h64-v1",
  "depth": 15,
  "terminal": null,
  "best_move": "e2e4",
  "score": {"type": "cp", "value": 27},
  "lines": [
    {"move": "e2e4", "score": {"type": "cp", "value": 27}, "depth": 15},
    {"move": "d2d4", "score": {"type": "cp", "value": 20}, "depth": 15}
  ]
}
```

The example illustrates the shape; moves, scores, and depths vary by search.
All scores use White's perspective. `cp` means centipawns: `+100` favors White,
`-100` favors Black. A `mate` score reports signed moves to mate: `+3` with
`winning_side: "white"`, or `-3` with `winning_side: "black"`. Terminal checkmate
uses `value: 0` and an explicit `winning_side` to remove zero-sign ambiguity.

`terminal` is `null`, `white_win`, `black_win`, or `draw`. Terminal positions
return HTTP 200 without starting Stockfish: `depth: 0`, `best_move: null`,
and `lines: []`. Draws have a zero centipawn score. Checkmate takes precedence
over the move-clock draw rule.

Draw detection includes stalemate, insufficient material, existing threefold
repetition, and the existing 100-halfmove clock, matching chess.js's automatic
game-over treatment of those claimable draws. A draw claim available only
after announcing the next move does **not** end the current position. Thus the
helper deliberately uses existing-position repetition/clock checks rather
than python-chess's broader `claim_draw=True`. Automatic fivefold repetition
and the 75-move rule are also covered by python-chess's outcome check.

`lines` contains up to the requested number of ranked root moves (two for legacy
requests), with distinct first moves across ranks. `best_move` and `score` come from
the first line. Each depth is the engine's actual reported search depth;
top-level depth is the minimum across returned lines. The helper selects the
deepest iteration containing exact scores for all requested root lines. It
discards bounds-only reports and incomplete iterations. If no complete exact
iteration is available, it returns an engine error.

## Resource and failure behavior

The legacy policy uses one thread, 64 MiB hash, two principal variations
(`MultiPV=2`, meaning two candidate lines), and
`Limit(nodes=100000, time=0.75)`. The node budget is capped by a 750 ms search
clock. Engine startup, position validation, and shutdown add time beyond the
search clock. Search depth is an observation, never a target or guarantee.
The wall-clock limit can cause results to vary under host load.

One admission slot covers helper launch through process cleanup. Concurrent
evaluations receive `503 engine_busy` with `Retry-After: 1`; there is no queue
or public batch endpoint. The whole operation has an eight-second timeout tied
to HTTP request cancellation. Go starts a separate process group; python-chess
starts Stockfish with `setpgrp=False` so both inherit that group. Normal cleanup
uses UCI `quit` and closes the engine. Cancellation sends `SIGKILL` to the whole
group. Explicit settings add the requested search time to the eight-second
operation timeout. The single admission slot stays occupied during that search;
whole-game reviews apply the budget separately to each position.
Pipe waits are capped at one second. Cleanup also kills survivors after
a wrapper crash and reaps adopted group members when the server is PID 1.

Errors use `{code, message}`:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_json` | JSON syntax, shape, unknown fields, extra values, or body limit |
| 400 | `invalid_fen` | Malformed FEN |
| 400 | `invalid_position` | Semantically invalid position or illegal/malformed move |
| 400 | `position_mismatch` | Replay does not produce the supplied FEN |
| 400 | `history_too_long` | More than 256 plies |
| 405 | `method_not_allowed` | Request method is not POST |
| 503 | `engine_busy` | Evaluation slot occupied |
| 502 | `engine_unavailable` | Timeout, process failure, wrong engine version, or unusable output |

Client error messages contain no engine stderr or system paths.
Operator configuration: `PYTHON` (default `python3`), `STOCKFISH_WORKER`
(default `/app/stockfish_worker.py`), and `STOCKFISH_BINARY`
(default `/app/stockfish`).

## Timing traces

Server and worker logs separate request time from native search time:

- Server log, one line per request: `evaluate status=… plies=… policy=…
  duration_ms=… depth=… lines=…` and `move status=… plies=… model=…
  degraded=… duration_ms=…`. Read with `docker logs` (Komodo keeps them).
- Worker lines in the same server log: `stockfish_timing outcome=ok
  policy=… multipv=… plies=… total_ms=… spawn_ms=… search_ms=… depth=…
  lines=…`, plus `outcome=error` with `total_ms` on failures. They split
  each evaluation into process-spawn vs actual search.

`search_ms` near the requested `time_ms` points at the search budget;
`spawn_ms`-dominated cost points at process startup. Compare `plies` across requests
to examine history-length effects. The [frontend performance fixture](../frontend/README.md#simulated-client-performance)
separately measures navigation, rendering, and mocked network timings.

## Build provenance and redistribution

Engine inputs pinned by `backend/Dockerfile`:

- Official source: https://github.com/official-stockfish/Stockfish (`sf_19`, commit `edb0d9db6731067ec50ce619ff372b463bc4dd5d`)
- Source archive: https://github.com/official-stockfish/Stockfish/archive/refs/tags/sf_19.tar.gz
- Archive SHA-256: `519b653d0d1ffb96531d982ccbe5c6a19425e8388e0e3c2f70f34b424ab32d76`
- Embedded network: `nn-1a298aa575a0.nnue` — SHA-256 `1a298aa575a085434d29027978dc36867fe9c5bcea9376654b7a8eba1e52dfc2`
- Network URL: https://tests.stockfishchess.org/api/nn/nn-1a298aa575a0.nnue
- Python packages: `python-chess==1.999`, `chess==1.11.2`

Stockfish is GPL-3.0 licensed. The runtime image includes its `COPYING`,
original source archive, and this document under `/app/licenses/`. Preserve
the source, network access, license, and build recipe when redistributing
binaries.

## Verification

From `backend/`:

```sh
CGO_ENABLED=0 go test ./...
CGO_ENABLED=0 go vet ./...
STOCKFISH_BINARY=/app/stockfish python3 -m unittest -v test_stockfish_worker test_engine_settings
STOCKFISH_BINARY=/app/stockfish STOCKFISH_WORKER=stockfish_worker.py go test -v -run TestRealStockfishHTTPAndCancellation
```

The Python modules combine mocked searches with actual helper subprocesses
and the real native engine; real searches skip when `STOCKFISH_BINARY` is unset.
It checks start/middle/endgame searches, score signs, mating moves, terminal
handling without an engine, full-history repetition, invalid positions, and
custom-start replay. The Go suite checks HTTP validation, error mapping, busy
admission, request cancellation, timeout, and process-group cleanup; the
environment-gated integration test also observes the real Stockfish child
before cancelling its request.

Engine-only verification from the repository root:

```sh
docker build --target stockfish-build -f backend/Dockerfile -t maia-board-stockfish-check:engine .
container=$(docker create maia-board-stockfish-check:engine)
docker cp "$container:/stockfish/src/stockfish" /tmp/stockfish
docker rm "$container"
STOCKFISH_BINARY=/tmp/stockfish python3 -m unittest -v test_stockfish_worker test_engine_settings
```

CI extracts the binary the same way and additionally runs
`test_engine_settings` and the Go HTTP/cancellation integration test on the
host with Python 3.12 and the pinned chess packages.
