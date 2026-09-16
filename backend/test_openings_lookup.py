"""Unit tests for openings_lookup.py. Needs python-chess (CI installs it for
the worker tests) and the checked-in backend/openings_table.json."""

import json
import os
import unittest

import chess

import openings_lookup
from openings_lookup import InvalidRequest, epd_key, lookup

HERE = os.path.dirname(os.path.abspath(__file__))
TABLE_PATH = os.path.join(HERE, "openings_table.json")


def board_after(sans):
    board = chess.Board()
    for san in sans:
        board.push_san(san)
    return board


class EpdKeyTest(unittest.TestCase):
    def test_strips_move_counters(self):
        fen = board_after(["e4", "e5"]).fen()
        board, turn, castling, ep, _, _ = fen.split(" ")
        self.assertEqual(
            epd_key(chess.Board(f"{board} {turn} {castling} {ep} 0 1")),
            epd_key(chess.Board(f"{board} {turn} {castling} {ep} 7 23")),
        )

    def test_keeps_legally_capturable_en_passant(self):
        board = board_after(["e4", "Nf6", "e5", "d5"])
        self.assertEqual(board.fen().split(" ")[3], "d6")
        self.assertIn(" d6", epd_key(board))

    def test_blanks_pin_illegal_en_passant(self):
        # exd6 removes both pawns and uncovers Re8 on Ke2: no legal EP capture.
        board = chess.Board("4r1k1/8/8/3pP3/8/8/4K3/8 w - d6 0 1")
        self.assertTrue(board.is_valid())
        self.assertFalse(any(board.is_en_passant(move) for move in board.legal_moves))
        self.assertTrue(epd_key(board).endswith(" -"))


class LookupSyntheticTest(unittest.TestCase):
    def setUp(self):
        self.table = {
            epd_key(board_after(["e4"])): ["B00", "Test Opening"],
            epd_key(board_after(["e4", "e5", "Nf3"])): ["C50", "Test Opening: Variation"],
        }
        self.line = ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"]

    def test_deepest_match_and_per_move_flags(self):
        result = lookup({"moves": self.line}, self.table)
        self.assertEqual(result["matches"], [
            {"ply": 1, "eco": "B00", "name": "Test Opening"},
            {"ply": 3, "eco": "C50", "name": "Test Opening: Variation"},
        ])
        self.assertEqual(result["book_flags"], [True, False, True, False, False])

    def test_empty_line_has_no_matches_or_flags(self):
        self.assertEqual(lookup({"moves": []}, self.table), {"matches": [], "book_flags": []})

    def test_custom_start_never_matches_but_still_replays(self):
        request = {"initial_fen": "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3",
                   "moves": ["e2e4"]}
        self.assertEqual(lookup(request, self.table), {"matches": [], "book_flags": [False]})

    def test_illegal_move_rejects(self):
        with self.assertRaises(InvalidRequest):
            lookup({"moves": ["e2e4", "e7e5", "e2e4"]}, self.table)

    def test_bad_fen_rejects(self):
        with self.assertRaises(InvalidRequest):
            lookup({"initial_fen": "not-a-fen", "moves": []}, self.table)


class LookupRealBookTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(TABLE_PATH, encoding="utf-8") as handle:
            cls.table = json.load(handle)["positions"]

    def test_table_size(self):
        self.assertGreater(len(self.table), 3000)

    def test_italian_game(self):
        result = lookup({"moves": ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4"]}, self.table)
        last = result["matches"][-1]
        self.assertEqual(last["ply"], 5)
        self.assertEqual(last["eco"], "C50")
        self.assertIn("Italian", last["name"])

    def test_najdorf(self):
        moves = ["e2e4", "c7c5", "g1f3", "d7d6", "d2d4", "c5d4", "f3d4", "g8f6", "b1c3", "a7a6"]
        result = lookup({"moves": moves}, self.table)
        self.assertIn("Najdorf", result["matches"][-1]["name"])
        self.assertEqual(result["matches"][-1]["ply"], len(moves))

    def test_transpositions_converge(self):
        first = lookup({"moves": ["g1f3", "d7d5", "d2d4"]}, self.table)
        second = lookup({"moves": ["d2d4", "d7d5", "g1f3"]}, self.table)
        self.assertTrue(first["matches"])
        self.assertEqual(first["matches"], second["matches"])


if __name__ == "__main__":
    unittest.main()
