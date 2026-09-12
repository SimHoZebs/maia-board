"""One request, one owned engine. No Maia imports or persistent state."""
import argparse
import json
import sys
import time

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


def report_timing(request, policy, multipv, started, spawn_ms, search_ms, depth, count):
    # One stderr line per request (stdout stays pure JSON for the Go wrapper).
    # Go inherits this into the server log, so each backend `evaluate ...`
    # line pairs with a worker line splitting total into process spawn vs
    # actual search: spawn-dominated cost points at fork/exec pressure,
    # search-dominated cost points at the time_ms/lines/depth budget.
    # plies is the in-game position index, the x-axis for second-half cliffs.
    plies = len(request.get("moves") or [])
    total_ms = round((time.monotonic() - started) * 1000)
    print(f"stockfish_timing outcome=ok policy={policy} multipv={multipv} plies={plies} "
          f"total_ms={total_ms} spawn_ms={spawn_ms} search_ms={search_ms} "
          f"depth={depth} lines={count}", file=sys.stderr, flush=True)


def evaluate(request, binary):
    started = time.monotonic()
    board = reconstruct(request)
    settings = request.get("settings")
    if settings is None:
        policy, multipv = SEARCH_POLICY, 2
        limit = chess.engine.Limit(nodes=100000, time=0.75)
    else:
        time_ms, multipv, depth = settings.get("time_ms"), settings.get("lines"), settings.get("depth", 0)
        if not all(type(value) is int for value in (time_ms, multipv, depth)) or not (250 <= time_ms <= 30000 and 1 <= multipv <= 5 and 0 <= depth <= 40):
            raise InvalidRequest("invalid_request")
        policy = f"sf19-ms{time_ms}-mpv{multipv}-d{depth}-t1-h64-v2"
        limit = chess.engine.Limit(time=time_ms / 1000, depth=depth or None)
    result = dict(engine="Stockfish 19", search_policy=policy, depth=0,
                  terminal=None, best_move=None, score={"type": "cp", "value": 0}, lines=[])
    # chess.js ends on an existing threefold repetition / 100-halfmove clock,
    # rather than a draw that could be claimed by making the next move.
    outcome = board.outcome(claim_draw=False)
    if outcome is None and (board.is_repetition(3) or board.is_fifty_moves()):
        result["terminal"] = "draw"
        report_timing(request, policy, multipv, started, 0, 0, 0, 0)
        return result
    if outcome is not None:
        if outcome.winner is None:
            result["terminal"] = "draw"
        else:
            winner = "white" if outcome.winner else "black"
            result["terminal"] = winner + "_win"
            result["score"] = {"type": "mate", "value": 0, "winning_side": winner}
        report_timing(request, policy, multipv, started, 0, 0, 0, 0)
        return result
    # Go establishes the process group; inheriting it is essential for cancellation.
    spawn_started = time.monotonic()
    engine = chess.engine.SimpleEngine.popen_uci(binary, setpgrp=False)
    try:
        if engine.id.get("name") != "Stockfish 19":
            raise RuntimeError("unexpected engine version")
        engine.configure({"Threads": 1, "Hash": 64})
        spawn_ms = round((time.monotonic() - spawn_started) * 1000)
        count = min(multipv, board.legal_moves.count())
        iterations = {}
        # Consume individual UCI reports: analyse() merges reports and can retain
        # an earlier bound flag even after a later exact score arrives.
        search_started = time.monotonic()
        with engine.analysis(board, limit, multipv=multipv) as analysis:
            for info in analysis:
                if info.get("lowerbound") or info.get("upperbound"):
                    continue
                if not info.get("pv") or "score" not in info or "depth" not in info:
                    continue
                rank = info.get("multipv", 1)
                if 1 <= rank <= count:
                    iterations.setdefault(info["depth"], {})[rank] = dict(
                        move=info["pv"][0].uci(), score=white_score(info["score"]), depth=info["depth"])
        search_ms = round((time.monotonic() - search_started) * 1000)
        complete = [depth for depth, lines in iterations.items() if len(lines) == count]
        if not complete:
            raise RuntimeError("no complete exact engine result")
        lines = iterations[max(complete)]
        result["lines"] = [lines[rank] for rank in range(1, count + 1)]
        result.update(best_move=result["lines"][0]["move"], score=result["lines"][0]["score"],
                      depth=min(line["depth"] for line in result["lines"]))
        report_timing(request, policy, multipv, started, spawn_ms, search_ms, result["depth"], count)
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
    started = time.monotonic()
    try:
        result = evaluate(json.load(sys.stdin), args.binary)
    except InvalidRequest as error:
        result = {"code": error.code, "message": "position or move history is invalid"}
    except Exception:
        total_ms = round((time.monotonic() - started) * 1000)
        print(f"stockfish_timing outcome=error total_ms={total_ms}", file=sys.stderr, flush=True)
        result = {"code": "engine_unavailable", "message": "Stockfish evaluation is unavailable"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
