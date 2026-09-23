#!/bin/sh
# perf.sh [--seed a,b] [--plies x,y] — build dist-profiling once, run the
# PERF_SEED/PERF_PLIES matrix via playwright.perf.config.ts, print a table.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SEEDS="1"; PLIES="40"
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) SEEDS="$2"; shift ;;
    --plies) PLIES="$2"; shift ;;
    -h|--help) echo "Usage: scripts/perf.sh [--seed a,b] [--plies x,y]"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
cd "$ROOT/frontend"
MAIA_BUILD_DIR=dist-profiling npm run build:profiling
mkdir -p test-results
CODE=0
echo "| seed | plies | result | time | log |"
echo "|------|-------|--------|------|-----|"
for s in $(echo "$SEEDS" | tr ',' ' '); do
  for p in $(echo "$PLIES" | tr ',' ' '); do
    T0=$(date +%s)
    LOG="test-results/perf-s${s}-p${p}.log"
    if PERF_SEED="$s" PERF_PLIES="$p" MAIA_BUILD_DIR=dist-profiling \
        npx playwright test -c playwright.perf.config.ts >"$LOG" 2>&1; then
      R=pass
    else
      R=FAIL; CODE=1
    fi
    echo "| $s | $p | $R | $(( $(date +%s) - T0 ))s | $LOG |"
  done
done
exit "$CODE"
