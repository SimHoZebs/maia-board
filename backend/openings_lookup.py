"""One-shot opening-book lookup. No engine, no persistent state.

Reads one JSON request from stdin, writes one JSON response to stdout:
  request:  {"initial_fen": "<fen>", "moves": ["e2e4", ...]}
  response: {"matches": [{"ply": 5, "eco": "C50", "name": "Italian Game"}], "book_flags": [true, ...]}
            or {"code": "<api error code>", "message": "..."} on invalid input.

matches holds every exact book hit along the line (ply 0 is the root and is
included when named); the client derives the viewed position's deepest
ancestor itself. book_flags[i] names the position after moves[i], mirroring
the old client-side lookup it replaces.

The book is defined from the standard start only: custom-start lines get
empty matches and all-false flags. A missing table degrades the same way
(header hidden, never an error) via "degraded": true.
"""

import argparse
import json
import os
import sys

import chess

TABLE_ENV = "OPENINGS_TABLE"
STANDARD_START_EPD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -"


class InvalidRequest(Exception):
    def __init__(self, code):
        self.code = code


def table_path(explicit=None):
    if explicit:
        return explicit
    if TABLE_ENV in os.environ:
        return os.environ[TABLE_ENV]
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "openings_table.json")


def load_table(path):
    try:
        with open(path, encoding="utf-8") as handle:
            document = json.load(handle)
    except (OSError, ValueError):
        return None
    positions = document.get("positions") if isinstance(document, dict) else None
    return positions if isinstance(positions, dict) else None


def epd_key(board):
    """FEN without move counters, en-passant square only when a capture is
    actually legal. Must stay identical to epdKey() in the table build script
    (frontend/scripts/build-openings-table.mjs)."""
    fields = board.fen().split(" ")
    ep = fields[3]
    if ep != "-" and not any(board.is_en_passant(move) for move in board.legal_moves):
        ep = "-"
    return f"{fields[0]} {fields[1]} {fields[2]} {ep}"


def lookup(request, table):
    moves = request.get("moves") or []
    if not isinstance(moves, list) or any(not isinstance(move, str) for move in moves):
        raise InvalidRequest("invalid_position")
    initial_fen = request.get("initial_fen") or chess.STARTING_FEN
    try:
        board = chess.Board(initial_fen)
    except ValueError as error:
        raise InvalidRequest("invalid_fen") from error
    if not board.is_valid():
        raise InvalidRequest("invalid_position")
    flags = []
    matches = []
    # The book is defined from the standard start only: custom-start lines
    # still replay (illegal moves reject) but never match.
    standard = table is not None and epd_key(board) == STANDARD_START_EPD
    if standard:
        hit = table.get(epd_key(board))
        if hit is not None:
            matches.append({"ply": 0, "eco": hit[0], "name": hit[1]})
    for index, move in enumerate(moves):
        try:
            board.push_uci(move)
        except ValueError as error:
            raise InvalidRequest("invalid_position") from error
        hit = table.get(epd_key(board)) if standard else None
        flags.append(hit is not None)
        if hit is not None:
            matches.append({"ply": index + 1, "eco": hit[0], "name": hit[1]})
    return {"matches": matches, "book_flags": flags}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--table", default=None)
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict):
            raise InvalidRequest("invalid_position")
        table = load_table(table_path(args.table))
        result = lookup(request, table)
        if table is None:
            result["degraded"] = True
    except InvalidRequest as error:
        result = {"code": error.code, "message": "position or move history is invalid"}
    except Exception:
        result = {"code": "openings_unavailable", "message": "Opening lookup is unavailable"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
