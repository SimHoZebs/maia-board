#!/bin/sh
# backend-perf.sh [--seed a,b] [--plies x,y] [--maia-ms n] — run the
# mock-engine backend perf harness (backend/perf_mock_test.go) over the
# PERF_SEED/PERF_PLIES matrix and print a table. No weights, GPU, or
# Python needed: inference is stubbed to a fixed PERF_MAIA_MS sleep and
# hits measure the real SQLite read path.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SEEDS="1"; PLIES="40"; MAIA_MS="5"
while [ $# -gt 0 ]; do
  case "$1" in
    --seed) SEEDS="$2"; shift ;;
    --plies) PLIES="$2"; shift ;;
    --maia-ms) MAIA_MS="$2"; shift ;;
    -h|--help) echo "Usage: scripts/backend-perf.sh [--seed a,b] [--plies x,y] [--maia-ms n]"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
mkdir -p "$ROOT/test-results"
CODE=0
echo "| seed | plies | result | time | log |"
echo "|------|-------|--------|------|-----|"
for s in $(echo "$SEEDS" | tr ',' ' '); do
  for p in $(echo "$PLIES" | tr ',' ' '); do
    T0=$(date +%s)
    LOG="$ROOT/test-results/backend-perf-s${s}-p${p}.log"
    OUT="$ROOT/test-results/backend-perf-s${s}-p${p}.json"
    if PERF_MODE=mock PERF_SEED="$s" PERF_PLIES="$p" PERF_MAIA_MS="$MAIA_MS" PERF_OUT="$OUT" \
        sh -c "cd \"$ROOT/backend\" && CGO_ENABLED=0 go test -run TestBackendPerfMock -v ." >"$LOG" 2>&1; then
      R=pass
    else
      R=FAIL; CODE=1
    fi
    echo "| $s | $p | $R | $(( $(date +%s) - T0 ))s | $LOG |"
  done
done
exit "$CODE"
