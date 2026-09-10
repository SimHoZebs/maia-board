"""Run with STOCKFISH_BINARY set to the packaged Stockfish 19 executable."""
import inspect
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch, MagicMock

import chess
import chess.engine
from stockfish_worker import evaluate, white_score


class StockfishTests(unittest.TestCase):
    def run_worker(self, board, moves=None, initial=None, binary=None):
        request = {"fen": board.fen(en_passant="fen"), "moves": moves or []}
        if initial is not None:
            request["initial_fen"] = initial
        started = time.monotonic()
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("stockfish_worker.py")),
                                 "--binary", binary or os.environ["STOCKFISH_BINARY"]],
                                input=json.dumps(request), text=True, capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 0, result.stderr)
        result = json.loads(result.stdout)
        print(json.dumps({"fen": board.fen(), "seconds": round(time.monotonic()-started, 3),
                          "depth": result.get("depth"), "score": result.get("score")}))
        return result

    def test_api_signature_and_perspective(self):
        self.assertEqual(chess.__version__, "1.11.2")
        self.assertFalse(inspect.signature(chess.engine.SimpleEngine.popen_uci).parameters["setpgrp"].default)
        for turn in [chess.WHITE, chess.BLACK]:
            for value in [-100, 100]:
                self.assertEqual(white_score(chess.engine.PovScore(chess.engine.Cp(value), turn))["value"],
                                 value if turn else -value)
            for value in [-3, 3]:
                score = white_score(chess.engine.PovScore(chess.engine.Mate(value), turn))
                expected = value if turn else -value
                self.assertEqual(score["value"], expected)
                self.assertEqual(score["winning_side"], "white" if expected > 0 else "black")

    def test_real_start_middle_end(self):
        for fen in [chess.STARTING_FEN,
                    "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
                    "8/8/4k3/8/4K3/8/4P3/8 w - - 0 1"]:
            board = chess.Board(fen)
            result = self.run_worker(board, initial=fen)
            self.assertNotIn("code", result)
            self.assertIsNone(result["terminal"])
            self.assertIn(chess.Move.from_uci(result["best_move"]), board.legal_moves)
            self.assertEqual(result["depth"], min(line["depth"] for line in result["lines"]))
            self.assertEqual(len(result["lines"]), 2)
            self.assertEqual(result["score"]["type"], "cp")

    def test_inexact_scores_fail_and_quit(self):
        engine = MagicMock()
        engine.id = {"name": "Stockfish 19"}
        engine.analysis.return_value.__enter__.return_value = [{"pv": [chess.Move.from_uci("e2e4")],
                                        "score": chess.engine.PovScore(chess.engine.Cp(10), chess.WHITE),
                                        "depth": 5, "lowerbound": True}]
        with patch("chess.engine.SimpleEngine.popen_uci", return_value=engine):
            with self.assertRaisesRegex(RuntimeError, "no complete exact"):
                evaluate({"fen": chess.STARTING_FEN, "moves": []}, "/unused")
        engine.quit.assert_called_once()
        engine.close.assert_called_once()

    def test_real_cp_white_perspective_on_black_turn(self):
        board = chess.Board("8/8/4k3/8/4K3/8/4P3/8 b - - 0 1")
        for position in [board, board.mirror()]:
            result = self.run_worker(position, initial=position.fen())
            self.assertEqual(result["score"]["type"], "cp")
            self.assertGreater(result["score"]["value"] * (1 if position == board else -1), 0)

    def test_latest_complete_exact_iteration(self):
        engine = MagicMock()
        engine.id = {"name": "Stockfish 19"}
        def report(depth, rank, move, **extra):
            return dict(depth=depth, multipv=rank, pv=[chess.Move.from_uci(move)],
                        score=chess.engine.PovScore(chess.engine.Cp(20), chess.WHITE), **extra)
        engine.analysis.return_value.__enter__.return_value = [
            report(4, 1, "e2e4"), report(4, 2, "d2d4"),
            report(5, 1, "g1f3", lowerbound=True), report(5, 2, "c2c4")]
        with patch("chess.engine.SimpleEngine.popen_uci", return_value=engine):
            result = evaluate({"fen": chess.STARTING_FEN}, "/unused")
        self.assertEqual(result["depth"], 4)
        self.assertEqual(result["best_move"], "e2e4")
        self.assertEqual([line["move"] for line in result["lines"]], ["e2e4", "d2d4"])

    def test_mates_and_terminal_without_engine(self):
        for fen, winner in [("7k/5Q2/6K1/8/8/8/8/8 w - - 0 1", "white"),
                            ("8/8/8/8/8/6k1/5q2/7K b - - 0 1", "black")]:
            board = chess.Board(fen)
            result = self.run_worker(board, initial=fen)
            self.assertEqual(result["score"]["type"], "mate")
            self.assertEqual(result["score"]["winning_side"], winner)
            self.assertEqual(result["score"]["value"], 1 if winner == "white" else -1)
            board.push_uci(result["best_move"])
            terminal = self.run_worker(board, initial=board.fen(), binary="/missing")
            self.assertEqual(terminal["terminal"], winner + "_win")
            self.assertEqual(terminal["score"]["winning_side"], winner)
            self.assertEqual(terminal["score"]["value"], 0)
            self.assertEqual(terminal["lines"], [])
            self.assertIsNone(terminal["best_move"])

    def test_one_legal_move(self):
        board = chess.Board("R6k/8/5K2/8/8/8/8/8 b - - 0 1")
        self.assertEqual(board.legal_moves.count(), 1)
        result = self.run_worker(board, initial=board.fen())
        self.assertEqual(result["best_move"], "h8h7")
        self.assertEqual(len(result["lines"]), 1)

    def test_history_and_draws(self):
        board = chess.Board()
        moves = ["g1f3", "g8f6", "f3g1", "f6g8"] * 2
        for move in moves:
            board.push_uci(move)
        result = self.run_worker(board, moves, binary="/missing")
        self.assertEqual(result["terminal"], "draw")
        self.assertEqual(self.run_worker(board)["code"], "position_mismatch")
        board.pop()
        self.assertTrue(board.can_claim_threefold_repetition())
        self.assertFalse(board.is_repetition(3))
        # It must attempt evaluation, so a missing engine yields an error.
        self.assertEqual(self.run_worker(board, moves[:-1], binary="/missing")["code"], "engine_unavailable")
        for fen in ["7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
                    "7k/8/6K1/8/8/8/8/8 w - - 0 1",
                    "7k/8/6K1/8/8/8/8/R7 w - - 100 51"]:
            self.assertEqual(self.run_worker(chess.Board(fen), initial=fen, binary="/missing")["terminal"], "draw")
        # Legal custom-start replay, including a normalized uncapturable EP square.
        initial = "7k/7p/5K2/8/8/8/P7/8 w - - 0 1"
        board = chess.Board(initial)
        board.push_uci("a2a4")
        self.assertNotIn("code", self.run_worker(board, ["a2a4"], initial))
        self.assertEqual(self.run_worker(chess.Board(), ["e2e5"])["code"], "invalid_position")
        invalid = chess.Board("8/8/8/8/8/8/8/8 w - - 0 1")
        self.assertEqual(self.run_worker(invalid, initial=invalid.fen())["code"], "invalid_position")


if __name__ == "__main__":
    unittest.main()
