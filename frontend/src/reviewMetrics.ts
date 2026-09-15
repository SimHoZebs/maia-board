import type { Chess } from 'chess.js';
import type { MoveResponse } from './api';
import type { DomainOutcome } from './domain';
export const SEARCH_POLICY = 'sf19-n100k-ms750-mpv2-t1-h64-v1';
export const REVIEW_METHOD = 'maia-board-review-v1';
export type Score = { type: 'cp' | 'mate'; value: number; winning_side?: 'white' | 'black' };
export type Evaluation = { engine: 'Stockfish 19'; search_policy: string; depth: number; terminal: null | 'white_win' | 'black_win' | 'draw'; best_move: string | null; score: Score; lines: { move: string; score: Score; depth: number }[] };
export type Quality = { label: 'Forced' | 'Skull' | 'Blunder' | 'Mistake' | 'Miss' | 'Inaccuracy' | 'Great' | 'Best' | 'Good' | 'Unreviewed'; accuracy: number | null; loss: number | null };
// Additive Maia difficulty axis, measured against the top move rather than
// 100%: r = prob(played) / prob(top). A 13% move under a 15% top (r = 0.87)
// is the same band as the top itself, while a 12% rank-1 in a wide opening
// is still Expected. Unlisted (outside Maia's top 5) is Unseen by
// construction; missing or degraded Maia data is Unknown and renders nothing.
export type Rarity = { label: 'Expected' | 'Seen' | 'Unseen' | 'Unknown'; r: number | null; prob: number | null; topProb: number | null };
export function maiaRarity(maia: Pick<MoveResponse, 'top_moves' | 'degraded'> | undefined, played: string): Rarity {
  if (!maia || maia.degraded || !Array.isArray(maia.top_moves) || maia.top_moves.length === 0) return { label: 'Unknown', r: null, prob: null, topProb: null };
  const topProb = maia.top_moves[0].prob;
  if (typeof topProb !== 'number' || !Number.isFinite(topProb) || topProb <= 0) return { label: 'Unknown', r: null, prob: null, topProb: null };
  const found = maia.top_moves.find(candidate => candidate.move === played);
  if (!found || typeof found.prob !== 'number' || !Number.isFinite(found.prob)) return { label: 'Unseen', r: null, prob: null, topProb };
  const r = found.prob / topProb;
  return { label: r >= 0.6 ? 'Expected' : r >= 0.25 ? 'Seen' : 'Unseen', r, prob: found.prob, topProb };
}
// The verdict carries only the quality × rarity synthesis. Grades, scores,
// and best lines already live in the badges, charts, and candidate lists, so
// restating them here is repetition. Positive grades meet findability (a great
// move nobody's model expects is a genuine find); negative grades meet
// temptation (a blunder the model saw coming is an easy mistake). Wording
// stays model-relative — Maia's predicted likelihood, never population
// claims — and the raw probability grounds each characterization.
function rarityVerdict(quality: Quality, rarity: Rarity | undefined, elo: number): string | null {
  if (!rarity || rarity.label === 'Unknown') return null;
  const positive = quality.label === 'Great' || quality.label === 'Best' || quality.label === 'Good';
  if (rarity.label === 'Unseen' && rarity.prob == null) {
    return positive
      ? `A genuine find — absent from Maia's top choices at ${elo}.`
      : `Worth a second look — absent from Maia's top choices at ${elo}.`;
  }
  if (rarity.prob == null) return null;
  const pct = `${(rarity.prob * 100).toFixed(1).replace(/\.0$/, '')}%`;
  if (rarity.label === 'Expected') {
    return positive
      ? `The natural choice — Maia at ${elo} predicts ${pct} for this move.`
      : `An easy mistake to make — Maia at ${elo} predicts ${pct} for this move.`;
  }
  if (rarity.label === 'Seen') {
    return positive
      ? `A sharp find — Maia at ${elo} predicts only ${pct}.`
      : `A tempting sidestep — Maia at ${elo} predicts only ${pct}.`;
  }
  return positive
    ? `A rare find — Maia at ${elo} predicts only ${pct}.`
    : `An unusual slip — Maia at ${elo} predicts only ${pct}.`;
}
// One verdict sentence for the move just played: the book name, the only
// legal move, or the rarity synthesis — never a restated grade. Returns null
// when there is nothing additive to say (unreviewed, off-book without Maia
// data, or pre-first-move); the badges and charts already carry the grades.
export type OpeningRef = { eco: string; name: string };
export function describeMove(args: { san: string; quality: Quality | undefined; rarity: Rarity | undefined; elo: number; opening?: OpeningRef | null }): string | null {
  const { san, quality, rarity, elo, opening } = args;
  if (opening) return `${san} — ${opening.name} (${opening.eco}). Book move.`;
  if (!quality || quality.label === 'Unreviewed') return null;
  if (quality.label === 'Forced') return `${san} was the only legal move.`;
  return rarityVerdict(quality, rarity, elo);
}
export function whiteWin(score: Score): number {
  return score.type === 'cp' ? 100 / (1 + Math.exp(-.00368208 * score.value)) : (score.winning_side ?? (score.value > 0 ? 'white' : 'black')) === 'white' ? 100 : 0;
}
export function moveAccuracy(loss: number): number { return loss === 0 ? 100 : Math.max(0, Math.min(100, 103.1668 * Math.exp(-.04354 * loss) - 3.1669)); }
export function classifyLoss(loss: number): 'Blunder' | 'Mistake' | 'Inaccuracy' | null { return loss >= 20 ? 'Blunder' : loss >= 10 ? 'Mistake' : loss >= 5 ? 'Inaccuracy' : null; }
// Miss thresholds: a win is on the board (best-play ceiling >= 80) and gone
// (mover keeps <= 60), yet the move didn't self-destruct (keeps >= 40).
// The 40 floor is what separates missed opportunity from damage: below it the
// Blunder stands. Note loss >= 20 always holds here (80 - 60), so Miss lives
// inside the Blunder band and must be checked before classifyLoss.
export const MISS_AVAILABLE = 80;
export const MISS_CAP = 60;
export const MISS_ALIVE_FLOOR = 40;
// Mate allowed when avoidable: the mover had no forced mate against them
// (best play survives) but the played move lets the opponent force mate.
// Winner resolution mirrors whiteWin: explicit winning_side, else mate-value
// sign. Checked before Miss (disjoint: Miss needs winB >= 80, which is never
// a losing mate) and before classifyLoss, whose win% delta is blind to
// mate-to-mate (0 - 0) and lost-cp-to-mate (< 5) cases.
export function isMateFor(score: Score, side: 'white' | 'black'): boolean {
  if (score.type !== 'mate') return false;
  return (score.winning_side ?? (score.value > 0 ? 'white' : 'black')) === side;
}
export function reviewMove(before: Evaluation | undefined, after: Evaluation | undefined, game: Chess, played: string): Quality {
  if (!before || !after) return { label: 'Unreviewed', accuracy: null, loss: null };
  const legal = game.moves().length;
  if (legal === 1) return { label: 'Forced', accuracy: 100, loss: 0 };
  const pov = (score: Score) => game.turn() === 'w' ? whiteWin(score) : 100 - whiteWin(score);
  const loss = Math.max(0, pov(before.score) - pov(after.score));
  const [first, second] = before.lines;
  const best = played === before.best_move;
  const winA = pov(after.score);
  const mover = game.turn() === 'w' ? 'white' : 'black';
  const opp = mover === 'white' ? 'black' : 'white';
  if (!best && isMateFor(after.score, opp) && !isMateFor(before.score, opp)) return { label: 'Skull', accuracy: 0, loss };
  if (!best && pov(before.score) >= MISS_AVAILABLE && winA <= MISS_CAP && winA >= MISS_ALIVE_FLOOR) return { label: 'Miss', accuracy: moveAccuracy(loss), loss };
  const great = best && loss <= 1 && legal >= 2 && before.score.type === 'cp' && after.score.type === 'cp' && first?.move === played && second?.move !== played && first.score.type === 'cp' && second?.score.type === 'cp' && pov(first.score) - pov(second.score) >= 10;
  return { label: classifyLoss(loss) ?? (great ? 'Great' : best ? 'Best' : 'Good'), accuracy: moveAccuracy(loss), loss };
}
// Single terminal source of truth. Winner resolution mirrors whiteWin:
// explicit winning_side, else mate-value sign. domain.ts outcome() and both
// Evaluation constructors share these two helpers so repetition/mate/draw
// facts cannot drift.
export function outcomeFromGame(game: Pick<Chess, 'isCheckmate' | 'isDraw' | 'turn'>): DomainOutcome | null {
  return game.isCheckmate() ? { kind: 'checkmate', winner: game.turn() === 'w' ? 'black' : 'white' }
    : game.isDraw() ? { kind: 'draw' } : null;
}
export function evaluationForOutcome(outcome: DomainOutcome | null, search_policy: string): Evaluation | undefined {
  if (!outcome) return;
  const winner = outcome.kind === 'checkmate' ? outcome.winner : null;
  return { engine: 'Stockfish 19', search_policy, depth: 0, terminal: winner ? `${winner}_win` : 'draw', best_move: null, lines: [],
    score: winner ? { type: 'mate', value: 0, winning_side: winner } : { type: 'cp', value: 0 } };
}
export function terminalEvaluation(game: Chess): Evaluation | undefined {
  if (!game.isGameOver()) return;
  return evaluationForOutcome(outcomeFromGame(game), SEARCH_POLICY);
}
export function scoreValueText(score: Score): string {
  // Bare signed numbers: sign is White-relative (+ White, - Black), magnitude
  // is pawns for cp or moves-to-mate for mate. No unit words.
  if (score.type === 'mate') {
    const white = (score.winning_side ?? (score.value > 0 ? 'white' : 'black')) === 'white';
    return `${white ? '+' : '-'}M${Math.abs(score.value)}`;
  }
  return `${score.value >= 0 ? '+' : '-'}${(Math.abs(score.value) / 100).toFixed(2)}`;
}
export function scoreText(result: Evaluation): string { return scoreValueText(result.score); }
