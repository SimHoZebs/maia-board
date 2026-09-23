#!/usr/bin/env bash
# verify.sh — frontend typecheck + vitest, backend go vet + go test.
# Usage: verify.sh [--frontend-only] [--backend-only] [--file <vitest-path>] [--help]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FE=1; BE=1; FILE="src"
while [ $# -gt 0 ]; do
  case "$1" in
    --frontend-only) BE=0 ;;
    --backend-only) FE=0 ;;
    --file) FILE="${2:?--file needs a path}"; shift ;;
    -h|--help) echo "Usage: scripts/verify.sh [--frontend-only] [--backend-only] [--file <vitest-path>]"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done
FE_FAIL=0; BE_FAIL=0
if [ "$FE" -eq 1 ]; then
  echo "### frontend: typecheck"
  (cd "$ROOT/frontend" && npm run typecheck) || FE_FAIL=1
  echo "### frontend: vitest ($FILE)"
  (cd "$ROOT/frontend" && npx vitest run "$FILE") || FE_FAIL=1
fi
if [ "$BE" -eq 1 ]; then
  echo "### backend: go vet"
  (cd "$ROOT/backend" && CGO_ENABLED=0 go vet ./...) || BE_FAIL=1
  echo "### backend: go test"
  (cd "$ROOT/backend" && CGO_ENABLED=0 go test ./...) || BE_FAIL=1
fi
echo; echo "=== summary ==="
[ "$FE" -eq 1 ] && { [ "$FE_FAIL" -eq 0 ] && echo "frontend: PASS" || echo "frontend: FAIL"; }
[ "$BE" -eq 1 ] && { [ "$BE_FAIL" -eq 0 ] && echo "backend:  PASS" || echo "backend:  FAIL"; }
[ "$FE_FAIL" -eq 0 ] && [ "$BE_FAIL" -eq 0 ]
