#!/bin/sh
# env-setup.sh — idempotent bootstrap: stockfish, python venv, JRE + tla2tools.jar.
# Caches outside tracked source; skips what exists; prints versions.
# Overrides: STOCKFISH_BINARY, MAIA_VENV, TLA2TOOLS_JAR.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENV="${MAIA_VENV:-$HOME/.venvs/maia-board}"
SF="${STOCKFISH_BINARY:-$ROOT/backend/bin/stockfish}"
TLAJAR="${TLA2TOOLS_JAR:-$HOME/.cache/maia-board/tla2tools.jar}"
TLA_VER="1.7.1"
T=""
trap 'rm -rf "$T"' EXIT
have() { command -v "$1" >/dev/null 2>&1; }

echo "### stockfish ($SF)"
if [ -x "$SF" ]; then echo "cached: $SF"
elif have stockfish; then SF="$(command -v stockfish)"; echo "PATH: $SF"
elif have make && have g++ && have curl; then
  echo "building Stockfish 19 ..."
  mkdir -p "$(dirname "$SF")"
  T="$(mktemp -d)"
  curl -fL --retry 3 https://github.com/official-stockfish/Stockfish/archive/refs/tags/sf_19.tar.gz -o "$T/src.tar.gz"
  tar -xzf "$T/src.tar.gz" -C "$T"
  (cd "$T/Stockfish-sf_19/src" && make -j "$(nproc)" build ARCH=x86-64)
  cp "$T/Stockfish-sf_19/src/stockfish" "$SF"
else echo "missing: install g++ + make + curl, or set STOCKFISH_BINARY (see backend/Dockerfile)"; fi
if [ -x "$SF" ]; then printf 'uci\nquit\n' | "$SF" 2>/dev/null | grep 'id name' || true; fi

echo "### python venv ($VENV)"
if have python3; then
  python3 --version
  if [ -x "$VENV/bin/python" ]; then echo "cached: $VENV"
  else
    python3 -m venv "$VENV"
    "$VENV/bin/pip" install -r "$ROOT/backend/requirements.txt"
    "$VENV/bin/pip" install "python-chess==1.999" "chess==1.11.2"
  fi
  "$VENV/bin/python" -c "import chess; print('python-chess', chess.__version__)"
else echo "missing: install Python 3.12 with venv support, then rerun"; fi

echo "### java + tla2tools ($TLAJAR)"
if have java; then java -version 2>&1 | head -1
else echo "missing: install a JRE (e.g. apt install default-jre), then rerun"; fi
if [ -f "$TLAJAR" ]; then echo "cached: $TLAJAR"
elif have curl; then
  mkdir -p "$(dirname "$TLAJAR")"
  curl -fL --retry 3 "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VER/tla2tools.jar" -o "$TLAJAR"
  echo "downloaded: $TLAJAR"
else echo "missing: install curl, or fetch tla2tools.jar v$TLA_VER into $TLAJAR"; fi
