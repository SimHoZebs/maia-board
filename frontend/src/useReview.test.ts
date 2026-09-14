import { expect, it } from 'vitest';
import { buildTimeline, START_FEN } from './domain';
import { reviewNodes, type ReviewSettings } from './evaluationStore';
import { computeReviewQualities, isMaiaPosition } from './useReview';
import { sfFixture } from './evaluationTestFixtures';

const settings: ReviewSettings = { eloMaia: 1600, eloUser: 1600, model: '79m' };
it('a different board or played move invalidates a verdict even when evaluation objects are shared', () => {
  const first = buildTimeline(START_FEN, ['e2e4']);
  const evaluations = [sfFixture(START_FEN), sfFixture(first.rows[1].fen)];
  const run = (timeline: typeof first, prev: Parameters<typeof computeReviewQualities>[0]['prev']) => {
    const stats = { reviews: 0 };
    return { ...computeReviewQualities({ line: timeline, nodes: reviewNodes(timeline), evaluations, settingsForNode: () => settings, pending: new Set(), prev, stats }), stats };
  };
  const original = run(first, null);
  expect(run(first, original.memo).stats.reviews).toBe(0);
  const differentMove = run(buildTimeline(START_FEN, ['d2d4']), original.memo);
  expect(differentMove.stats.reviews).toBe(1);
  expect(differentMove.qualities[0]).not.toBe(original.qualities[0]);
  const differentBoard = run(buildTimeline(START_FEN.replace('RNBQKBNR', 'RNB1KBNR'), ['e2e4']), original.memo);
  expect(differentBoard.stats.reviews).toBe(1);
  expect(differentBoard.qualities[0]).not.toBe(original.qualities[0]);
});
it('pins Maia settings only on its own-game mainline positions with moves available', () => {
  expect(isMaiaPosition({ turn: 'black', outcome: null }, 'white', true)).toBe(true);
  expect(isMaiaPosition({ turn: 'white', outcome: null }, 'white', true)).toBe(false);
  expect(isMaiaPosition({ turn: 'black', outcome: { kind: 'draw' } }, 'white', true)).toBe(false);
  expect(isMaiaPosition({ turn: 'black', outcome: null }, 'white', false)).toBe(false);
});
