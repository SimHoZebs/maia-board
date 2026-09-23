#!/bin/sh
# e2e.sh <spec> [playwright args...] — build dist-browser, preview :4173, test, tear down.
# Fixture suites mock the API and read dist-browser directly; preview serves
# manual observation and server-backed specs.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=4173
[ $# -ge 1 ] || { echo "Usage: scripts/e2e.sh <spec> [-g filter] [playwright args...]" >&2; exit 2; }
case "$1" in -h|--help) echo "Usage: scripts/e2e.sh <spec> [-g filter] [playwright args...]"; exit 0 ;; esac
SPEC="$1"; shift
cd "$ROOT/frontend"
MAIA_BUILD_DIR=dist-browser npm run build:bundle
if command -v fuser >/dev/null 2>&1; then fuser -k "$PORT/tcp" >/dev/null 2>&1 || true
elif command -v lsof >/dev/null 2>&1; then lsof -ti "tcp:$PORT" | xargs -r kill >/dev/null 2>&1 || true; fi
mkdir -p test-results
LOG="$ROOT/frontend/test-results/e2e-preview.log"
MAIA_BUILD_DIR=dist-browser npx vite preview --port "$PORT" --outDir dist-browser >"$LOG" 2>&1 &
PREVIEW=$!
trap 'kill "$PREVIEW" 2>/dev/null || true' EXIT INT TERM
if command -v curl >/dev/null 2>&1; then
  i=0; while [ "$i" -lt 50 ]; do
    curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break
    i=$((i + 1)); sleep 0.2
  done
else sleep 3; fi
echo "preview: http://127.0.0.1:$PORT/ ($LOG)"
npx playwright test "$SPEC" "$@"
