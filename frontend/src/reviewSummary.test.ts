import { expect, it } from 'vitest';
import { applyUci, positionOf, replay, START_FEN } from './domain';
import type { Quality } from './reviewMetrics';
import { summarizeReview } from './reviewSummary';

function nodes(moves: string[], initialFen = START_FEN) {
  const game = replay([], initialFen);
  const positions = [positionOf(game)];
  for (const move of moves) { applyUci(game, move); positions.push(positionOf(game)); }
  return positions;
}
const quality = (accuracy: number, label: Quality['label'] = 'Good'): Quality => ({ accuracy, label, loss: null });
const missing: Quality = { label: 'Unreviewed', accuracy: null, loss: null };

it('averages each side independently and counts every actual move', () => {
  const summary = summarizeReview(nodes(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5']), [quality(100), quality(80), quality(40, 'Blunder'), quality(60, 'Mistake'), quality(100, 'Forced')]);
  expect(summary.total).toBe(5);
  expect(summary.reviewed).toBe(5);
  expect(summary.sides[0]).toMatchObject({ color: 'white', total: 3, reviewed: 3, accuracy: 80, issues: { Inaccuracy: 0, Mistake: 0, Blunder: 1 } });
  expect(summary.sides[1]).toMatchObject({ color: 'black', total: 2, reviewed: 2, accuracy: 70, issues: { Inaccuracy: 0, Mistake: 1, Blunder: 0 } });
});

it('counts misses alongside inaccuracies, mistakes, and blunders', () => {
  const summary = summarizeReview(nodes(['e2e4', 'e7e5']), [quality(20, 'Miss'), quality(100, 'Best')]);
  expect(summary.sides[0]).toMatchObject({ issues: { Inaccuracy: 0, Mistake: 0, Miss: 1, Blunder: 0 } });
  expect(summary.issues).toEqual([
    { beforePly: 0, color: 'white', moveNumber: 1, san: 'e4', label: 'Miss', accuracy: 20 },
  ]);
});
it('counts skulls separately from blunders with zero accuracy', () => {
  const summary = summarizeReview(nodes(['e2e4', 'e7e5']), [quality(0, 'Skull'), quality(100, 'Best')]);
  expect(summary.sides[0]).toMatchObject({ issues: { Inaccuracy: 0, Mistake: 0, Miss: 0, Blunder: 0, Skull: 1 } });
  expect(summary.issues).toEqual([
    { beforePly: 0, color: 'white', moveNumber: 1, san: 'e4', label: 'Skull', accuracy: 0 },
  ]);
});
it('keeps unavailable moves out of means while retaining incomplete coverage', () => {
  const summary = summarizeReview(nodes(['e2e4', 'e7e5', 'g1f3', 'b8c6']), [missing, quality(0, 'Blunder'), missing]);
  expect(summary.sides[0]).toMatchObject({ total: 2, reviewed: 0, accuracy: null });
  expect(summary.sides[1]).toMatchObject({ total: 2, reviewed: 1, accuracy: 0 });
  expect(summary.reviewed).toBe(1);
  expect(summary.issues).toHaveLength(1);
});

it('uses the actual mover and fullmove number for black-to-move imports', () => {
  const initialFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 23';
  const summary = summarizeReview(nodes(['e7e5', 'g1f3', 'b8c6'], initialFen), [quality(75, 'Inaccuracy'), quality(30, 'Blunder'), quality(55, 'Mistake')]);
  expect(summary.sides[0]).toMatchObject({ total: 1, reviewed: 1, accuracy: 30 });
  expect(summary.sides[1]).toMatchObject({ total: 2, reviewed: 2, accuracy: 65 });
  expect(summary.issues).toEqual([
    { beforePly: 0, color: 'black', moveNumber: 23, san: 'e5', label: 'Inaccuracy', accuracy: 75 },
    { beforePly: 1, color: 'white', moveNumber: 24, san: 'Nf3', label: 'Blunder', accuracy: 30 },
    { beforePly: 2, color: 'black', moveNumber: 24, san: 'Nc6', label: 'Mistake', accuracy: 55 },
  ]);
});

it('scopes totals, means, and issues to one side when requested', () => {
  const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'];
  const qs = [quality(100), quality(80), quality(40, 'Blunder'), quality(60, 'Mistake'), quality(100, 'Forced')];
  const summary = summarizeReview(nodes(moves), qs, 'black');
  expect(summary.sides).toHaveLength(1);
  expect(summary.sides[0]).toMatchObject({ color: 'black', total: 2, reviewed: 2, accuracy: 70, issues: { Inaccuracy: 0, Mistake: 1, Blunder: 0 } });
  expect(summary).toMatchObject({ total: 2, reviewed: 2 });
  expect(summary.issues.map(issue => issue.beforePly)).toEqual([3]);
});

it('hides the other side even when it holds the only reviewed moves', () => {
  const summary = summarizeReview(nodes(['e2e4', 'e7e5']), [quality(0, 'Blunder'), missing], 'black');
  expect(summary.sides).toHaveLength(1);
  expect(summary.sides[0]).toMatchObject({ color: 'black', total: 1, reviewed: 0, accuracy: null });
  expect(summary).toMatchObject({ total: 1, reviewed: 0, issues: [] });
});

it('leaves both accuracies unavailable when there are no moves', () => {
  const summary = summarizeReview(nodes([]), []);
  expect(summary).toMatchObject({ total: 0, reviewed: 0, issues: [] });
  expect(summary.sides.map(side => side.accuracy)).toEqual([null, null]);
});

it('includes the final mating move and identifies its pre-move position', () => {
  const summary = summarizeReview(nodes(['f2f3', 'e7e5', 'g2g4', 'd8h4']), [quality(70, 'Inaccuracy'), quality(100), quality(0, 'Blunder'), quality(100, 'Best')]);
  expect(summary.total).toBe(4);
  expect(summary.issues.map(issue => [issue.beforePly, issue.san])).toEqual([[0, 'f3'], [2, 'g4']]);
  expect(summary.sides[1].accuracy).toBe(100);
});
