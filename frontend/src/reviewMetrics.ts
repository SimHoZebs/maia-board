import type { Chess } from 'chess.js';
export const SEARCH_POLICY = 'sf19-n100k-ms750-mpv2-t1-h64-v1';
export const REVIEW_METHOD = 'maia-board-review-v1';
export type Score = { type: 'cp' | 'mate'; value: number; winning_side?: 'white' | 'black' };
export type Evaluation = { engine: 'Stockfish 19'; search_policy: string; depth: number; terminal: null | 'white_win' | 'black_win' | 'draw'; best_move: string | null; score: Score; lines: { move: string; score: Score; depth: number }[] };
export type Quality = { label: 'Forced' | 'Blunder' | 'Mistake' | 'Inaccuracy' | 'Great' | 'Best' | 'Good' | 'Unreviewed'; accuracy: number | null; loss: number | null };
export function whiteWin(score: Score): number {
  return score.type === 'cp' ? 100 / (1 + Math.exp(-.00368208 * score.value)) : (score.winning_side ?? (score.value > 0 ? 'white' : 'black')) === 'white' ? 100 : 0;
}
export function moveAccuracy(loss: number): number { return loss === 0 ? 100 : Math.max(0, Math.min(100, 103.1668 * Math.exp(-.04354 * loss) - 3.1669)); }
export function classifyLoss(loss: number): 'Blunder' | 'Mistake' | 'Inaccuracy' | null { return loss >= 20 ? 'Blunder' : loss >= 10 ? 'Mistake' : loss >= 5 ? 'Inaccuracy' : null; }
export function reviewMove(before: Evaluation | undefined, after: Evaluation | undefined, game: Chess, played: string): Quality {
  if (!before || !after) return { label: 'Unreviewed', accuracy: null, loss: null };
  const legal = game.moves().length;
  if (legal === 1) return { label: 'Forced', accuracy: 100, loss: 0 };
  const pov = (score: Score) => game.turn() === 'w' ? whiteWin(score) : 100 - whiteWin(score);
  const loss = Math.max(0, pov(before.score) - pov(after.score));
  const [first, second] = before.lines;
  const best = played === before.best_move;
  const great = best && loss <= 1 && legal >= 2 && before.score.type === 'cp' && after.score.type === 'cp' && first?.move === played && second?.move !== played && first.score.type === 'cp' && second?.score.type === 'cp' && pov(first.score) - pov(second.score) >= 10;
  return { label: classifyLoss(loss) ?? (great ? 'Great' : best ? 'Best' : 'Good'), accuracy: moveAccuracy(loss), loss };
}
export function terminalEvaluation(game: Chess): Evaluation | undefined {
  if (!game.isGameOver()) return;
  const winner = game.isCheckmate() ? (game.turn() === 'w' ? 'black' : 'white') : null;
  return { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 0, terminal: winner ? `${winner}_win` : 'draw', best_move: null, lines: [], score: winner ? { type: 'mate', value: 0, winning_side: winner } : { type: 'cp', value: 0 } };
}
export function scoreValueText(score: Score): string { return score.type === 'mate' ? `${score.winning_side ?? (score.value > 0 ? 'white' : 'black')} mate ${Math.abs(score.value)}` : `${score.value >= 0 ? '+' : ''}${(score.value / 100).toFixed(2)} pawns`; }
export function scoreText(result: Evaluation): string { return scoreValueText(result.score); }
