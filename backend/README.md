# maia-board backend spike

This spike runs a Go HTTP server and keeps Maia3 inference in a Python worker.
The worker imports the pinned upstream `Maia3UCIEngine`, preserving its model
configuration and history handling. It adds policy probability to each UCI
MultiPV line because upstream's stock UCI output exposes WDL and PV but omits
policy.

## API

`POST /move` accepts:

```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
  "moves": ["e2e4"],
  "elo_maia": 1500,
  "elo_user": 1300,
  "model": "79m",
  "maia_color": "black"
}
```

`fen` is the current position. `moves` are UCI plies from `initial_fen` to
`fen`; omit `initial_fen` for standard startpos. Supply `initial_fen` for a
custom starting position. The worker replays the sequence and rejects a
mismatch before `go`.

The Go layer checks FEN shape and UCI move shape before acquiring a worker;
python-chess in the worker performs semantic FEN and move-legality checks.

The endpoint only predicts when `maia_color` matches the FEN side to move.
Accepted values for `model` are lowercase `79m` and `5m`; omitted `model`
defaults to `79m`. Elo validation follows the upstream UCI declaration of
0–5000. `moves` is limited to 256 plies as a resource guard.

The response contains `wdl` as normalized `[loss, draw, win]` probabilities.
It is the primary candidate's post-move WDL. `top_moves` is rank-ordered and
contains upstream policy probabilities. `model_used` and `degraded` signal a
79M-to-5M fallback.

The endpoint returns `400 position_mismatch` before inference when replaying
`initial_fen` plus `moves` does not produce `fen`; `400 not_maia_turn` when the
requested Maia color is not on move; and `400 game_over` when no legal move
exists.

## Game history

`GET /games` lists stored games newest-first with `{games, current_id, total}`.
`POST /games` upserts `{id?, user_color, elo_maia, elo_user, model, moves[],
created_at?, current?}`; a missing id gets a server uuid, `created_at` must be
RFC3339 and is immutable afterwards, and `current: true` moves the
current-game marker in the same transaction. `GET /games/:id` returns one game
or `404 not_found`; `DELETE /games/:id` is idempotent (`204`) and clears the
marker when it points at the deleted game. Elo, UCI shape, and 256-ply limits
mirror `/move`. Re-saving unchanged content keeps its position in recency
order, so resume and migration never reshuffle History.

Storage is SQLite through a pure-Go driver (no CGO, static binary preserved),
WAL mode, `DB_PATH` (default `./maia-board.db`, `/data/maia-board.db` in the
managed deployment). Results derive from moves; only history and the marker
persist. Back up with `VACUUM INTO` against a copy of the database file.

## Evaluation cache

Analysis results live in the same database because the access pattern is
exact-key lookup, not document queries — a separate document store would add
ops burden for no query benefit. `PUT /evaluations/:hash` stores
`{engine, key, value}` under a client hash (`sf` or `maia` only, JSON object
values, short keys); `GET /evaluations/:hash` returns the row or
`404 not_found`; `GET /evaluations/stats` reports row count and bytes. Rows
evict oldest-first past 5000. The key format stays client-owned so policy,
model, or rating changes miss naturally instead of poisoning results.

## Local checks

```sh
CGO_ENABLED=0 go test ./...
python3 -m py_compile maia3_worker.py
```

The container pins upstream Maia3 at commit
`1e13597c42d4858b7cfd7cfdae01e297263364b2`, installs the CPU-only
`torch==2.14.0+cpu` wheel, and uses:

```text
python maia3_worker.py --model 79m --device cpu --no-use-amp \
  --multipv 5 --temperature 0 --use-uci-history
```

The upstream source and protocol are documented at:

- https://github.com/CSSLab/maia3
- https://raw.githubusercontent.com/CSSLab/maia3/main/maia3/uci.py

## Isolated debian-server spike

The unmanaged spike is loopback-only and does not touch the Komodo repository:

```sh
ssh -F /home/simho/.kimaki/ssh/config debian-server \
  'ls -la /home/simho/projects'
ssh -F /home/simho/.kimaki/ssh/config debian-server \
  'mkdir -p /home/simho/projects/maia-board-spike /home/simho/projects/maia-board-cache'

# Copy the repository root to the verified remote spike directory, then compare
# SHA256 for the copied files.
docker build -f /home/simho/projects/maia-board-spike/backend/Dockerfile \
  -t maia-board-spike:dev /home/simho/projects/maia-board-spike
docker run -d --name maia-board-spike-dev --restart=no \
  --publish 127.0.0.1:18765:8080 \
  --mount type=bind,src=/home/simho/projects/maia-board-cache,dst=/models \
  --memory=8g --cpus=6 maia-board-spike:dev
```

The 79M worker is attempted first. A failed acquired 79M request falls back
per request to 5M. A busy worker returns 503 without fallback. An explicit
`model: "5m"` request uses only 5M.

For the sequential fallback check, tear down the primary first, assert
`127.0.0.1:18766` is free, then run this second container with `--memory=4g
--cpus=2`. It uses an invalid 79M alias and the cached 5M model:

```sh
docker run -d --name maia-board-spike-fallback --restart=no \
  --env MAIA3_MODEL_79M=invalid-model-alias \
  --publish 127.0.0.1:18766:8080 \
  --mount type=bind,src=/home/simho/projects/maia-board-cache,dst=/models \
  --memory=4g --cpus=2 maia-board-spike:dev
```

Tear down both containers explicitly:

```sh
docker stop maia-board-spike-dev; docker rm maia-board-spike-dev
docker stop maia-board-spike-fallback; docker rm maia-board-spike-fallback
```

Run one cold request and three warm requests for each model. Record every
total time and the maximum warm time in
`/tmp/maia-board-spike-timing.txt` on debian-server. A maximum warm time over
5 seconds opens a GPU follow-up; it does not fail this spike.
