"""Small UCI adapter around the pinned upstream Maia3 engine.

The upstream UCI implementation computes policy probabilities but only prints
WDL/PV data. This adapter preserves its command handling and adds one
machine-readable ``string policy`` value per MultiPV rank.
"""

from __future__ import annotations

import sys

import chess

from maia3.uci import Maia3UCIEngine, parse_args


def option_name_value(line: str) -> tuple[str, str]:
    if "name" not in line:
        raise ValueError("setoption command has no name")
    after_name = line.split("name", 1)[1].strip()
    name, _, value = after_name.partition("value")
    return name.strip().lower(), value.strip()


def parse_position(line: str) -> chess.Board:
    tokens = line.split()
    if len(tokens) < 2:
        raise ValueError("position command is incomplete")

    index = 1
    if tokens[index] == "startpos":
        board = chess.Board()
        index += 1
    elif tokens[index] == "fen":
        if len(tokens) < index + 7:
            raise ValueError("FEN position is incomplete")
        board = chess.Board(" ".join(tokens[index + 1 : index + 7]))
        index += 7
    else:
        raise ValueError("position must use startpos or fen")

    if index < len(tokens):
        if tokens[index] != "moves":
            raise ValueError("position has unexpected trailing data")
        for move_text in tokens[index + 1 :]:
            move = chess.Move.from_uci(move_text)
            if move not in board.legal_moves:
                raise ValueError(f"illegal move {move_text}")
            board.push(move)
    return board


def emit_position_result(board: chess.Board, expected_fen: str | None) -> None:
    if expected_fen is not None:
        try:
            expected = chess.Board(expected_fen).fen()
        except ValueError:
            print("info string position-error invalid-position", flush=True)
            return
        if board.fen() != expected:
            print("info string position-error position-mismatch", flush=True)
            return
    print(
        f"info string position-ok legal-count {board.legal_moves.count()}",
        flush=True,
    )


def emit_move(engine: Maia3UCIEngine) -> None:
    move, top_moves = engine.score_moves()
    for rank, item in enumerate(top_moves, start=1):
        win, draw, loss = item["wdl"]
        print(
            "info depth 1 "
            f"multipv {rank} score cp {win - loss} "
            f"wdl {win} {draw} {loss} "
            f"pv {item['move'].uci()} string policy {item['policy']:.9f}",
            flush=True,
        )
    print(f"bestmove {move.uci() if move is not None else '0000'}", flush=True)


def main() -> None:
    config = parse_args(sys.argv[1:])
    engine = Maia3UCIEngine(config)
    expected_fen: str | None = None

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            if line == "uci":
                engine.cmd_uci()
            elif line == "isready":
                try:
                    engine.ensure_model_loaded()
                except Exception as error:
                    print(f"maia3 worker error: {error}", file=sys.stderr, flush=True)
                    return
                print("readyok", flush=True)
            elif line.startswith("setoption "):
                name, value = option_name_value(line)
                if name == "expectedfen":
                    expected_fen = value
                else:
                    engine.cmd_setoption(line)
            elif line.startswith("position "):
                try:
                    board = parse_position(line)
                    engine.cmd_position(line)
                except (ValueError, RuntimeError) as error:
                    print("info string position-error invalid-position", flush=True)
                    print(f"maia3 worker error: {error}", file=sys.stderr, flush=True)
                    continue
                emit_position_result(board, expected_fen)
            elif line.startswith("go ") or line == "go":
                try:
                    emit_move(engine)
                except Exception as error:
                    print("info string go-error", flush=True)
                    print(f"maia3 worker error: {error}", file=sys.stderr, flush=True)
            elif line == "ucinewgame":
                engine.cmd_ucinewgame()
            elif line == "quit":
                return
        except (ValueError, RuntimeError) as error:
            print(f"info string adapter-error {type(error).__name__}", flush=True)
            print(f"maia3 worker error: {error}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
