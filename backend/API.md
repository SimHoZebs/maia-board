# Maia Board HTTP API

Conventions, routes, and error shapes. Stockfish search internals are in
[STOCKFISH.md](STOCKFISH.md). Canonical terms and the limits table are in
[../spec/GLOSSARY.md](../spec/GLOSSARY.md).

## Envelope and limits

- Errors are Huma `ErrorModel` JSON: `{title, status, detail, errors}`.
  Machine-readable codes (`invalid_fen`, `engine_busy`, `superseded`, …)
  ride in `errors[0].message`; human text in `detail`. Huma request errors
  (malformed JSON → `400`, unknown fields or missing keys → `422`,
  oversized bodies → `413`) carry no code and read as `unknown`.
  Machine-readable spec: `/openapi.json` (checked in as
  [../spec/openapi.yaml](../spec/openapi.yaml)).
- Single-object POST endpoints reject unknown fields (`422`), trailing
  values (`400`), over-limit bodies (`413`).
- Body limits: `/move`, `/move/analysis`, `/evaluate`, `/games`, `/openings`
  under 64 KiB; `/reviews`, `/evaluations/lookup` under 4 MiB.
- `X-Eval-Cache: hit | miss` on `/move`, `/move/analysis` (only
  `temperature == 0`; sampled requests omit it), `/evaluate`. Bulk lookup
  and batch progress do not set it.
- FEN: six-field position. UCI: coordinate move (`e2e4`, `a7a8q`). Ply: one
  player's move.

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
- `elo_maia`/`elo_user` required, 0–5000; `elo_maia` is the mover (Self,
  `maia_color` side), `elo_user` the other side. History review sends
  per-mover pairs. `temperature` 0–2 (default 0).
- `moves` max 256 plies, UCI.
- Errors: `400 invalid_request | invalid_fen | invalid_elo | invalid_model | invalid_maia_color | not_maia_turn | history_too_long | invalid_move | invalid_initial_fen | position_mismatch | missing_elo | game_over | invalid_position`, `409 superseded`, `503 engine_busy` (`Retry-After: 1`), `502 engine_unavailable`, `405 method_not_allowed`.

## POST /move/analysis

Retrospective Maia analysis (Focus lane). Shapes match `/move`, plus
read-time delta context:

```json
{"delta_baseline": {"value": 52.1, "kind": "before"},
 "top_moves": [{"move": "c7c5", "prob": 0.31, "wdl": [...], "delta": 1.2}]}
```

`delta_baseline`/`delta` attach at serve time from the before-2400 grading
row, never stored; absent without a grading row. Same error set as `/move`
(lane `focus`).

## POST /evaluate

Stockfish search (Focus lane). Settings/score/provenance in
[STOCKFISH.md](STOCKFISH.md).

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

- `moves` max 256 plies; `settings` (when present) needs `time_ms`
  250–30000, `lines` 1–5, `depth` 0–40.
- Errors: STOCKFISH.md table (`invalid_json | invalid_fen |
invalid_position | position_mismatch | history_too_long`,
  `503 engine_busy` + `Retry-After: 1`, `502 engine_unavailable`,
  `405 method_not_allowed`).

## POST /evaluations/lookup

Read-only bulk cache read. Never infers; misses are absent from `results`.

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

- `line.moves`: shared game line (max 4096 plies, UCI); each entry's `ply`
  slices it (`moves[:ply]`).
- Max 1024 entries. Each needs `engine`, `fen`, `ply`; `sf` takes
  `settings`, `maia` takes `elo_maia`/`elo_user`/`model` (never mixed).
- Errors: `400 invalid_request` (indexed as `requests[i]: …`),
  `405 method_not_allowed`, `502 engine_unavailable` when the store is down.

## POST /reviews

Whole-game batch submit. Two-phase: validate + cache-filter, then insert
or `429`.

```json
// request: same {line, requests} shape as /evaluations/lookup
// response 202
{ "job_id": "<hex>", "total": 300, "cached": 120, "pending": 180 }
```

