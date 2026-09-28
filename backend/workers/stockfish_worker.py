"""Persistent or one-shot Stockfish lookup. No Maia imports.

One-shot (default): reads one JSON request from stdin, writes one JSON
response to stdout, exits. Persistent (--serve): emits {"ready": true},
then serves one JSON-lines lookup per stdin line with a warm interpreter
and a warm engine, so repeat requests skip interpreter startup,
python-chess import, and UCI spawn. A wedged helper is SIGKILLed as a
group by the Go side (same as one-shot cancellation); per-request engine
failures drop the engine and error that request, and the next request
respawns transparently."""

MAX_LINE = 64 * 1024
import argparse
import json
import sys
import time

import chess
import chess.engine

SEARCH_POLICY = "sf19-n100k-ms750-mpv2-t4-h128-v3"


class InvalidRequest(Exception):
    def __init__(self, code):
        self.code = code


def reconstruct(request):
    try:
        moves = request.get("moves") or []
        if not isinstance(moves, list) or len(moves) > 256:
            raise InvalidRequest("invalid_position")
        board = chess.Board(request.get("initial_fen") or (chess.STARTING_FEN if moves else request["fen"]))
        expected = chess.Board(request["fen"])
    except ValueError as error:
        raise InvalidRequest("invalid_fen") from error
    if not board.is_valid() or not expected.is_valid():
        raise InvalidRequest("invalid_position")
    try:
        for move in moves:
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


def spawn_engine(binary):
    """Spawn, version-check, and configure one engine. Only called with a
    fresh spawn: the warm path reuses the returned handle across requests
    (sequential analysis() calls are normal python-chess usage; the 128 MiB
    hash persists, which only affects speed, never validity)."""
    # Go establishes the process group; inheriting it is essential for cancellation.
    engine = chess.engine.SimpleEngine.popen_uci(binary, setpgrp=False)
    try:
        if engine.id.get("name") != "Stockfish 19":
            raise RuntimeError("unexpected engine version")
        # Fixed Threads=4 / Hash=128 for speed (policy v3). Fixed rather than
        # min(cpu,4) so cache identity stays deterministic across hosts; the Go
        # side splits interactive vs batch into two slots (max 2 x 4 threads).
        engine.configure({"Threads": 4, "Hash": 128})
    except Exception:
        drop_engine(engine)
        raise
    return engine


def drop_engine(engine):
    """Best-effort teardown; returns None so callers assign it directly."""
    if engine is None:
        return None
    try:
        engine.quit()
    except Exception:
        pass
    finally:
        try:
            engine.close()
        except Exception:
            pass
    return None


def evaluate(request, binary, engine=None):
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
        policy = f"sf19-ms{time_ms}-mpv{multipv}-d{depth}-t4-h128-v3"
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
    # spawn_ms measures engine spawn on a cold slot and ~0 on a warm one.
    spawn_started = time.monotonic()
    owned = engine is None
    if owned:
        engine = spawn_engine(binary)
    try:
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
                    pv = [move.uci() for move in info["pv"][:5]]
                    entry = dict(
                        move=pv[0], score=white_score(info["score"]), depth=info["depth"])
                    # Rank-1 PV only: the verdict's 3-ply material window reads
                    # lines[0]["pv"] rooted at the evaluated position. Lower
                    # ranks omit it to bound payload/cache bytes.
                    if rank == 1:
                        entry["pv"] = pv
                    iterations.setdefault(info["depth"], {})[rank] = entry
        search_ms = round((time.monotonic() - search_started) * 1000)
        complete = [depth for depth, lines in iterations.items() if len(lines) == count]
        if not complete:
            raise RuntimeError("no complete exact engine result")
        # Ranks must show distinct first moves. Transient reports can echo one
        # rank's PV into another at the same depth; keeping those duplicates
        # marks two rows "played" downstream and corrupts keyed list
        # reconciliation on navigation. Prefer the deepest depth with a full
        # distinct set.
        lines = None
        for depth in sorted(complete, reverse=True):
            ranked = [iterations[depth][rank] for rank in range(1, count + 1)]
            if len({line["move"] for line in ranked}) == count:
                lines = ranked
                break
        if lines is None:
            raise RuntimeError("no complete distinct exact engine result")
        result["lines"] = lines
        result.update(best_move=result["lines"][0]["move"], score=result["lines"][0]["score"],
                      depth=min(line["depth"] for line in result["lines"]))
        report_timing(request, policy, multipv, started, spawn_ms, search_ms, result["depth"], count)
        return result
    finally:
        if owned:
            drop_engine(engine)


