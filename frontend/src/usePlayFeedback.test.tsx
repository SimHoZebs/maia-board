import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewCoordinator } from './reviewCoordinator';
import { SEARCH_POLICY, type Evaluation } from './reviewMetrics';
import { feedbackKey, lastUserPly, qualityAtPly } from './usePlayFeedback';
import { initialState, reducer } from './state';
import { KEYS } from './storage';
import { loadLine } from './domain';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
});

describe('last user ply', () => {
  it('picks the most recent ply by the user side', () => {
    expect(lastUserPly([], 'white')).toBe(-1);
    expect(lastUserPly(['e2e4'], 'white')).toBe(0);
    expect(lastUserPly(['e2e4'], 'black')).toBe(-1);
    expect(lastUserPly(['e2e4', 'e7e5'], 'white')).toBe(0);
    expect(lastUserPly(['e2e4', 'e7e5'], 'black')).toBe(1);
    expect(lastUserPly(['e2e4', 'e7e5', 'g1f3'], 'white')).toBe(2);
  });
  it('keys on move identity so same-ply replays refetch', () => {
    expect(feedbackKey('game', 0, 'e2e4')).not.toBe(feedbackKey('game', 0, 'd2d4'));
    expect(feedbackKey('game', 0, 'e2e4')).toBe(feedbackKey('game', 0, 'e2e4'));
  });
});

describe('feedback setting', () => {
  it('defaults off and round-trips through storage', () => {
    expect(initialState().feedback).toBe(false);
    const on = reducer(initialState(), { type: 'feedback', enabled: true });
    expect(on.feedback).toBe(true);
    expect(reducer(on, { type: 'feedback', enabled: true })).toBe(on);
    localStorage.setItem(KEYS.feedback, JSON.stringify(true));
    expect(initialState().feedback).toBe(true);
  });
});

const evaluation = (move: string, value: number): Evaluation => ({
  engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: move,
  score: { type: 'cp', value },
  lines: [{ move, score: { type: 'cp', value }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: value - 20 }, depth: 12 }],
});

describe('per-ply qualities', () => {
  const byMoves = (entries: [string[], Evaluation][]) => {
    const map = new Map(entries.map(([slice, evaluation]) => [JSON.stringify(slice), evaluation]));
    return (slice: string[]) => map.get(JSON.stringify(slice));
  };
  it('rates user plies and leaves opponent plies iconless', () => {
    const moves = ['e2e4', 'e7e5'];
    const lookup = byMoves([
      [[], evaluation('e2e4', 20)],
      [['e2e4'], evaluation('e7e5', 15)],
      [['e2e4', 'e7e5'], evaluation('g1f3', 10)],
    ]);
    expect(qualityAtPly(moves, 0, 'white', lookup)?.label).toBe('Best');
    expect(qualityAtPly(moves, 1, 'white', lookup)).toBeUndefined();
    expect(qualityAtPly(moves, 1, 'black', lookup)?.label).toBe('Best');
    expect(qualityAtPly(moves, 0, 'black', lookup)).toBeUndefined();
  });
  it('stays iconless while either evaluation is missing', () => {
    const moves = ['e2e4'];
    expect(qualityAtPly(moves, 0, 'white', byMoves([[[], evaluation('e2e4', 20)]]))).toBeUndefined();
    expect(qualityAtPly(moves, 0, 'white', byMoves([[['e2e4'], evaluation('e2e4', 20)]]))).toBeUndefined();
    expect(qualityAtPly(moves, 0, 'white', () => undefined)).toBeUndefined();
  });
  it('follows takebacks by ply alignment', () => {
    const lookup = byMoves([
      [[], evaluation('e2e4', 20)],
      [['e2e4'], evaluation('e2e4', 20)],
      [['d2d4'], evaluation('d2d4', 10)],
    ]);
    expect(qualityAtPly(['e2e4'], 0, 'white', lookup)?.label).toBe('Best');
    // Same ply, different move: the old evaluation no longer applies.
    expect(qualityAtPly(['d2d4'], 0, 'white', lookup)?.label).toBe('Good');
    expect(qualityAtPly(['e2e4', 'e7e5'], 0, 'white', lookup)?.label).toBe('Best');
  });
});

const sfBody = {
  engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'e2e4',
  score: { type: 'cp', value: 20 },
  lines: [{ move: 'e2e4', score: { type: 'cp', value: 20 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: -20 }, depth: 12 }],
};
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe('sf-only foreground', () => {
  it('never fetches Maia moves', async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url).split('?')[0]);
      if (String(url).startsWith('/evaluations/')) return Response.json({ code: 'not_found' }, { status: 404 });
      return Response.json(sfBody);
    }) as unknown as typeof fetch;
    const line = loadLine('', '1. e4 e5');
    const nodes = line.timeline.map(position => ({ ...position, initialFen: line.initialFen }));
    const settings = { eloMaia: 1600, eloUser: 1600, model: '79m' as const };
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.foregroundSfOnly([nodes[0], nodes[1]], settings);
    await flush(); await flush();
    expect(urls).not.toContain('/move');
    expect(urls).toContain('/evaluate');
    expect(coordinator.result('sf', nodes[0], settings)?.depth).toBe(12);
    expect(coordinator.result('maia', nodes[0], settings)).toBeUndefined();
  });
  it('resolves terminals locally and retries failures with stockfish only', async () => {
    const urls: string[] = [];
    let failures = 1;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url).split('?')[0]);
      if (String(url).startsWith('/evaluations/')) return Response.json({ code: 'not_found' }, { status: 404 });
      if (failures > 0) { failures--; return Response.json({ message: 'busy' }, { status: 500 }); }
      return Response.json(sfBody);
    }) as unknown as typeof fetch;
    const terminal = loadLine('', '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8');
    const terminalNode = { ...terminal.timeline.at(-1)!, initialFen: terminal.initialFen };
    const settings = { eloMaia: 1600, eloUser: 1600, model: '79m' as const };
    const quiet = new ReviewCoordinator(fetcher);
    quiet.foregroundSfOnly([terminalNode], settings);
    await flush();
    expect(quiet.result('sf', terminalNode, settings)?.terminal).toBe('draw');
    const line = loadLine('', '1. e4');
    const nodes = line.timeline.map(position => ({ ...position, initialFen: line.initialFen }));
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.foregroundSfOnly([nodes[0]], settings);
    await flush(); await flush();
    expect(coordinator.error('sf', nodes[0], settings)).toBeDefined();
    urls.length = 0;
    coordinator.retrySfOnly([nodes[0]], settings);
    await flush(); await flush();
    expect(coordinator.result('sf', nodes[0], settings)?.depth).toBe(12);
    expect(urls).not.toContain('/move');
  });
});
