"""Opt-in local-weight integration; never downloads a model during tests."""
import os
import unittest

import chess
from maia3_worker import predict


@unittest.skipUnless(os.environ.get("MAIA3_TEST_MODEL"), "set MAIA3_TEST_MODEL to a locally cached model")
class RealMaiaTests(unittest.TestCase):
    def test_real_deterministic_history(self):
        from maia3.uci import Maia3UCIEngine, parse_args
        config = parse_args(["--model", os.environ["MAIA3_TEST_MODEL"], "--device", "cpu",
                             "--no-use-amp", "--multipv", "5", "--temperature", "0",
                             "--use-uci-history", "--local-files-only"])
        engine = Maia3UCIEngine(config)
        engine.ensure_model_loaded()
        board = chess.Board()
        moves = ["e2e4", "e7e5", "g1f3"]
        for move in moves:
            board.push_uci(move)
        result = predict(engine, dict(fen=board.fen(), initial_fen=chess.STARTING_FEN,
                                     moves=moves, self_elo=1600, oppo_elo=1400, temperature=0))["result"]
        self.assertEqual(result["move"], result["candidates"][0]["move"])
        self.assertEqual(len(result["candidates"]), 5)
        self.assertIn(chess.Move.from_uci(result["move"]), board.legal_moves)


if __name__ == "__main__":
    unittest.main()
