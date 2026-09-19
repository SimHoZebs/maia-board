import { expect, it } from 'vitest';
import { buildTimeline, defaultSettings, START_FEN } from './domain';
import { EvaluationStore, fastReviewSettings, gradingMaiaKey, reviewKey, reviewNodes, type ReviewNode, type ReviewSettings } from './evaluationStore';
import { laneKey, lanePoints } from './objective/maia';
import type { ObjectiveLane } from './qualities';
import type { MoveResponse } from './api';
import { defaultStockfishSettings } from './stockfishSettings';
import { computeReviewQualities, gameIdentityFor, isMaiaPosition, translateReviewQualities } from './useReview';
import { sfFixture } from './evaluationTestFixtures';
import type { EngineGrade } from './reviewMetrics';
import type { Rarity } from './reviewMetrics';

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
it('upgrades Excellent to Alien only with tiny 2400 rarity and a decisive gap', () => {
  const critical: EngineGrade = { label: 'Critical', accuracy: 100, loss: 0 };
  const node = { turn: 'white' } as never;
  const tiny: Rarity = { label: 'Rare', r: 0.075, prob: 0.03, topProb: 0.4 };
  const expected: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  const base = { grades: [critical], nodes: [node], maiaResults: [{} as never], rarities: [tiny],
    settingsForNode: () => settings, isMaiaPending: () => false as boolean };
  expect(translateReviewQualities(base)[0]?.label).toBe('Excellent');
  const alien = { rarity2400: [tiny] as (Rarity | undefined)[], sfGap: [35] };
  expect(translateReviewQualities({ ...base, alien })[0]?.label).toBe('Alien');
  expect(translateReviewQualities({ ...base, alien: { rarity2400: [expected], sfGap: [80] } })[0]?.label).toBe('Excellent');
  expect(translateReviewQualities({ ...base, alien: { rarity2400: [tiny], sfGap: [20] } })[0]?.label).toBe('Excellent');
  expect(translateReviewQualities({ ...base, alien: { rarity2400: [], sfGap: [] } })[0]?.label).toBe('Excellent');
  // Non-Critical grades never upgrade, even with full Alien evidence.
  expect(translateReviewQualities({ ...base, grades: [{ ...critical, label: 'Top' }], alien })[0]?.label).toBe('Best');
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
it('display layer accepts the fast MPV1 row provisionally until the full MPV2 lands', () => {  const fullSettings: ReviewSettings = { eloMaia: 1600, eloUser: 1600, model: '79m', stockfish: defaultStockfishSettings };
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
it('grades negatives from the 2400 lane and holds the spinner while it is pending', () => {
  const timeline = buildTimeline(START_FEN, ['e2e4', 'e7e5']);
  const nodes = reviewNodes(timeline);
  const flat = (fen: string, best: string) => ({ ...sfFixture(fen),
    score: { type: 'cp' as const, value: 20 }, best_move: best,
    lines: [{ move: best, score: { type: 'cp' as const, value: 20 }, depth: 12 },
      { move: 'a2a3', score: { type: 'cp' as const, value: 20 }, depth: 12 }] });
  const evaluations = [flat(nodes[0].fen, 'd2d4'), flat(nodes[1].fen, 'e7e5'), flat(nodes[2].fen, 'e7e5')];
  const grade = (top: string, wdl: [number, number, number]): MoveResponse =>
    ({ move: top, top_moves: [{ move: top, prob: 0.4, wdl: [0.2, 0.3, 0.5] }], wdl, model_used: '79m', degraded: false });
  // Move 1: 2400s play d2d4 (exp 80), e4 leaves White at 60 -> Blunder by loss 20.
  // Move 2: 2400 top is the played e7e5 -> SF Top (best), never negative.
  const gradingMaia = [grade('d2d4', [0.1, 0.2, 0.7]), grade('e7e5', [0.5, 0.2, 0.3]), grade('e7e5', [0.5, 0.3, 0.2])];
  const laneFor = (rows: (MoveResponse | undefined)[], pending: Set<string>): ObjectiveLane => ({
    points: lanePoints(rows, nodes),
    pending,
    keyFor: (node: ReviewNode) => laneKey(node, () => settings),
  });
  const run = (rows: (MoveResponse | undefined)[], pending: Set<string>) => computeReviewQualities({
    line: timeline, nodes, evaluations, settingsForNode: () => settings, pending: new Set(), prev: null,
    objective: laneFor(rows, pending),
  });
  const settled = run(gradingMaia, new Set());
  expect(settled.qualities[0]?.label).toBe('Blunder');
  expect(settled.qualities[1]?.label).toBe('Top');
  // Memo reuses the settled verdicts when nothing changes.
  const reused = computeReviewQualities({ line: timeline, nodes, evaluations, settingsForNode: () => settings,
    pending: new Set(), prev: settled.memo, objective: laneFor(gradingMaia, new Set()) });
  expect(reused.qualities[0]).toBe(settled.qualities[0]);
  // Missing before-position with its grading key pending: spinner, not SF fallback.
  const waiting = run([undefined, gradingMaia[1], gradingMaia[2]], new Set([laneKey(nodes[0], () => settings)]));
  expect(laneKey(nodes[0], () => settings)).toBe(gradingMaiaKey(nodes[0]));
  expect(waiting.qualities[0]?.label).toBe('Unreviewed');
  expect(waiting.qualities[1]?.label).toBe('Top');
  // Same miss without pending: legacy SF fallback (flat pair -> Holds).
  expect(run([undefined, gradingMaia[1], gradingMaia[2]], new Set()).qualities[0]?.label).toBe('Holds');
});
