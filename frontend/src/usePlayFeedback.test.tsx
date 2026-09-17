import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computePlayQualities, getNavigatorOnLine, hasExhaustedPlayRetries, isOfflineNow, isOfflineValue, PLAY_RETRY_EXHAUSTED_MESSAGE, playExhaustedError, wantedPlayPair, type PlayQualitiesMemo } from './usePlayFeedback';
import { computeReviewQualities, translateReviewQualities } from './useReview';
import { qualityGlyphs } from './ReviewCharts';
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

describe('wantedPlayPair', () => {

  const pairNodes = (moves: string[]) => reviewNodes(buildTimeline(START_FEN, moves));
  it('selects nothing without nodes or without a move to grade', () => {
    expect(wantedPlayPair([], 'white')).toEqual({ sfNodes: [], maiaNode: null });
    expect(wantedPlayPair(pairNodes([]), 'white')).toEqual({ sfNodes: [], maiaNode: null });
    expect(wantedPlayPair(pairNodes([]), 'black')).toEqual({ sfNodes: [], maiaNode: null });
  });
  it('grades the newest move: SF pair plus Maia for a user mover', () => {
    const nodes = pairNodes(['e2e4']);
    expect(wantedPlayPair(nodes, 'white')).toEqual({ sfNodes: [nodes[0], nodes[1]], maiaNode: nodes[0] });
  });
  it('skips the Maia fetch when the newest move is the opponent reply', () => {
    const nodes = pairNodes(['e2e4', 'e7e5']);
    const pair = wantedPlayPair(nodes, 'white');
    expect(pair.sfNodes).toEqual([nodes[1], nodes[2]]);
    expect(pair.maiaNode).toBeNull();
  });
  it('mirrors sides for black', () => {
    const mover = pairNodes(['e2e4']);
    expect(wantedPlayPair(mover, 'black').maiaNode).toBeNull();
    const replied = pairNodes(['e2e4', 'e7e5']);
    const pair = wantedPlayPair(replied, 'black');
    expect(pair.sfNodes).toEqual([replied[1], replied[2]]);
    expect(pair.maiaNode).toBe(replied[1]);
  });
});

describe('play retry offline/exhaustion helpers', () => {
  it('treats only explicit offline as offline', () => {
    expect(isOfflineValue(false)).toBe(true);
    expect(isOfflineValue(true)).toBe(false);
    expect(isOfflineValue(undefined)).toBe(false);
    expect(isOfflineValue(null)).toBe(false);
    expect(isOfflineValue(0)).toBe(false);
  });
  it('reads navigator onLine guarded (no window in vitest node env)', () => {
    expect(getNavigatorOnLine()).toBeUndefined();
    expect(isOfflineNow()).toBe(false);
  });
  it('supports injectable online reads and never throws', () => {
    expect(isOfflineNow(() => false)).toBe(true);
    expect(isOfflineNow(() => true)).toBe(false);
    expect(isOfflineNow(() => undefined)).toBe(false);
    expect(isOfflineNow(() => { throw new Error('boom'); })).toBe(false);
  });
  it('exhausts exactly at the capped attempt budget', () => {
    expect(hasExhaustedPlayRetries(0)).toBe(false);
    expect(hasExhaustedPlayRetries(2)).toBe(false);
    expect(hasExhaustedPlayRetries(3)).toBe(true);
    expect(hasExhaustedPlayRetries(99)).toBe(true);
  });
  it('surfaces an error only with failures present at the cap', () => {
    expect(playExhaustedError(false, 3)).toBeUndefined();
    expect(playExhaustedError(true, 2)).toBeUndefined();
    expect(playExhaustedError(true, 0)).toBeUndefined();
    expect(playExhaustedError(true, 3)).toBe(PLAY_RETRY_EXHAUSTED_MESSAGE);
    expect(playExhaustedError(true, 4)).toBe(PLAY_RETRY_EXHAUSTED_MESSAGE);
  });
});

describe('settled badges only use labels the badge can render', () => {
  const settings: ReviewSettings = { eloMaia: 1600, eloUser: 1600, model: '79m', stockfish: defaultStockfishSettings };
  const glyphs = new Set(Object.keys(qualityGlyphs));
  // Engine Top (best move, no drama) and Holds (not best, nothing lost):
  // a line with no Critical anywhere must still translate both, or the
  // badge renders its gray box with no glyph.
  const topBefore: Evaluation = { engine: 'Stockfish 19', search_policy: 'sf19-n100k-ms750-mpv2-t1-h64-v1', terminal: null, depth: 12, best_move: 'e2e4', score: { type: 'cp', value: 50 },
    lines: [{ move: 'e2e4', score: { type: 'cp', value: 50 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: 30 }, depth: 12 }] };
  const topAfter: Evaluation = { ...topBefore, lines: topBefore.lines };
  const holdsBefore: Evaluation = { engine: 'Stockfish 19', search_policy: 'sf19-n100k-ms750-mpv2-t1-h64-v1', terminal: null, depth: 12, best_move: 'e2e4', score: { type: 'cp', value: 50 },
    lines: [{ move: 'e2e4', score: { type: 'cp', value: 50 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: 48 }, depth: 12 }] };
  const holdsAfter: Evaluation = { ...holdsBefore, score: { type: 'cp', value: 48 }, lines: holdsBefore.lines.map(line => ({ ...line })) };
  it('translates Top to Best and Holds to Good in play without any Critical', () => {
    const top = computePlayQualities({ gameId: 'glyphs', timeline: buildTimeline(START_FEN, ['e2e4']), userColor: 'white', settings,
      sfLookup: node => node.ply === 0 ? topBefore : topAfter, maiaLookup: () => undefined,
      sfPending: new Set(), maiaPending: new Set(), prev: null });
    expect(top.qualities[0]?.label).toBe('Best');
    const holds = computePlayQualities({ gameId: 'glyphs', timeline: buildTimeline(START_FEN, ['d2d4']), userColor: 'white', settings,
      sfLookup: node => node.ply === 0 ? holdsBefore : holdsAfter, maiaLookup: () => undefined,
      sfPending: new Set(), maiaPending: new Set(), prev: null });
    expect(holds.qualities[0]?.label).toBe('Good');
    for (const quality of [...top.qualities, ...holds.qualities]) {
      if (quality && quality.label !== 'Unreviewed') expect(glyphs.has(quality.label)).toBe(true);
    }
  });
  it('translates engine-only labels in review as well', () => {
    const timeline = buildTimeline(START_FEN, ['d2d4']);
    const nodes = reviewNodes(timeline);
    const raw = computeReviewQualities({ line: timeline, nodes,
      evaluations: [holdsBefore, holdsAfter], settingsForNode: () => settings, pending: new Set(), prev: null });
    expect(raw.qualities[0]?.label).toBe('Holds');
    const qualities = translateReviewQualities({ grades: raw.qualities, nodes,
      maiaResults: [undefined, undefined], rarities: [undefined, undefined],
      settingsForNode: () => settings, isMaiaPending: () => false });
    expect(qualities[0]?.label).toBe('Good');
    if (qualities[0] && qualities[0].label !== 'Unreviewed') expect(glyphs.has(qualities[0].label)).toBe(true);
  });
});
