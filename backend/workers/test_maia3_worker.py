"""Pinned-upstream adapter contract with a fake model, no torch or weights."""
import io
import json
import sys
import types
import unittest
from unittest.mock import MagicMock, patch

import chess
import maia3_worker as worker


class FakeEngine:
    def __init__(self, sample=False):
        self.options = []
        self.positions = []
        self.sample = sample
        self.seen = []
        self.self_elo = 1750
        self.oppo_elo = 1320

    def cmd_setoption(self, line):
        self.options.append(line)
        try:
            name, _, value = line.split("name", 1)[1].strip().partition("value")
            name, value = name.strip().lower(), value.strip()
            if name == "selfelo":
                self.self_elo = int(value)
            elif name == "oppoelo":
                self.oppo_elo = int(value)
        except (IndexError, ValueError):
            pass

    def cmd_position(self, line):
        self.positions.append(line)
        tokens = line.split()
        self.board = chess.Board(" ".join(tokens[2:8]))
        for move in tokens[9:]:
            self.board.push_uci(move)

    def score_moves(self):
        self.seen.append((self.board.fen(), [m.uci() for m in self.board.move_stack]))
        legal = list(self.board.legal_moves)
        # Elo-dependent WDL so split tests can tell policy Elos from value Elos:
        # win encodes current SelfElo, draw fixed, loss remainder.
        win = min(750, self.self_elo // 5)
        wdl = (win, 250, 1000 - win - 250)
        candidates = [dict(move=m, policy=p, wdl=wdl)
                      for m, p in zip(legal[:5], [.4, .25, .15, .1, .05])]
        return legal[-1] if self.sample else legal[0], candidates


def request(fen=chess.STARTING_FEN, moves=None, initial="", temperature=0, value_self_elo=None, value_oppo_elo=None):
    payload = dict(fen=fen, moves=moves or [], initial_fen=initial,
                   self_elo=1750, oppo_elo=1320, temperature=temperature)
    if value_self_elo is not None:
        payload["value_self_elo"] = value_self_elo
    if value_oppo_elo is not None:
        payload["value_oppo_elo"] = value_oppo_elo
    return payload


class MaiaAdapterTests(unittest.TestCase):
    def test_main_uses_upstream_config_constructor_and_load(self):
        module = types.ModuleType("maia3.uci")
        cfg, engine = object(), MagicMock()
        module.parse_args = MagicMock(return_value=cfg)
        module.Maia3UCIEngine = MagicMock(return_value=engine)
        args = ["maia3_worker.py", "--model", "79m", "--device", "cpu",
                "--no-use-amp", "--multipv", "5", "--temperature", "0", "--use-uci-history"]
        with patch.dict(sys.modules, {"maia3": types.ModuleType("maia3"), "maia3.uci": module}), \
             patch.object(sys, "argv", args), patch.object(worker, "serve") as serve:
            worker.main()
        module.parse_args.assert_called_once_with(args[1:])
        module.Maia3UCIEngine.assert_called_once_with(cfg)
        engine.ensure_model_loaded.assert_called_once_with()
        self.assertIs(serve.call_args.args[0], engine)

    def test_options_reset_sampling_and_policy_wdl_parity(self):
        engine = FakeEngine(sample=True)
        sampled = worker.predict(engine, request(temperature=.7))["result"]
        self.assertNotIn(sampled["move"], [c["move"] for c in sampled["candidates"]])
        # FakeEngine encodes SelfElo 1750 as win 350: stored [loss, draw, win].
        self.assertEqual(sampled["wdl"], [.4, .25, .35])
        self.assertEqual([c["policy"] for c in sampled["candidates"]], [.4, .25, .15, .1, .05])
        engine.sample = False
        deterministic = worker.predict(engine, request())["result"]
        self.assertEqual(deterministic["move"], deterministic["candidates"][0]["move"])
        self.assertEqual(engine.options, [
            "setoption name SelfElo value 1750", "setoption name OppoElo value 1320",
            "setoption name MultiPV value 5", "setoption name Temperature value 0.7",
            "setoption name SelfElo value 1750", "setoption name OppoElo value 1320",
            "setoption name MultiPV value 5", "setoption name Temperature value 0"])

    def test_complete_history_and_custom_initial_position(self):
        root = chess.Board()
        root.push_uci("e2e4")
        initial = root.fen()
        moves = ["e7e5", "g1f3", "b8c6"]
        for move in moves:
            root.push_uci(move)
        engine = FakeEngine()
        worker.predict(engine, request(root.fen(), moves, initial))
        self.assertEqual(engine.positions, ["position fen " + initial + " moves " + " ".join(moves)])
        self.assertEqual(engine.seen, [(root.fen(), moves)])
        worker.predict(engine, request(root.fen()))
        self.assertEqual(engine.seen[-1], (root.fen(), []))

    def test_invalid_positions_do_not_call_engine(self):
        invalid = [request("8/8/8/8/8/8/8/8 w - - 0 1"),
                   request(moves=["e2e5"]), request(moves=["e2e4"]),
                   request(moves=["g1f3"] * 257),
                   request(initial="8/8/8/8/8/8/8/8 w - - 0 1")]
        for payload in invalid:
            engine = MagicMock()
            with self.assertRaises(worker.InvalidRequest):
                worker.predict(engine, payload)
            engine.score_moves.assert_not_called()
            engine.cmd_position.assert_not_called()

    def test_json_lines_one_reply_per_request_after_error(self):
        engine = FakeEngine()
        source = io.StringIO(json.dumps(request(moves=["e2e4"])) + "\n" + json.dumps(request()) + "\n")
        output = io.StringIO()
        worker.serve(engine, source, output)
        replies = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(replies[0], {"ready": True})
        self.assertEqual(replies[1]["error"]["code"], "position_mismatch")
        self.assertIn("result", replies[2])
        self.assertEqual(len(replies), 3)

    def test_oversized_input_exits_without_inference(self):
        engine, output = MagicMock(), io.StringIO()
        worker.serve(engine, io.StringIO("x" * (worker.MAX_LINE + 1) + "\n"), output)
        engine.score_moves.assert_not_called()
        self.assertEqual(len(output.getvalue().splitlines()), 2)

    def test_invalid_upstream_result_is_rejected(self):
        for mutate in [lambda items: items[0].update(policy=2),
                       lambda items: items[0].update(wdl=(1001, 0, -1)),
                       lambda items: items[1].update(move=items[0]["move"])]:
            engine = FakeEngine()
            original = engine.score_moves
            def score():
                move, items = original()
                mutate(items)
                return move, items
            engine.score_moves = score
            with self.assertRaises(RuntimeError):
                worker.predict(engine, request())

    def test_equal_top_policy_preserves_upstream_argmax_selection(self):
        engine = FakeEngine(sample=True)
        original = engine.score_moves
        def score():
            selected, candidates = original()
            for candidate in candidates:
                candidate["policy"] = .05
            return selected, candidates
        engine.score_moves = score
        result = worker.predict(engine, request())["result"]
        self.assertNotIn(result["move"], [item["move"] for item in result["candidates"]])

    def test_split_uses_policy_ordering_with_value_wdl(self):
        engine = FakeEngine()
        result = worker.predict(engine, request(value_self_elo=2400, value_oppo_elo=2400))["result"]
        # Policy ordering/probs from SelfElo 1750, WDL from value SelfElo 2400 (win 480).
        self.assertEqual([c["policy"] for c in result["candidates"]], [.4, .25, .15, .1, .05])
        self.assertEqual(result["wdl"], [.27, .25, .48])
        for candidate in result["candidates"]:
            self.assertEqual(candidate["wdl"], [.27, .25, .48])
        self.assertIn("setoption name SelfElo value 2400", engine.options)
        self.assertIn("setoption name SelfElo value 1750", engine.options)

    def test_split_defaults_to_policy_elos_when_omitted(self):
        engine = FakeEngine()
        result = worker.predict(engine, request())["result"]
        self.assertEqual(result["wdl"], [.4, .25, .35])

    def test_split_rejects_invalid_value_elo(self):
        for payload in [request(value_self_elo=-1), request(value_oppo_elo=5001),
                        request(value_self_elo="2400"), request(value_self_elo=2400.0)]:
            with self.assertRaises(worker.InvalidRequest):
                worker.predict(FakeEngine(), payload)

    def test_split_missing_value_coverage_raises(self):
        engine = FakeEngine()
        original = engine.score_moves
        calls = {"n": 0}
        def score():
            calls["n"] += 1
            move, items = original()
            if calls["n"] == 2:
                items = items[:3]
            return move, items
        engine.score_moves = score
        with self.assertRaises(RuntimeError):
            worker.predict(engine, request(value_self_elo=2400, value_oppo_elo=2400))


if __name__ == "__main__":
    unittest.main()
