import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computePlayQualities, type PlayQualitiesMemo } from './usePlayFeedback';
import { initialState, reducer } from './state';
import { KEYS } from './storage';
import { buildTimeline, START_FEN, timelineBuildsForTests } from './domain';
import { reviewKey, reviewNodes, stablePositionKey, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
import { sfFixture } from './evaluationTestFixtures';
import { defaultStockfishSettings } from './stockfishSettings';
import type { Evaluation } from './reviewMetrics';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
});
describe('feedback settings', () => {
  it('defaults off and round-trips through storage', () => {
    expect(initialState().feedback).toBe(false);
    const on = reducer(initialState(), { type: 'feedback', enabled: true });
    expect(on.feedback).toBe(true);
    expect(reducer(on, { type: 'feedback', enabled: true })).toBe(on);
    localStorage.setItem(KEYS.feedback, JSON.stringify(true));
    expect(initialState().feedback).toBe(true);
  });
  it('preserves loading indicator settings', () => {
    expect(initialState().badgeLoading).toBe('reel');
    expect(reducer(initialState(), { type: 'badge-loading', loading: 'shimmer' }).badgeLoading).toBe('shimmer');
    localStorage.setItem(KEYS.badgeLoading, JSON.stringify('placeholder'));
    expect(initialState().badgeLoading).toBe('placeholder');
    localStorage.setItem(KEYS.badgeLoading, JSON.stringify(true));
    expect(initialState().badgeLoading).toBe('reel');
  });
  it('defaults coordinates inside squares and round-trips through storage', () => {
    expect(initialState().coordinatesOnSquares).toBe(true);
    const outside = reducer(initialState(), { type: 'coordinates-on-squares', enabled: false });
    expect(outside.coordinatesOnSquares).toBe(false);
    expect(reducer(outside, { type: 'coordinates-on-squares', enabled: false })).toBe(outside);
    localStorage.setItem(KEYS.coordinatesOnSquares, JSON.stringify(false));
    expect(initialState().coordinatesOnSquares).toBe(false);
    localStorage.setItem(KEYS.coordinatesOnSquares, JSON.stringify('squares'));
    expect(initialState().coordinatesOnSquares).toBe(true);
  });
});

