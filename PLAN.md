# maia-board — self-hosted Maia3 play + analysis

Minimal alternative to `maia-platform-frontend`: just play-vs-Maia and an
analysis board, with inference on the home cluster instead of phone WASM.

## Decisions (from ideation thread, 2026-09-09)

- **Modes:** play vs computer + analysis board. No training/drills/openings.
- **Frontend:** own minimal static page (no fork of the platform frontend).
  React + official `@lichess-org/chessground` through a local lifecycle adapter,
  `chess.js` (rules/PGN), and `fetch` to our API.
  Keep upstream platform repo unmodified as design reference only.
- **Inference:** server-side. Chain per request: **79M → 5M fallback**,
  then graceful "server unreachable" (never silently play a weak move).
- **Network:** LAN-first via Traefik on `debian-server`. No public exposure.
- **Backend:** Go HTTP API with a thin Python adapter around the pinned
  upstream `maia3` implementation. The adapter preserves the reference
  implementation's Elo conditioning, reconstructed history, MultiPV, WDL,
  and policy output. CPU first; GTX 1650 SUPER (4GB, idle) is backup.
- **Packaging:** single container (static page + API), Komodo stack once it
  works. Never raw `docker` lifecycle for managed services.

## API contract (v1)

`POST /move { fen, moves[], elo_maia, elo_user, model, maia_color, initial_fen? }`
→ `{ move, top_moves[{move, prob}], wdl[loss, draw, win], model_used, degraded }`

- `fen` is the normalized current position. `moves[]` are UCI moves from
  `initial_fen` to `fen`; `initial_fen` defaults to standard startpos.
  Maia3 plays more human with reconstructed history
  (`--use-uci-history`) — always send it. The backend rejects a replay that
  does not produce `fen`.
- `maia_color` is `white` or `black`. The endpoint only predicts when that
  color is on move; otherwise it returns `not_maia_turn` without inference.
- Elo mapping on an accepted request: Maia rating → SelfElo, user rating →
  OppoElo.
- Analysis shows everything; play just plays `move`, optionally revealing
  alternatives as a "what was Maia thinking" panel.

## v1 scope

In: play at set Elo (new/takeback/flip/play-as-black), analysis (FEN+PGN
load, step-through, top-k + WDL), PGN export, games in `localStorage`.
Out: clocks, accounts/sync, Stockfish second engine (same seam later),
public URL.

## Spike plan (next)

1. Container on `debian-server`: `maia3-79m` + `maia3-5m` cached, `/move`
   endpoint, CPU. Time single-move latency locally; measure the phone-over-LAN
   path after the Traefik route exists.
2. If snappy → build static UI in same container.
3. Then Komodo-ize (`maia-board/maia-board-komodo.toml` style) + Traefik route.

## Analysis persistence (2026-09-11)

Per-position results live in the `evaluations` cache; whole-line completion
lives in `analyses`, keyed by line content (normalized FEN + UCI moves), not
game id — pasted PGNs share records, deleting a game orphans nothing. Only
clean main-line batches record (no failures, no degraded Maia answers, no
explored branches). The loaded line snapshot (`maia-board.analysis-snapshot.v1`)
restores the analysis board across refresh; History badges compare records
against current analysis settings. Restore is click-gated so evicted cache
rows can never trigger automatic inference storms.

## Notes

- Licenses: Maia3 AGPL-3.0, keep any fork public from day one.
- Phone WASM (current platform behavior) is the offline fallback at most —
  not the primary path.
- **Stockfish:** later engine, outside v1.
