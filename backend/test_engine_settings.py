"""Search-option transport without requiring model weights or an engine binary."""
import unittest
import os
from unittest.mock import MagicMock, patch

import chess
import chess.engine
from stockfish_worker import evaluate, InvalidRequest, SEARCH_POLICY


class SearchSettingsTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("STOCKFISH_BINARY"), "requires Stockfish 19")
    def test_real_search_settings(self):
        for settings in [{"time_ms": 250, "lines": 1, "depth": 0},
                         {"time_ms": 2000, "lines": 5, "depth": 8}]:
            result = evaluate({"fen": chess.STARTING_FEN, "settings": settings}, os.environ["STOCKFISH_BINARY"])
            self.assertEqual(len(result["lines"]), settings["lines"])
            self.assertGreater(result["depth"], 0)
            if settings["depth"]:
                self.assertLessEqual(result["depth"], settings["depth"])
            self.assertIn(chess.Move.from_uci(result["best_move"]), chess.Board().legal_moves)

    def test_limits_policy_and_candidate_count(self):
        for settings in [None, {"time_ms": 750, "lines": 2, "depth": 0},
                         {"time_ms": 30000, "lines": 5, "depth": 40}]:
            with self.subTest(settings=settings):
                engine = MagicMock()
                engine.id = {"name": "Stockfish 19"}
                count = settings["lines"] if settings else 2
                moves = list(chess.Board().legal_moves)[:count]
                engine.analysis.return_value.__enter__.return_value = [
                    dict(depth=10, multipv=rank, pv=[move],
                         score=chess.engine.PovScore(chess.engine.Cp(20), chess.WHITE))
                    for rank, move in enumerate(moves, 1)]
                request = {"fen": chess.STARTING_FEN, "moves": []}
                if settings is not None:
                    request["settings"] = settings
                with patch("chess.engine.SimpleEngine.popen_uci", return_value=engine):
                    result = evaluate(request, "/unused")
                limit = engine.analysis.call_args.args[1]
                self.assertEqual(engine.analysis.call_args.kwargs["multipv"], count)
                self.assertEqual(len(result["lines"]), count)
                if settings:
                    self.assertEqual(limit.time, settings["time_ms"] / 1000)
                    self.assertEqual(limit.depth, settings["depth"] or None)
                    self.assertIsNone(limit.nodes)
                    expected = ("sf19-ms750-mpv2-d0-t1-h64-v2" if count == 2
                                else "sf19-ms30000-mpv5-d40-t1-h64-v2")
                else:
                    self.assertEqual(limit.time, .75)
                    self.assertEqual(limit.nodes, 100000)
                    expected = SEARCH_POLICY
                self.assertEqual(result["search_policy"], expected)
                engine.quit.assert_called_once()
                engine.close.assert_called_once()

    def test_invalid_settings_do_not_launch_engine(self):
        for settings in [{}, {"time_ms": 30001, "lines": 2, "depth": 0},
                         {"time_ms": 750, "lines": True, "depth": 0}]:
            with patch("chess.engine.SimpleEngine.popen_uci") as launch:
                with self.assertRaises(InvalidRequest):
                    evaluate({"fen": chess.STARTING_FEN, "settings": settings}, "/unused")
                launch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
