import { expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { classifyLoss, moveAccuracy, reviewMove, SEARCH_POLICY, terminalEvaluation, whiteWin, type Evaluation } from './reviewMetrics';
const evaluation = (cp: number): Evaluation => ({ engine: 'Stockfish 19', search_policy: SEARCH_POLICY, score: { type: 'cp', value: cp }, depth: 14, best_move: 'e2e4', lines: [], terminal: null });
it('uses canonical white cp and preserves mate winner independent of distance', () => {
  expect(whiteWin({ type: 'cp', value: 0 })).toBe(50);
  expect(whiteWin({ type: 'cp', value: -100 })).toBeLessThan(50);
  expect(whiteWin({ type: 'mate', value: 0, winning_side: 'white' })).toBe(100);
  expect(whiteWin({ type: 'mate', value: -3 })).toBe(0);
});
it('classifies exact boundaries and clamps accuracy', () => {
  expect([4.99, 5, 10, 20].map(classifyLoss)).toEqual([null, 'Inaccuracy', 'Mistake', 'Blunder']);
  expect(moveAccuracy(0)).toBe(100); expect(moveAccuracy(100)).toBe(0);
});
it('measures both scores from the black mover perspective', () => {
  const game = new Chess(); game.move('e4');
  expect(reviewMove(evaluation(-100), evaluation(100), game, 'e7e5').label).toBe('Mistake');
  expect(reviewMove(evaluation(100), evaluation(-100), game, 'e7e5').accuracy).toBe(100);
});
it('requires a strong evaluated alternative gap for Great and excludes incomplete pairs', () => {
  const before = evaluation(200); before.lines = [{ move: 'e2e4', score: before.score, depth: 14 }, { move: 'd2d4', score: { type: 'cp', value: 0 }, depth: 14 }];
  expect(reviewMove(before, before, new Chess(), 'e2e4').label).toBe('Great');
  before.lines[1].score = { type: 'mate', value: 3 };
  expect(reviewMove(before, before, new Chess(), 'e2e4').label).toBe('Best');
  expect(reviewMove(before, undefined, new Chess(), 'e2e4').accuracy).toBeNull();
});
it('recognizes full-history repetition as terminal', () => {
  const game = new Chess(); ['Nf3','Nf6','Ng1','Ng8','Nf3','Nf6','Ng1','Ng8'].forEach(move => game.move(move));
  expect(terminalEvaluation(game)?.terminal).toBe('draw');
});
