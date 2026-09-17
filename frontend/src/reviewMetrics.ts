import type { Chess } from 'chess.js';
import type { MoveResponse } from './api';
import type { DomainOutcome } from './domain';
export const SEARCH_POLICY = 'sf19-n100k-ms750-mpv2-t1-h64-v1';
export const REVIEW_METHOD = 'maia-board-review-v1';
export type Score = { type: 'cp' | 'mate'; value: number; winning_side?: 'white' | 'black' };
export type Evaluation = { engine: 'Stockfish 19'; search_policy: string; depth: number; terminal: null | 'white_win' | 'black_win' | 'draw'; best_move: string | null; score: Score; lines: { move: string; score: Score; depth: number; pv?: string[] }[] };
export type Quality = { label: 'Forced' | 'Allowed mate' | 'Blunder' | 'Mistake' | 'Inaccuracy' | 'Excellent' | 'Great' | 'Best' | 'Good' | 'Unreviewed'; accuracy: number | null; loss: number | null };
// Engine facts (Stockfish only — no praise, no difficulty). reviewMove speaks
// this vocabulary; the display layer translates it once via
// effectiveQuality, so an engine-Critical is never mistaken for a displayed
// Great and an engine-Top never for a displayed Best:
// - Critical: the engine's only good move (best, clean, wide gap).
// - Top: played the engine's top move, but not critically.
// - Holds: not the top move, yet nothing meaningful lost.
export type EngineGrade = { label: 'Forced' | 'Allowed mate' | 'Blunder' | 'Mistake' | 'Inaccuracy' | 'Critical' | 'Top' | 'Holds' | 'Unreviewed'; accuracy: number | null; loss: number | null };
// Additive Maia difficulty axis, measured against the top move rather than
// 100%: r = prob(played) / prob(top). A 13% move under a 15% top (r = 0.87)
// is the same band as the top itself, while a 12% rank-1 in a wide opening
// is still Expected. Bands are r >= 3/5 (0.6) Expected, r >= 1/3 Uncommon,
// else Rare: Qe3-like 9.5% under a 32% top (r ~= 0.30) reads Rare against
// the majority, while f3-like 14.9% under a 34% top (r ~= 0.44) stays
// Uncommon. Unlisted (outside Maia's top 5) is Absent by
// construction; missing or degraded Maia data is Unknown and renders nothing.
export type Rarity = { label: 'Expected' | 'Uncommon' | 'Rare' | 'Absent' | 'Unknown'; r: number | null; prob: number | null; topProb: number | null };
export function maiaRarity(maia: Pick<MoveResponse, 'top_moves' | 'degraded'> | undefined, played: string): Rarity {
  if (!maia || maia.degraded || !Array.isArray(maia.top_moves) || maia.top_moves.length === 0) return { label: 'Unknown', r: null, prob: null, topProb: null };
  const topProb = maia.top_moves[0].prob;
  if (typeof topProb !== 'number' || !Number.isFinite(topProb) || topProb <= 0) return { label: 'Unknown', r: null, prob: null, topProb: null };
  const found = maia.top_moves.find(candidate => candidate.move === played);
  if (!found || typeof found.prob !== 'number' || !Number.isFinite(found.prob)) return { label: 'Absent', r: null, prob: null, topProb };
  const r = found.prob / topProb;
  return { label: r >= 0.6 ? 'Expected' : r >= 1 / 3 ? 'Uncommon' : 'Rare', r, prob: found.prob, topProb };
}
// The verdict carries only the quality × rarity synthesis. Grades, scores,
// and best lines already live in the badges, charts, and candidate lists, so
// restating them here is repetition. Praise (Excellent/Great) meets
// findability (a critical move nobody's model expects is an exceptional
// find); negative grades meet temptation (a blunder the model saw coming is
// an easy mistake). Wording stays model-relative — Maia's predicted
// likelihood, never population claims — and the raw probability grounds each
// characterization.
// Praise gating lives in effectiveQuality, not reviewMove (which stays pure
// engine so memo/cache keys never go stale on Maia changes). It translates
// engine facts into displayed judgments:
// - Critical + Absent or Rare-and-tiny (prob<5%) → Excellent (!!).
//   The relative leg (Rare/Absent) blocks wide-opening inflation where the
//   Maia top itself sits under 5% (r=1 there, not a find).
// - Critical + Uncommon/Rare at >=5% → Great (!).
// - Critical + Expected/Unknown → Best; Top → Best; Holds → Good.
// Unknown is transient/error only — callers hold the spinner while either
// engine is pending, and SF-settled non-critical moves complete without Maia
// (fast path), so the cap never flickers a settled badge.
export const EXCELLENT_MAX_PROB = 0.05;
// Display labels: the engine-fact labels Critical/Top/Holds never reach the
// badge. The predicate proves the fallthrough below only carries shared
// labels instead of asserting the translation.
const QUALITY_LABELS: readonly Quality['label'][] = ['Forced', 'Allowed mate', 'Blunder', 'Mistake', 'Inaccuracy', 'Excellent', 'Great', 'Best', 'Good', 'Unreviewed'];
function isQualityLabel(value: unknown): value is Quality['label'] {
  return QUALITY_LABELS.some(label => label === value);
}
export function effectiveQuality(grade: EngineGrade | undefined, rarity: Rarity | undefined): Quality | undefined {
  if (!grade) return undefined;
  if (grade.label === 'Critical') {
    if (!rarity || rarity.label === 'Expected' || rarity.label === 'Unknown') return { ...grade, label: 'Best' };
    if (rarity.label === 'Absent') return { ...grade, label: 'Excellent' };
    if (rarity.label === 'Rare' && rarity.prob != null && rarity.prob < EXCELLENT_MAX_PROB) return { ...grade, label: 'Excellent' };
    return { ...grade, label: 'Great' };
  }
  if (grade.label === 'Top') return { ...grade, label: 'Best' };
  if (grade.label === 'Holds') return { ...grade, label: 'Good' };
  if (!isQualityLabel(grade.label)) throw new Error(`Unknown engine grade: ${String(grade.label)}`);
  return { ...grade, label: grade.label };
}
function rarityVerdict(quality: Quality, rarity: Rarity | undefined, elo: number, bestRarity?: Rarity | null): string | null {
  if (!rarity || rarity.label === 'Unknown') return null;
  const praise = quality.label === 'Excellent' || quality.label === 'Great' || quality.label === 'Best';
  const holds = quality.label === 'Good';
  if (rarity.label === 'Absent') {
    if (quality.label === 'Excellent') return `An exceptional find — absent from Maia's top choices at ${elo}.`;
    if (praise) return `A genuine find — absent from Maia's top choices at ${elo}.`;
    if (holds) return `Absent from Maia's top choices at ${elo}, and it holds.`;
    return hardToAvoid(bestRarity, elo) ?? `Worth a second look — absent from Maia's top choices at ${elo}.`;
  }
  if (rarity.prob == null) return null;
  const pct = `${(rarity.prob * 100).toFixed(1).replace(/\.0$/, '')}%`;
  if (rarity.label === 'Expected') {
    if (praise || holds) return `The natural choice — Maia at ${elo} predicts ${pct} for this move.`;
    return hardToAvoid(bestRarity, elo) ?? `An easy mistake to make — Maia at ${elo} predicts ${pct} for this move.`;
  }
  if (rarity.label === 'Uncommon') {
    if (quality.label === 'Excellent') return `An exceptional find — Maia at ${elo} predicts only ${pct}.`;
    if (praise) return `A sharp find — Maia at ${elo} predicts only ${pct}.`;
    if (holds) return `A meaningful minority that holds — Maia at ${elo} predicts ${pct} for this move.`;
    return hardToAvoid(bestRarity, elo) ?? `A tempting sidestep — Maia at ${elo} predicts only ${pct}.`;
  }
  if (quality.label === 'Excellent') return `An exceptional find — Maia at ${elo} predicts only ${pct}.`;
  if (praise) return `A rare find — Maia at ${elo} predicts only ${pct}.`;
  if (holds) return `A rarely played choice that holds — Maia at ${elo} predicts only ${pct}.`;
  return hardToAvoid(bestRarity, elo) ?? `An unusual slip — Maia at ${elo} predicts only ${pct}.`;
}
// A mistake whose avoidance was itself a rare find: the best move sat under
// 5% (Rare) or outside Maia's top choices (Absent) at this Elo, so the slip
// was hard to avoid. Expected/Uncommon/Unknown best moves leave the standard
// temptation wording alone. Verdict-only: badges still read pure loss.
function hardToAvoid(bestRarity: Rarity | null | undefined, elo: number): string | null {
  if (!bestRarity || bestRarity.label === 'Expected' || bestRarity.label === 'Uncommon' || bestRarity.label === 'Unknown') return null;
  if (bestRarity.label === 'Absent') return `Hard to avoid — the best move is absent from Maia's top choices at ${elo}.`;
  if (bestRarity.prob == null || bestRarity.prob >= EXCELLENT_MAX_PROB) return null;
  const pct = `${(bestRarity.prob * 100).toFixed(1).replace(/\.0$/, '')}%`;
  return `Hard to avoid — Maia at ${elo} predicts only ${pct} for the best move.`;
}
// One verdict sentence for the move just played: the book name, the only
// legal move, or the rarity synthesis — never a restated grade. Returns null
// when there is nothing additive to say (unreviewed, off-book without Maia
// data, or pre-first-move); the badges and charts already carry the grades.
// materialNote is an additive second sentence (best-line 3-ply swing) supplied
// by the caller; it only renders for Mistake/Blunder so Inaccuracy stays quiet
// and Allowed-mate keeps its mate wording unmodified by pawn swings.
export type OpeningRef = { eco: string; name: string };
export function describeMove(args: { san: string; quality: Quality | undefined; rarity: Rarity | undefined; elo: number; opening?: OpeningRef | null; bestRarity?: Rarity | null; materialNote?: string | null }): string | null {
  const { san, quality, rarity, elo, opening, bestRarity, materialNote } = args;
  if (opening) return `${san} — ${opening.name} (${opening.eco}). Book move.`;
  if (!quality || quality.label === 'Unreviewed') return null;
  if (quality.label === 'Forced') return `${san} was the only legal move.`;
  const base = rarityVerdict(quality, rarity, elo, bestRarity);
  if (!base) return null;
  if (materialNote && (quality.label === 'Mistake' || quality.label === 'Blunder')) return `${base} ${materialNote}`;
  return base;
}
export function whiteWin(score: Score): number {
  return score.type === 'cp' ? 100 / (1 + Math.exp(-.00368208 * score.value)) : (score.winning_side ?? (score.value > 0 ? 'white' : 'black')) === 'white' ? 100 : 0;
}
export function moveAccuracy(loss: number): number { return loss === 0 ? 100 : Math.max(0, Math.min(100, 103.1668 * Math.exp(-.04354 * loss) - 3.1669)); }
export function classifyLoss(loss: number): 'Blunder' | 'Mistake' | 'Inaccuracy' | null { return loss >= 20 ? 'Blunder' : loss >= 10 ? 'Mistake' : loss >= 5 ? 'Inaccuracy' : null; }
// Mate allowed when avoidable: the mover had no forced mate against them
// (best play survives) but the played move lets the opponent force mate.
// Winner resolution mirrors whiteWin: explicit winning_side, else mate-value
// sign. Checked before classifyLoss, whose win% delta is blind to
// mate-to-mate (0 - 0) and lost-cp-to-mate (< 5) cases. There is no Miss
// label: a missed win that stays alive reads Blunder by loss (>= 20 always
// holds there), matching the engine-measures-loss-only principle.
export function isMateFor(score: Score, side: 'white' | 'black'): boolean {
  if (score.type !== 'mate') return false;
  return (score.winning_side ?? (score.value > 0 ? 'white' : 'black')) === side;
}
export function reviewMove(before: Evaluation | undefined, after: Evaluation | undefined, game: Chess, played: string): EngineGrade {
  if (!before || !after) return { label: 'Unreviewed', accuracy: null, loss: null };
  const legal = game.moves().length;
  if (legal === 1) return { label: 'Forced', accuracy: 100, loss: 0 };
  const pov = (score: Score) => game.turn() === 'w' ? whiteWin(score) : 100 - whiteWin(score);
  const loss = Math.max(0, pov(before.score) - pov(after.score));
  const [first, second] = before.lines;
  const best = played === before.best_move;
  const mover = game.turn() === 'w' ? 'white' : 'black';
  const opp = mover === 'white' ? 'black' : 'white';
  if (!best && isMateFor(after.score, opp) && !isMateFor(before.score, opp)) return { label: 'Allowed mate', accuracy: 0, loss };
  const critical = best && loss <= 1 && legal >= 2 && before.score.type === 'cp' && after.score.type === 'cp' && first?.move === played && second?.move !== played && first.score.type === 'cp' && second?.score.type === 'cp' && pov(first.score) - pov(second.score) >= 10;
  return { label: classifyLoss(loss) ?? (critical ? 'Critical' : best ? 'Top' : 'Holds'), accuracy: moveAccuracy(loss), loss };
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
