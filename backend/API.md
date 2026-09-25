# Maia Board HTTP API

Conventions, routes, and error shapes. Stockfish search internals
(policy, scores, reuse, timeouts) live in [STOCKFISH.md](STOCKFISH.md)
and are not duplicated here.

## Envelope and limits

- Errors are `{code, message}` as JSON (see [STOCKFISH.md](STOCKFISH.md#resource-and-failure-behavior) for the Stockfish table).
- Single-object POST endpoints reject unknown fields, trailing values,
  and over-limit bodies with `400 invalid_json`.
- Body limits: `POST /move`, `/move/analysis`, `/evaluate`, `/games`,
  `/openings` accept at most 64 KiB; `POST /reviews` and
  `POST /evaluations/lookup` accept at most 4 MiB.
- `X-Eval-Cache: hit | miss` is set on `POST /move`, `/move/analysis`
  (only when `temperature == 0`; sampled requests omit it), and
  `POST /evaluate`. Bulk lookup and batch progress do not set it.
- FEN means six-field position string; UCI means coordinate move
  (`e2e4`, `a7a8q`); ply means one player's move.

## POST /move

Live Maia reply (Play lane). Same payload as `/move/analysis`.

```json
// request
{"fen": "<six-field FEN>", "moves": ["e2e4"], "elo_maia": 1500,
 "elo_user": 1300, "model": "79m", "maia_color": "black",
 "initial_fen": "<optional custom start>", "temperature": 0}
// response
{"move": "c7c5", "top_moves": [{"move": "c7c5", "prob": 0.31, "wdl": [0.2, 0.5, 0.3]}],
 "wdl": [0.2, 0.5, 0.3], "model_used": "79m", "degraded": false}
```

- `model`: `79m` (default) or `5m`; `maia_color` must match FEN side to move.
- `elo_maia`/`elo_user` required, 0–5000; `temperature` 0–2 (default 0).
- `moves` at most 256 plies, UCI-shaped.
- Errors: `400 invalid_request | invalid_fen | invalid_elo | invalid_model | invalid_maia_color | not_maia_turn | history_too_long | invalid_move | invalid_initial_fen | position_mismatch | missing_elo | game_over | invalid_position`, `409 superseded` (same-lane newer request won), `503 engine_busy` (`Retry-After: 1`), `502 engine_unavailable`, `405 method_not_allowed`.

## POST /move/analysis

Retrospective Maia analysis (Focus lane). Request/response shapes match
`POST /move`, except the response may also carry read-time delta context:

```json
{"delta_baseline": {"value": 52.1, "kind": "before"},
 "top_moves": [{"move": "c7c5", "prob": 0.31, "wdl": [...], "delta": 1.2}]}
```

`delta_baseline`/`delta` are attached at serve time from the
before-position 2400 grading row, never stored; absent when no grading
row applies. Same error set as `/move` (lane `focus`).

## POST /evaluate

Stockfish search (Focus lane). Full settings/score/provenance semantics
in [STOCKFISH.md](STOCKFISH.md).

```json
// request
{"fen": "<FEN>", "moves": [], "initial_fen": "<optional>",
 "settings": {"time_ms": 2000, "lines": 5, "depth": 0}}
// response (sketch)
{"engine": "Stockfish 19", "search_policy": "sf19-…", "depth": 15,
 "terminal": null, "best_move": "e2e4",
 "score": {"type": "cp", "value": 27}, "lines": [...],
 "actual_settings": {"time_ms": 2000, "lines": 5, "depth": 0}}
```

- `moves` at most 256 plies; `settings` (when present) needs
  `time_ms` 250–30000, `lines` 1–5, `depth` 0–40.
- Errors: STOCKFISH.md table (`invalid_json | invalid_fen |
  invalid_position | position_mismatch | history_too_long`,
  `503 engine_busy` + `Retry-After: 1`, `502 engine_unavailable`,
  `405 method_not_allowed`).

## POST /evaluations/lookup

Read-only bulk cache read. Never starts inference; misses are simply
absent from `results`.

```json
// request
{"line": {"initial_fen": "<start>", "moves": ["e2e4", "c7c5"]},
 "requests": [{"engine": "sf", "fen": "<FEN>", "ply": 2,
               "settings": {"time_ms": 750, "lines": 2, "depth": 0}},
              {"engine": "maia", "fen": "<FEN>", "ply": 1,
               "elo_maia": 1500, "elo_user": 1300, "model": "79m"}]}
// response
{"results": [{"index": 0, "value": {...}, "actual_settings": {...}}]}
```

- `line.moves` is the shared game line (at most 4096 plies, UCI);
  each entry's `ply` slices it (`moves[:ply]`).
- At most 1024 entries. Each entry requires `engine`, `fen`, `ply`;
  `sf` entries take `settings`, `maia` entries take
  `elo_maia`/`elo_user`/`model` (never mixed).
- Errors: `400 invalid_request` (indexed as `requests[i]: …`),
  `405 method_not_allowed`, `502 engine_unavailable` when the store is down.

## POST /reviews

Whole-game batch submit. Two-phase admission: validate + cache-filter,
then insert or `429`.

```json
// request: same {line, requests} shape as /evaluations/lookup
// response 202
{"job_id": "<hex>", "total": 300, "cached": 120, "pending": 180}
```

- At most 768 entries (`400 invalid_request` outside 1–768);
  cache hits settle at intake and never consume queue.
- Caps: at most 8 unfinished jobs; at most 768 unresolved misses per
  scheduler (sf / maia-79m / maia-5m; 79m misses count against both
  Maia tallies). Over either cap → `429 engine_busy` with
  `Retry-After: 5`.
- `502 engine_unavailable` when the store is down, or Stockfish is
  absent while sf misses remain.
- Per-index engine failures do not fail the submit; they surface in
  the status `errors` map.

## GET /reviews/:id

Batch status poll (there is no `/reviews/:id/status` path; this GET
is the status read).

```json
{"job_id": "<id>", "total": 300, "done": 200, "failed": 3,
 "finished": false, "errors": {"42": "the engine is busy"}}
```

- Errors: `404 not_found` (unknown or evicted id; only the last 8
  finished jobs are retained), `405 method_not_allowed` (no DELETE).

## GET /reviews/:id/events (SSE)

Streams `event: progress` with the status JSON as `data`, starting
with a snapshot so reconnects reconcile via `GET /reviews/:id` +
bulk lookup. Heartbeat `:ping` every 15 s; stream ends when
`finished: true`. `Content-Type: text/event-stream`, no buffering.
Errors: `404 not_found`, `405 method_not_allowed`.

## GET /games, POST /games

```json
// GET /games?limit=200&offset=0 → 200
{"games": [{...}], "current_id": "<id>|null", "current_game": {...}|null,
 "total": 12, "next_offset": 10}
// POST /games → 200 (insert or update; unchanged re-save keeps recency)
{"user_color": "white", "elo_maia": 1500, "elo_user": 1300,
 "model": "79m", "moves": ["e2e4"], "result": "", "current": true}
```

- List default `limit` 200, max 500; `offset` non-negative;
  `next_offset: null` ends pagination. Game row:
  `{id, created_at, updated_at, user_color, elo_maia, elo_user,
  model, moves, temperature, result?}`.
- Save: `user_color` white/black, elos 0–5000, `model` 79m/5m,
  `moves` at most 4096 plies UCI, `result` empty or `resigned`,
  `temperature` 0–2, `created_at` RFC3339 when supplied.
- Errors: `400 invalid_request | invalid_user_color | missing_elo | invalid_elo | invalid_model | history_too_long | invalid_move | invalid_result | invalid_created_at`, `502 engine_unavailable` (store down), `405 method_not_allowed`.

## GET /games/:id, DELETE /games/:id

- `GET` → 200 game row; unknown id → `404 not_found`.
- `DELETE` → 204, idempotent (unknown ids still succeed), clears a
  matching current-game marker. Other methods → `405`.

## POST /openings

```json
// request
{"initial_fen": "<optional custom start>", "moves": ["e2e4", "c7c5"]}
// response
{"matches": [{"ply": 1, "eco": "B20", "name": "Sicilian Defense"}],
 "book_flags": [true, true], "degraded": true}
```

- `moves` UCI, at most 4096 plies. Book is defined from the standard
  start only: custom-start lines return empty matches / all-false
  flags, never an error. Missing table degrades with
  `"degraded": true`.
- Errors: `400 invalid_fen | invalid_position | history_too_long`,
  `502 openings_unavailable`, `405 method_not_allowed`.

## GET /healthz

Liveness plus Maia worker state. `GET` or `HEAD`.

```json
{"status": "ok|degraded|unavailable", "models": {"79m": {...}, "5m": {...}}}
```

Returns 503 when both workers failed, 200 otherwise.