- Max 768 entries (`400 invalid_request` outside 1–768); cache hits settle
  at intake and never queue.
- Caps: max 8 unfinished jobs; max 768 unresolved misses per scheduler
  (sf / maia-79m / maia-5m; 79m misses count against both Maia tallies).
  Over either cap → `429 engine_busy` with `Retry-After: 5`.
- `502 engine_unavailable` when the store is down, or Stockfish absent while
  sf misses remain.
- Per-index engine failures do not fail the submit; they surface in the
  status `errors` map.

## GET /reviews/:id

Batch status poll. This GET is the status read (no `/status` path).

```json
{
  "job_id": "<id>",
  "total": 300,
  "done": 200,
  "failed": 3,
  "finished": false,
  "errors": { "42": "the engine is busy" }
}
```

- Errors: `404 not_found` (unknown or evicted id; only the last 8 finished
  jobs are retained), `405 method_not_allowed` (no DELETE).

## GET /reviews/:id/events (SSE)

Streams `event: progress` with the bare batch status JSON as `data` (same
shape as `GET /reviews/:id`), starting with a snapshot. No replay buffer;
Last-Event-ID ignored; counters are cumulative so the latest tick
supersedes earlier ones. Heartbeat `:ping` every 15 s; ends when
`finished: true`. `Content-Type: text/event-stream`, no buffering.
Errors: `404 not_found`, `405 method_not_allowed`.

## GET /games, POST /games

```json
// GET /games?limit=200&offset=0 → 200
{"games": [{...}], "current_id": "<id>|null", "current_game": {...},
 "total": 12, "next_offset": 10}
// POST /games → 200 (insert or update; unchanged re-save keeps recency)
{"user_color": "white", "elo_maia": 1500, "elo_user": 1300,
 "model": "79m", "moves": ["e2e4"], "result": "", "current": true}
```

- List default `limit` 200, max 500; `offset` non-negative;
  `next_offset: null` ends pagination. `current_game` present only when a
  current game exists. Row:
  `{id, created_at, updated_at, user_color, elo_maia, elo_user,
model, moves, temperature, result?, source?, opponent?, rating_diff?}`.
  `rating_diff` is the user's Lichess rating change (nil when unknown).
- Save: `user_color` white/black, elos 0–5000, `model` 79m/5m, `moves` max
  4096 plies UCI, `result` empty or `resigned`, `temperature` 0–2,
  `created_at` RFC3339 when supplied. `opponent`/`source`/`rating_diff` are
  server-owned: single saves stamp `Maia <elo>`/`local`/nil and ignore
  client values.
- Errors: `400 invalid_request | invalid_user_color | missing_elo | invalid_elo | invalid_model | history_too_long | invalid_move | invalid_result | invalid_created_at | invalid_rating_diff`, `502 engine_unavailable`, `405 method_not_allowed`.

## GET /games/:id, DELETE /games/:id

- `GET` → 200 game row; unknown id → `404 not_found`.
- `DELETE` → 204, idempotent (unknown ids still succeed), clears a matching
  current-game marker. Other methods → `405`.

## POST /openings

```json
// request
{"initial_fen": "<optional custom start>", "moves": ["e2e4", "c7c5"]}
// response
{"matches": [{"ply": 1, "eco": "B20", "name": "Sicilian Defense"}],
 "book_flags": [true, true], "degraded": true}
```

- `moves` UCI, max 4096 plies. Book covers the standard start only:
  custom-start lines return empty matches / all-false flags, never an error.
  Missing table degrades with `"degraded": true`.
- Errors: `400 invalid_fen | invalid_position | history_too_long`,
  `502 openings_unavailable`, `405 method_not_allowed`.

## POST /auth/local, POST /auth/logout, GET /me

Session accounts (plain Chi handlers; Huma cannot set cookies).

