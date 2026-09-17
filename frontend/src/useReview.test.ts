import { expect, it } from 'vitest';
import { buildTimeline, defaultSettings, START_FEN } from './domain';
import { EvaluationStore, fastReviewSettings, reviewKey, reviewNodes, type ReviewSettings } from './evaluationStore';
import { defaultStockfishSettings } from './stockfishSettings';
import { computeReviewQualities, gameIdentityFor, isMaiaPosition } from './useReview';
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
  expect(isMaiaPosition({ turn: 'white', outcome: null }, 'white', false)).toBe(false);
  expect(isMaiaPosition({ turn: 'black', outcome: { kind: 'draw' } }, 'white', true)).toBe(false);
  expect(isMaiaPosition({ turn: 'black', outcome: null }, 'white', false)).toBe(false);
});
it('resolves the same game identity for branched views and mainline passes', () => {
  // The continuation pass gates on the line's own-game flag while the view
  // gates on the branch; both must resolve one shared lookup.
  const saved = { id: 'saved', createdAt: '2026-09-10', moves: ['e2e4'], settings: defaultSettings };
  const live = { id: 'live', createdAt: '2026-09-10', moves: [], settings: defaultSettings };
  expect(gameIdentityFor('saved', [saved], live)).toBe(saved);
  expect(gameIdentityFor('live', [saved], live)).toBe(live);
  expect(gameIdentityFor('missing', [saved], live)).toBeNull();
  expect(gameIdentityFor(null, [saved], live)).toBe(live);
});
it('display layer accepts the fast MPV1 row provisionally until the full MPV2 lands', () => {
  const fullSettings: ReviewSettings = { eloMaia: 1600, eloUser: 1600, model: '79m', stockfish: defaultStockfishSettings };
  const fastSettings = fastReviewSettings(fullSettings)!;
  const node = reviewNodes(buildTimeline(START_FEN, ['e2e4']))[0];
  const store = new EvaluationStore();
  expect(store.provisionalSfResult(node, fullSettings)).toBeUndefined();
  store.store('sf', reviewKey('sf', node, fastSettings), sfFixture(node.fen, fastSettings.stockfish));
  expect(store.result('sf', node, fullSettings)).toBeUndefined();
  expect(store.provisionalSfResult(node, fullSettings)?.lines).toHaveLength(1);
  store.store('sf', reviewKey('sf', node, fullSettings), sfFixture(node.fen, defaultStockfishSettings));
  expect(store.provisionalSfResult(node, fullSettings)?.lines).toHaveLength(2);
});
