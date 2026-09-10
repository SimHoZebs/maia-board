"""One request, one owned engine. No Maia imports or persistent state."""
import argparse
import json
import sys

import chess
import chess.engine

SEARCH_POLICY = "sf19-n100k-ms750-mpv2-t1-h64-v1"


class InvalidRequest(Exception):
    def __init__(self, code):
        self.code = code


def reconstruct(request):
    try:
        board = chess.Board(request.get("initial_fen") or chess.STARTING_FEN)
        expected = chess.Board(request["fen"])
    except ValueError as error:
        raise InvalidRequest("invalid_fen") from error
    if not board.is_valid() or not expected.is_valid():
        raise InvalidRequest("invalid_position")
    try:
        for move in request.get("moves") or []:
            board.push_uci(move)
    except ValueError as error:
        raise InvalidRequest("invalid_position") from error
    if not board.is_valid():
        raise InvalidRequest("invalid_position")
    # Legal en-passant normalization matches chess.js FEN generation.
    if board.fen() != expected.fen():
        raise InvalidRequest("position_mismatch")
    return board


def white_score(score):
    score = score.pov(chess.WHITE)
    if score.is_mate():
        value = score.mate()
        winner = "white" if score > chess.engine.Cp(0) else "black"
        return {"type": "mate", "value": value, "winning_side": winner}
    return {"type": "cp", "value": score.score()}


def evaluate(request, binary):
    board = reconstruct(request)
    result = dict(engine="Stockfish 19", search_policy=SEARCH_POLICY, depth=0,
                  terminal=None, best_move=None, score={"type": "cp", "value": 0}, lines=[])
    # chess.js ends on an existing threefold repetition / 100-halfmove clock,
    # rather than a draw that could be claimed by making the next move.
    outcome = board.outcome(claim_draw=False)
    if outcome is None and (board.is_repetition(3) or board.is_fifty_moves()):
        result["terminal"] = "draw"
        return result
    if outcome is not None:
        if outcome.winner is None:
            result["terminal"] = "draw"
        else:
            winner = "white" if outcome.winner else "black"
            result["terminal"] = winner + "_win"
            result["score"] = {"type": "mate", "value": 0, "winning_side": winner}
        return result
    # Go establishes the process group; inheriting it is essential for cancellation.
    engine = chess.engine.SimpleEngine.popen_uci(binary, setpgrp=False)
    try:
        if engine.id.get("name") != "Stockfish 19":
            raise RuntimeError("unexpected engine version")
        engine.configure({"Threads": 1, "Hash": 64})
        count = min(2, board.legal_moves.count())
        iterations = {}
        # Consume individual UCI reports: analyse() merges reports and can retain
        # an earlier bound flag even after a later exact score arrives.
        with engine.analysis(board, chess.engine.Limit(nodes=100000, time=0.75), multipv=2) as analysis:
            for info in analysis:
                if info.get("lowerbound") or info.get("upperbound"):
                    continue
                if not info.get("pv") or "score" not in info or "depth" not in info:
                    continue
                rank = info.get("multipv", 1)
                if 1 <= rank <= count:
                    iterations.setdefault(info["depth"], {})[rank] = dict(
                        move=info["pv"][0].uci(), score=white_score(info["score"]), depth=info["depth"])
        complete = [depth for depth, lines in iterations.items() if len(lines) == count]
        if not complete:
            raise RuntimeError("no complete exact engine result")
        lines = iterations[max(complete)]
        result["lines"] = [lines[rank] for rank in range(1, count + 1)]
        result.update(best_move=result["lines"][0]["move"], score=result["lines"][0]["score"],
                      depth=min(line["depth"] for line in result["lines"]))
        return result
    finally:
        try:
            engine.quit()
        finally:
            engine.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    args = parser.parse_args()
    try:
        result = evaluate(json.load(sys.stdin), args.binary)
    except InvalidRequest as error:
        result = {"code": error.code, "message": "position or move history is invalid"}
    except Exception:
        result = {"code": "engine_unavailable", "message": "Stockfish evaluation is unavailable"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
