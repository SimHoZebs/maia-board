#!/usr/bin/env bash
# check-spacing.sh — spacing-ownership guard: inter-child spacing belongs to
# parents (gap/padding), not children (margin-top/bottom). Fails on any CSS
# margin that is not on the allowlist below.
# Usage: scripts/check-spacing.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/frontend"

# Allowlisted margin usages (alignment, centering, width compensation, a11y
# clip, inline-icon gaps, documented composites, global type fallback):
# - margin: 0 (reset) | margin-left:auto (flex push) | horizontal auto (centering)
# - board-frame margin-right:18px | source-dot margin-right | temp-pill margin-left
# - segmented input margin:-1px (a11y clip) | toggle-card input margin-top:2px (box alignment)
# - mobile-footer nav margin-top:0 (separate mount outside .notation)
# - engine-duo + review-overview margin:8px composite (12px gap + 8px = 20px preserved)
# - global h1,h2,h3,p margin:0 0 16px fallback | body margin:0
# - generation-settings margin:0 0 0 auto (flex push) | game-over margin-left:0 (grid reset)
ALLOW='margin: 0;|margin: 0 auto|margin: [0-9]+px auto|margin: auto|margin: 12px 0|margin-left: auto|margin-left: 0|margin-right: 18px|margin-right: 8px|margin-left: 8px|margin: -1px|margin-top: 0|margin-top: 2px|margin: 0 0 0 auto|margin: 8px 0 0|margin: 0 0 16px|body \{ margin: 0'

ALL=$(rg -n "margin" src/*.css || true)
VIOLATIONS=$(printf '%s\n' "$ALL" | grep -vE "$ALLOW" || true)
# Drop pure-comment lines (/* ... margin ... */) — they document, not style.
VIOLATIONS=$(printf '%s' "$VIOLATIONS" | grep -v '^\s*//' | grep -v '/\*' || true)

if [ -n "$VIOLATIONS" ]; then
  echo "spacing-ownership violations (child-owned outer margins):"
  printf '%s\n' "$VIOLATIONS"
  echo "Fix: move spacing to the parent (gap/padding) and zero the child margin,"
  echo "or add the usage to the allowlist in scripts/check-spacing.sh with a reason."
  exit 1
fi
echo "spacing-ownership: PASS"