def serve(binary):
    """JSON-lines loop over a warm engine. Terminal/invalid requests never
    touch the engine. A dead engine respawns once and retries the request;
    two consecutive failures exit so the Go side restarts the slot clean."""
    try:
        engine = spawn_engine(binary)
    except Exception as error:
        print(f"stockfish_timing outcome=error total_ms=0 error={type(error).__name__}: {str(error)[:1024]}", file=sys.stderr, flush=True)
        raise
    print(json.dumps({"ready": True}), flush=True)
    while True:
        raw = sys.stdin.readline(MAX_LINE + 1)
        if not raw:
            return
        if len(raw.encode()) > MAX_LINE or not raw.endswith("\n"):
            while not raw.endswith("\n"):
                raw = sys.stdin.readline(MAX_LINE + 1)
                if not raw:
                    return
            print(json.dumps({"code": "engine_unavailable",
                              "message": "Stockfish evaluation is unavailable"}), flush=True)
            continue
        started = time.monotonic()
        try:
            request = json.loads(raw)
        except ValueError:
            request = None
        result = None
        engine_dead_once = False
        while True:
            try:
                if not isinstance(request, dict):
                    raise InvalidRequest("invalid_position")
                result = evaluate(request, binary, engine)
                break
            except InvalidRequest as error:
                result = {"code": error.code, "message": "position or move history is invalid"}
                break
            except chess.engine.EngineTerminatedError as error:
                total_ms = round((time.monotonic() - started) * 1000)
                print(f"stockfish_timing outcome=error total_ms={total_ms} error={type(error).__name__}: {str(error)[:1024]}", file=sys.stderr, flush=True)
                engine = drop_engine(engine)
                if engine_dead_once:
                    result = {"code": "engine_unavailable", "message": "Stockfish evaluation is unavailable"}
                    break
                engine_dead_once = True
                try:
                    engine = spawn_engine(binary)
                except Exception as respawn_error:
                    total_ms = round((time.monotonic() - started) * 1000)
                    print(f"stockfish_timing outcome=error total_ms={total_ms} error={type(respawn_error).__name__}: {str(respawn_error)[:1024]}", file=sys.stderr, flush=True)
                    result = {"code": "engine_unavailable", "message": "Stockfish evaluation is unavailable"}
                    break
            except Exception as error:
                # Transient search failure on a live engine: keep the warmth,
                # error only this request.
                total_ms = round((time.monotonic() - started) * 1000)
                print(f"stockfish_timing outcome=error total_ms={total_ms} error={type(error).__name__}: {str(error)[:1024]}", file=sys.stderr, flush=True)
                result = {"code": "engine_unavailable", "message": "Stockfish evaluation is unavailable"}
                break
        print(json.dumps(result))
        if engine is None:
            return


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--serve", action="store_true",
                        help="JSON-lines persistent mode instead of one-shot stdin")
    args = parser.parse_args()
    if args.serve:
        serve(args.binary)
        return
    started = time.monotonic()
    try:
        result = evaluate(json.load(sys.stdin), args.binary)
    except InvalidRequest as error:
        result = {"code": error.code, "message": "position or move history is invalid"}
    except Exception as error:
        total_ms = round((time.monotonic() - started) * 1000)
        print(f"stockfish_timing outcome=error total_ms={total_ms} error={type(error).__name__}: {str(error)[:1024]}", file=sys.stderr, flush=True)
        result = {"code": "engine_unavailable", "message": "Stockfish evaluation is unavailable"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
