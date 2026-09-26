#!/usr/bin/env python3
"""gen-perf-line.py -- deterministic perf line generator.

Emits one JSON document with a seeded random legal UCI line plus the FEN
after every prefix (including the root), so Go and TypeScript harnesses
share a single line source:

  python3 scripts/gen-perf-line.py --seed 1 --plies 40

Output: {"seed":1,"initial_fen":"...","moves":[...],"fens":[...]} where
fens[i] is the position after moves[:i] (fens[0] is the startpos).

PRNG mirrors frontend/tests/perf/client-sim.spec.ts mulberry32 so a seed
deals the same line in both harnesses. Chess truth comes from python-chess.
"""
import argparse
import json
import sys

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def mulberry32(seed):
    state = seed & 0xFFFFFFFF

    def rand():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = (state ^ (state >> 15)) & 0xFFFFFFFF
        t = (t * (1 | state)) & 0xFFFFFFFF
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & 0xFFFFFFFF)) ^ t) & 0xFFFFFFFF
        t = (t ^ (t >> 14)) & 0xFFFFFFFF
        return t / 4294967296

    return rand


def main():
    parser = argparse.ArgumentParser(description="Generate a seeded perf line.")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--plies", type=int, default=40)
    args = parser.parse_args()
    try:
        import chess
    except ImportError:
        print("python-chess is required (pip install python-chess==1.999)", file=sys.stderr)
        return 2
    plies = max(0, min(args.plies, 256))
    rng = mulberry32(args.seed)
    board = chess.Board()
    moves = []
    fens = [board.fen()]
    while len(moves) < plies and not board.is_game_over():
        legal = list(board.legal_moves)
        pick = legal[int(rng() * len(legal))]
        moves.append(pick.uci())
        board.push(pick)
        fens.append(board.fen())
    print(json.dumps({"seed": args.seed, "initial_fen": START_FEN,
                       "moves": moves, "fens": fens}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
