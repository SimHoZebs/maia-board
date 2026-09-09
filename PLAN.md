# maia-board — self-hosted Maia3 play + analysis

Minimal alternative to `maia-platform-frontend`: just play-vs-Maia and an
analysis board, with inference on the home cluster instead of phone WASM.

## Decisions (from ideation thread, 2026-09-09)

- **Modes:** play vs computer + analysis board. No training/drills/openings.
- **Frontend:** own minimal static page (no fork of the platform frontend).
  `chessground` (board) + `chess.js` (rules/PGN) + `fetch` to our API.
  Keep upstream platform repo unmodified as design reference only.
- **Inference:** server-side. Chain per request: **79M → 5M fallback**,
  then graceful "server unreachable" (never silently play a weak move).
- **Network:** LAN-first via Traefik on `debian-server`. No public exposure.
- **Backend:** spike Python + official `maia3` PyPI package (reference impl,
  Elo conditioning + MultiPV as upstream intends). CPU first; GTX 1650
  SUPER (4GB, idle) is backup. Node + `maia3-js` is the fallback option
  if torch proves heavy.
- **Packaging:** single container (static page + API), Komodo stack once it
  works. Never raw `docker` lifecycle for managed services.

## API contract (v1)

`POST /move { fen, moves[], elo_maia, elo_user, model }`
→ `{ move, top_moves[{move, prob}], wdl[loss, draw, win] }`

- `moves[]` = full move stack (UCI history). Maia3 plays more human with
  reconstructed history (`--use-uci-history` equivalent) — always send it.
- Elo mapping: Maia rating → SelfElo side-to-move, user rating → OppoElo.
- Analysis shows everything; play just plays `move`, optionally revealing
  alternatives as a "what was Maia thinking" panel.

## v1 scope

In: play at set Elo (new/takeback/flip/play-as-black), analysis (FEN+PGN
load, step-through, top-k + WDL), PGN export, games in `localStorage`.
Out: clocks, accounts/sync, Stockfish second engine (same seam later),
public URL.

## Spike plan (next)

1. Container on `debian-server`: `maia3-79m` + `maia3-5m` cached, `/move`
   endpoint, CPU. Time single-move latency from phone over LAN.
2. If snappy → build static UI in same container.
3. Then Komodo-ize (`maia-board/maia-board-komodo.toml` style) + Traefik route.

## Notes

- Licenses: Maia3 AGPL-3.0, keep any fork public from day one.
- Phone WASM (current platform behavior) is the offline fallback at most —
  not the primary path.
- Open question for user: server-side Stockfish in v1 or later.