```json
// POST /auth/local → 200 (sets HttpOnly maia_board_session cookie)
{"display_name": "Alice"}
// → User row
{"id": "<hex>", "created_at": "<rfc3339>", "display_name": "Alice",
 "lichess_username": "alice", "lichess_id": "plain-id"}
// GET /me → 200 User row; 401 without a session
// POST /auth/logout → 204 (revokes session, clears cookie)
```

- Every `/games`, `/move`, `/move/analysis`, `/evaluate`,
  `/evaluations/lookup`, `/reviews`, `/openings`, `/imports/games` call
  needs the session cookie (or `Authorization: Bearer`); without it →
  `401 unauthenticated`. Bare `&Server{}` test instances stay in open mode.
- Games scope to the session owner: lists count owned rows only, reads of
  another owner's id answer `404 not_found`, saves stamping another id
  answer `403 forbidden`; current-game marker is per user.

## GET /auth/lichess/start, GET|POST /auth/lichess/callback

Lichess OAuth (PKCE S256, `scope=preference:read`). Configure
`LICHESS_CLIENT_ID` (+ secret when confidential, `LICHESS_REDIRECT_URI`).

```json
// GET /auth/lichess/start?redirect_uri=<url> → 200
{
  "authorization_url": "https://lichess.org/oauth?...&state=<hex>",
  "state": "<hex>"
}
// GET /auth/lichess/callback?code=...&state=... → 302 to /settings?login=ok
// (sets cookie; browser leg). POST with {code, state} → 200 User row.
```

- Without client config `/start` answers `501 oauth_unconfigured`.
- Callback exchanges the code at `https://lichess.org/api/token`, reads
  `https://lichess.org/api/account`, upserts by Lichess id.

## POST /imports/games

Bulk history append into the caller's store (max 100 entries, 4 MiB;
per-entry `current` ignored).

```json
// request (provider/username record a run; entries may carry source)
{"provider": "lichess", "username": "bob",
 "games": [{"user_color": "white", "elo_maia": 1500, "elo_user": 1300,
  "model": "79m", "moves": ["e2e4"], "created_at": "2024-01-01T00:00:00Z",
  "source": "lichess:abc123xy", "opponent": "foe", "rating_diff": 12}]}
// response 200 (400 when nothing saved and real errors exist)
{"saved": [{...}], "errors": {"3": "invalid_move"}, "skipped": 5, "refreshed": 2}
```

- Entries validate like `POST /games`; ownership forced from the session.
  `source` accepts `lichess:<gameId>` only (`400 invalid_source`);
  already-owned sources skip, never duplicate. `opponent` 1–64 printable
  chars (`400 invalid_opponent`) backfills pre-name rows. `rating_diff`
  -1000..1000 (`400 invalid_rating_diff`) backfills pre-diff rows.
  `time_control`, `speed`, `clocks` backfill likewise. `refreshed` counts
  skipped rows that gained a field. All-skipped is `200` ("already up to
  date"). Errors: `400 invalid_request` (empty or >100 entries, unknown
  provider), `401 unauthenticated`, per-index codes in `errors`.

## GET /imports/status

History summary: newest Lichess run plus owned total.

```json
// response 200
{"last": {"id": "<hex>", "provider": "lichess", "username": "bob",
  "requested": 10, "saved": 8, "skipped": 2, "created_at": "<rfc3339>"},
 "total": 42}
// no run yet
{"last": null, "total": 0}
```

## GET /healthz

Liveness plus Maia worker state. `GET` only.

```json
{"status": "ok|degraded|unavailable", "models": {"79m": {...}, "5m": {...}}}
```

Single-model servers (`MAIA3_FALLBACK_MODEL=off`) omit `5m` and report
`unavailable` when the primary failed. Returns 503 when every configured
pool failed, 200 otherwise. Explicit `5m` on such servers: `400
invalid_model` (`/move`, `/move/analysis`) or `400 invalid_request`
(batch); cached `5m` lookup rows still serve.
