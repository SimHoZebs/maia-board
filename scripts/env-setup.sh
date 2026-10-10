#!/bin/sh
# env-setup.sh — idempotent host setup: Stockfish binary and Python venv.
# Skips whatever already exists; prints versions of what it leaves behind.
# Caches live outside tracked source, so reruns never dirty the repo.
# Overrides: STOCKFISH_BINARY (binary path), MAIA_VENV (venv path).
set -eu
# Repo root, so the script works from any cwd.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${MAIA_VENV:-$HOME/.venvs/maia-board}"
SF="${STOCKFISH_BINARY:-$ROOT/backend/bin/stockfish}"
# Scratch dir for the Stockfish source download; always removed on exit,
# including failures partway through the build.
T=""
trap 'rm -rf "$T"' EXIT
have() { command -v "$1" >/dev/null 2>&1; }

echo "### stockfish ($SF)"
if [ -x "$SF" ]; then echo "cached: $SF"
# Prefer an existing binary: a previous run, or a system install on PATH.
elif have stockfish; then SF="$(command -v stockfish)"; echo "PATH: $SF"
# Otherwise compile the pinned Stockfish 19 from source. Needs a compiler,
# make, and curl; without them, print what to install instead of failing.
elif have make && have g++ && have curl; then
  echo "building Stockfish 19 ..."
  mkdir -p "$(dirname "$SF")"
  T="$(mktemp -d)"
  curl -fL --retry 3 https://github.com/official-stockfish/Stockfish/archive/refs/tags/sf_19.tar.gz -o "$T/src.tar.gz"
  tar -xzf "$T/src.tar.gz" -C "$T"
  (cd "$T/Stockfish-sf_19/src" && make -j "$(nproc)" build ARCH=x86-64)
  cp "$T/Stockfish-sf_19/src/stockfish" "$SF"
else echo "missing: install g++ + make + curl, or set STOCKFISH_BINARY (see backend/Dockerfile)"; fi
# Sanity check: a working binary answers UCI with its id line. `|| true`
# keeps a broken binary from failing the whole script under `set -e`.
if [ -x "$SF" ]; then printf 'uci\nquit\n' | "$SF" 2>/dev/null | grep 'id name' || true; fi

echo "### python venv ($VENV)"
if have python3; then
  python3 --version
  if [ -x "$VENV/bin/python" ]; then echo "cached: $VENV"
  else
    # Fresh venv: worker runtime deps, then the pinned chess libs the
    # mocked worker tests import.
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -r "$ROOT/backend/workers/requirements.txt"
    "$VENV/bin/pip" install "python-chess==1.999" "chess==1.11.2"
  fi
  # Sanity check: the venv interpreter sees python-chess.
  "$VENV/bin/python" -c "import chess; print('python-chess', chess.__version__)"
else echo "missing: install Python 3.12 with venv support, then rerun"; fi
