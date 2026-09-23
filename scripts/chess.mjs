// chess.mjs "<fen>" [moves...] — legality, turn, SAN/UCI, material, JSON.
// Moves accept UCI (e2e4, a7a8q) or SAN (Nf3, O-O). Uses the repo's chess.js.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(ROOT, "frontend", "package.json"));
const { Chess } = require("chess.js");

const [fen, ...moves] = process.argv.slice(2);
if (!fen || fen === "-h" || fen === "--help") {
  console.log('Usage: node scripts/chess.mjs "<fen>" [moves...]');
  process.exit(fen ? 0 : 2);
}
let chess;
try {
  chess = new Chess(fen);
} catch {
  console.log(JSON.stringify({ ok: false, error: "invalid_fen" }));
  process.exit(1);
}
const played = [];
for (const input of moves) {
  const uci = input.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/);
  let move = null;
  try {
    move = uci
      ? chess.move({ from: uci[1], to: uci[2], promotion: uci[3] })
      : chess.move(input);
  } catch {
    move = null;
  }
  if (!move) {
    console.log(JSON.stringify({ ok: false, error: "illegal_move", move: input, played }));
    process.exit(1);
  }
  played.push({ input, san: move.san, uci: move.from + move.to + (move.promotion || ""), fen: chess.fen() });
}
const material = { w: {}, b: {} };
for (const row of chess.board())
  for (const sq of row)
    if (sq) material[sq.color][sq.type] = (material[sq.color][sq.type] || 0) + 1;
console.log(JSON.stringify({
  ok: true,
  fen: chess.fen(),
  turn: chess.turn(),
  check: chess.inCheck(),
  checkmate: chess.isCheckmate(),
  stalemate: chess.isStalemate(),
  draw: chess.isDraw(),
  material,
  moves: played,
}));