describe('timeline-backed move feedback', () => {
  const settings: ReviewSettings = { eloMaia: 1600, eloUser: 1600, model: '79m', stockfish: defaultStockfishSettings };
  const timeline = buildTimeline(START_FEN, ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  const nodes = reviewNodes(timeline);
  const values = new Map(nodes.map(node => [stablePositionKey(node), sfFixture(node.fen)]));
  const lookup = (node: ReviewNode) => values.get(stablePositionKey(node));
  const compute = (prev: PlayQualitiesMemo | null = null, overrides: Partial<Parameters<typeof computePlayQualities>[0]> = {}) => computePlayQualities({ gameId: 'game', timeline, userColor: 'white', settings, sfLookup: lookup, maiaLookup: () => undefined, sfPending: new Set(), maiaPending: new Set(), prev, ...overrides });

  it('grades only the user side and reuses raw verdicts across unrelated cache updates', () => {
    const first = compute(), stats = { reviews: 0 };
    expect(first.qualities[0]).toBeDefined(); expect(first.qualities[1]).toBeUndefined();
    expect(first.qualities[2]).toBeDefined(); expect(first.qualities[3]).toBeUndefined();
    const count = timelineBuildsForTests(), second = compute(first.memo, { stats });
    // Raw SF verdicts reuse (zero reviews); the translated display array is
    // fresh per call since Top/Holds translate into new Best/Good objects.
    expect(second.qualities).toEqual(first.qualities);
    expect(stats.reviews).toBe(0); expect(timelineBuildsForTests()).toBe(count);
    const black = compute(first.memo, { userColor: 'black' });
    expect(black.qualities[0]).toBeUndefined(); expect(black.qualities[1]).toBeDefined();
  });
  it('pending verdicts clear on failure and settle only after both evaluations exist', () => {
    const missing = (node: ReviewNode) => node.ply === 1 ? undefined : lookup(node);
    expect(compute(null, { sfLookup: missing }).qualities[0]).toBeUndefined();
    expect(compute(null, { sfLookup: missing, sfPending: new Set([reviewKey('sf', nodes[1], settings)]) }).qualities[0]?.label).toBe('Unreviewed');
    expect(compute().qualities[0]?.label).not.toBe('Unreviewed');
  });
  it('a changed evaluation recomputes only affected user verdicts', () => {
    const first = compute(), stats = { reviews: 0 };
    const changed: Evaluation = { ...values.get(stablePositionKey(nodes[1]))!, score: { type: 'cp', value: -250 } };
    const second = compute(first.memo, { stats, sfLookup: node => node.ply === 1 ? changed : lookup(node) });
    expect(stats.reviews).toBe(1);
    expect(second.qualities[0]).not.toEqual(first.qualities[0]);
    expect(second.qualities[2]).toEqual(first.qualities[2]);
  });
  it('takebacks and branches reuse surviving histories without retaining the wrong move verdict', () => {
    const first = compute();
    const shorter = compute(first.memo, { timeline: buildTimeline(START_FEN, ['e2e4', 'e7e5']) });
    expect(shorter.qualities).toHaveLength(2); expect(shorter.qualities[0]).toEqual(first.qualities[0]);
    const branch = buildTimeline(START_FEN, ['e2e4', 'e7e5', 'f1c4']);
    const branched = compute(first.memo, { timeline: branch });
    expect(branched.qualities[0]).toEqual(first.qualities[0]); expect(branched.qualities[2]).toBeUndefined();
  });
  it('uses side-to-move from custom-start timelines', () => {
    const custom = buildTimeline(nodes[1].fen, ['e7e5']);
    const result = compute(null, { timeline: custom, userColor: 'black', sfLookup: node => sfFixture(node.fen) });
    expect(result.qualities[0]).toBeDefined();
  });
  it('settles non-critical badges without Maia but holds engine-critical praise for it', () => {
    const line = buildTimeline(START_FEN, ['e2e4']);
    const [beforeNode, afterNode] = reviewNodes(line);
    const critical = { ...sfFixture(beforeNode.fen), best_move: 'e2e4', score: { type: 'cp' as const, value: 50 },
      lines: [{ move: 'e2e4', score: { type: 'cp' as const, value: 50 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp' as const, value: -300 }, depth: 12 }] };
    const held = { ...sfFixture(afterNode.fen), score: { type: 'cp' as const, value: 50 } };
    const sfLookup = (node: ReviewNode) => node.ply === 0 ? critical : held;
    const maiaKey = reviewKey('maia', beforeNode, settings);
    const absent = { move: 'd2d4', top_moves: [{ move: 'd2d4', prob: 0.4 }], wdl: [0.2, 0.3, 0.5] as [number, number, number], model_used: '79m' as const, degraded: false };
    const expected = { ...absent, top_moves: [{ move: 'e2e4', prob: 0.5 }, { move: 'd2d4', prob: 0.4 }] };
    const base = { gameId: 'praise', timeline: line, userColor: 'white' as const, settings, sfLookup, maiaLookup: (_node: ReviewNode) => undefined, sfPending: new Set<string>(), maiaPending: new Set<string>(), prev: null };
    // Maia still queued: spinner, not a provisional Best.
    expect(computePlayQualities({ ...base, maiaPending: new Set([maiaKey]) }).qualities[0]?.label).toBe('Unreviewed');
    // Maia absent from the top 5 with a critical engine gap: Excellent.
    expect(computePlayQualities({ ...base, maiaLookup: () => absent }).qualities[0]?.label).toBe('Excellent');
    // Maia expects it: Best.
    expect(computePlayQualities({ ...base, maiaLookup: () => expected }).qualities[0]?.label).toBe('Best');
  });
});
