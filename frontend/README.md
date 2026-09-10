# Maia Board frontend

The frontend is a Vite-built static page. It uses `chess.js` for legal moves,
PGN handling, and FEN timelines, and `chessground` for board rendering. Settings,
the current game, recent games, and the last analysis inputs are stored in the
browser's local storage.

## Local checks

```sh
npm ci
npm test
npm run build
```

The production container is built from the repository root so the Dockerfile
can access both `frontend/` and `backend/`:

```sh
docker build -f backend/Dockerfile .
```

The Go server serves the resulting `dist` directory at `/app/static`. Set
`STATIC_DIR` to use another path. `/move` and `/healthz` remain API routes.
