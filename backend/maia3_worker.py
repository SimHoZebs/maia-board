"""Bounded JSON-lines transport for Maia3 ref 1e13597c42d4858b7cfd7cfdae01e297263364b2."""
from __future__ import annotations

import contextlib
import json
import math
import sys
import time

import chess

MAX_LINE = 64 * 1024


class InvalidRequest(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def position(request):
    """Validate semantics before upstream cmd_position (which silently rejects)."""
    try:
        fen = request["fen"]
        moves = request.get("moves") or []
        initial = request.get("initial_fen") or (chess.STARTING_FEN if moves else fen)
        if not isinstance(moves, list) or len(moves) > 256:
            raise ValueError("moves must contain at most 256 plies")
        expected, board = chess.Board(fen), chess.Board(initial)
        if not expected.is_valid() or not board.is_valid():
            raise ValueError("invalid board")
        for text in moves:
            move = chess.Move.from_uci(text)
            if move not in board.legal_moves:
                raise ValueError("illegal move")
            board.push(move)
        if board.fen() != expected.fen():
            raise InvalidRequest("position_mismatch", "moves do not produce fen")
        if not board.is_valid():
            raise ValueError("invalid reconstructed board")
        command = "position fen " + initial
        if moves:
            command += " moves " + " ".join(moves)
        return board, command
    except InvalidRequest:
        raise
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        raise InvalidRequest("invalid_position", "position or history is invalid") from error


def predict(engine, request):
    if not isinstance(request, dict) or set(request) - {"fen", "moves", "initial_fen", "self_elo", "oppo_elo", "temperature"}:
        raise InvalidRequest("invalid_position", "invalid request shape")
    board, command = position(request)
    for key in ("self_elo", "oppo_elo"):
        value = request.get(key)
        if type(value) is not int or not 0 <= value <= 5000:
            raise InvalidRequest("invalid_position", "invalid Elo")
    temperature = request.get("temperature", 0)
    if type(temperature) not in (int, float) or not math.isfinite(temperature) or not 0 <= temperature <= 2:
        raise InvalidRequest("invalid_position", "invalid temperature")
    if board.is_game_over():
        raise InvalidRequest("game_over", "position has no playable moves")
    # Preserve the pinned engine's option parsing and full history rebuilding.
    engine.cmd_setoption(f"setoption name SelfElo value {request['self_elo']}")
    engine.cmd_setoption(f"setoption name OppoElo value {request['oppo_elo']}")
    engine.cmd_setoption("setoption name MultiPV value 5")
    engine.cmd_setoption(f"setoption name Temperature value {temperature}")
    engine.cmd_position(command)
    move, top_moves = engine.score_moves()
    if move is None or move not in board.legal_moves:
        raise RuntimeError("engine returned invalid selected move")
    candidates = []
    seen, previous, total = set(), 1.0, 0.0
    for item in top_moves:
        candidate, policy = item["move"], float(item["policy"])
        win, draw, loss = item["wdl"]
        if candidate not in board.legal_moves or candidate in seen or not math.isfinite(policy) or not 0 <= policy <= previous + 1e-7:
            raise RuntimeError("engine returned invalid candidate")
        if any(type(v) is not int or not 0 <= v <= 1000 for v in (win, draw, loss)) or sum((win, draw, loss)) != 1000:
            raise RuntimeError("engine returned invalid WDL")
        seen.add(candidate)
        previous, total = policy, total + policy
        candidates.append({"move": candidate.uci(), "policy": policy, "wdl": [loss / 1000, draw / 1000, win / 1000]})
    if len(candidates) != min(5, board.legal_moves.count()) or total <= 0 or total > 1.000001:
        raise RuntimeError("engine returned incomplete or inconsistent candidates")
    if temperature == 0:
        selected_policy = next((item["policy"] for item in candidates if item["move"] == move.uci()), None)
        # torch.argmax and torch.topk can disagree on ordering of equal logits.
        admissible = (abs(selected_policy - candidates[0]["policy"]) <= 1e-7 if selected_policy is not None
                      else len(candidates) == 5 and abs(candidates[-1]["policy"] - candidates[0]["policy"]) <= 1e-7)
        if not admissible:
            raise RuntimeError("engine returned inconsistent deterministic selection")
    return {"result": {"move": move.uci(), "candidates": candidates, "wdl": candidates[0]["wdl"]}, "legal_count": board.legal_moves.count()}


def emit(value, output):
    encoded = json.dumps(value, allow_nan=False, separators=(",", ":"))
    if len(encoded.encode()) > MAX_LINE:
        raise RuntimeError("worker response too large")
    print(encoded, file=output, flush=True)


def serve(engine, source, output):
    emit({"ready": True}, output)
    while True:
        raw = source.readline(MAX_LINE + 1)
        if not raw:
            return
        if len(raw.encode()) > MAX_LINE or not raw.endswith("\n"):
            emit({"error": {"code": "engine_unavailable", "message": "request line exceeds limit"}}, output)
            return
        started = time.monotonic()
        try:
            with contextlib.redirect_stdout(sys.stderr):
                result = predict(engine, json.loads(raw))
        except InvalidRequest as error:
            result = {"error": {"code": error.code, "message": str(error)}}
        except Exception as error:
            print(f"maia worker error: {str(error)[:1024]}", file=sys.stderr, flush=True)
            result = {"error": {"code": "engine_unavailable", "message": "Maia inference failed"}}
        emit(result, output)
        print(f"maia inference duration_ms={(time.monotonic() - started) * 1000:.1f}", file=sys.stderr, flush=True)


def main():
    output = sys.stdout
    with contextlib.redirect_stdout(sys.stderr):
        from maia3.uci import Maia3UCIEngine, parse_args
        config = parse_args(sys.argv[1:])
        engine = Maia3UCIEngine(config)
        engine.ensure_model_loaded()
    serve(engine, sys.stdin, output)


if __name__ == "__main__":
    main()
