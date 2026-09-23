#!/bin/sh
# serve.sh [--port N] [--dir D] [--tunnel] — preview an existing build, print URL.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=4173; DIR="${MAIA_BUILD_DIR:-dist}"; TUNNEL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift ;;
    --dir) DIR="$2"; shift ;;
    --tunnel) TUNNEL=1 ;;
    -h|--help) echo "Usage: scripts/serve.sh [--port N] [--dir D] [--tunnel]"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
tunnel_note() {
  [ "$TUNNEL" -eq 0 ] && return 0
  if command -v cloudflared >/dev/null 2>&1; then
    echo "tunnel: cloudflared tunnel --url http://127.0.0.1:$PORT"
  else
    echo "tunnel: install cloudflared, then: cloudflared tunnel --url http://127.0.0.1:$PORT"
  fi
}
if command -v curl >/dev/null 2>&1 && curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  echo "already up: http://127.0.0.1:$PORT/"
  tunnel_note; exit 0
fi
cd "$ROOT/frontend"
[ -d "$DIR" ] || { echo "missing build dir $DIR; run: MAIA_BUILD_DIR=$DIR npm run build:bundle" >&2; exit 1; }
mkdir -p test-results
LOG="$ROOT/frontend/test-results/preview.log"
npx vite preview --port "$PORT" --outDir "$DIR" >"$LOG" 2>&1 &
PREVIEW=$!
trap 'kill "$PREVIEW" 2>/dev/null || true' EXIT INT TERM
if command -v curl >/dev/null 2>&1; then
  i=0; while [ "$i" -lt 50 ]; do
    curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
    i=$((i + 1)); sleep 0.2
  done
else sleep 3; fi
echo "serving $DIR at http://127.0.0.1:$PORT/ ($LOG)"
tunnel_note
wait "$PREVIEW"
