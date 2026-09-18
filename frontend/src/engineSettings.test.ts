import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings, normalizeSettings, START_FEN } from './domain';
import { initialState, reducer } from './state/index';
import { defaultStockfishSettings, normalizeStockfishSettings, stockfishPolicy, STOCKFISH_STORAGE_KEY } from './stockfishSettings';
import { fetchEvaluation, reviewKey, ReviewCoordinator } from './reviewCoordinator';
import { toStoredGame } from './serverGames';
import { KEYS } from './storage';
import { requestBodyText, testNodes } from './testUtils';
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
});

it('defaults new games to 1 while preserving legacy and saved-game temperatures', () => {
  expect(initialState().setup?.temperature).toBe(1);
  for (const temperature of [undefined, 0, .7]) {
    localStorage.setItem(KEYS.current, JSON.stringify({ id: 'saved', createdAt: '2026-09-11T00:00:00Z', moves: ['e2e4'], settings: { ...defaultSettings, temperature } }));
    let state = initialState();
    expect(state.play.settings.temperature).toBe(temperature ?? 0);
    expect(state.request?.payload.temperature).toBe(temperature ?? 0);
    state = reducer(state, { type: 'setup' });
    expect(state.setup?.temperature).toBe(1);
    state = reducer(state, { type: 'setup', draft: { temperature: .5 } });
    state = reducer(state, { type: 'setup', draft: { eloMaia: 1700 } });
    expect(state.setup?.temperature).toBe(.5);
    state = reducer(state, { type: 'cancel-setup' });
    expect(state.play.settings.temperature).toBe(temperature ?? 0);
    state = reducer(state, { type: 'new', id: 'new', createdAt: '2026-09-11T00:00:00Z' });
    expect(state.play.settings.temperature).toBe(1);
  }
});

it('commits temperature per game, leaves analysis deterministic, and preserves play across settings', () => {
  let state = reducer(initialState(), { type: 'setup', draft: { temperature: .7, userColor: 'black' } });
  state = reducer(state, { type: 'new', id: 'temperature', createdAt: '2026-09-11T00:00:00Z' });
  expect(state.request?.payload.temperature).toBe(.7);
  const play = state.play;
  state = reducer(state, { type: 'mode', mode: 'settings' });
  expect(state.request).toBeNull();
  expect(reducer(state, { type: 'move', from: 'e2', to: 'e4' })).toBe(state);
  expect(reducer(state, { type: 'view', ply: 0 })).toBe(state);
  state = reducer(state, { type: 'mode', mode: 'play' });
  expect(state.play).toBe(play);
  expect(state.request?.payload.temperature).toBe(.7);
  state = reducer(state, { type: 'review' });
  expect(state.analysisSettings).not.toHaveProperty('temperature');
  expect(state.request).toBeNull();
});

it('restores and validates browser settings and legacy temperature', () => {
  localStorage.setItem(STOCKFISH_STORAGE_KEY, JSON.stringify({ time_ms: 4000, lines: 5, depth: 20 }));
  expect(initialState('settings').stockfish).toEqual({ time_ms: 4000, lines: 5, depth: 20 });
  expect(normalizeStockfishSettings({ time_ms: Infinity, lines: 0, depth: 41 })).toEqual(defaultStockfishSettings);
  expect(normalizeSettings({ temperature: NaN }).temperature).toBe(0);
  expect(normalizeSettings({ temperature: 2 }).temperature).toBe(2);
  const row = { id: 'a', created_at: '2026-09-11T00:00:00Z', updated_at: 'now', user_color: 'white', elo_maia: 1600, elo_user: 1600, model: '79m', moves: [], temperature: .7 };
  expect(toStoredGame(row)?.settings.temperature).toBe(.7);
});

it('separates Stockfish cache identity while retaining Maia cache identity', () => {
  const node = testNodes(START_FEN, [])[0];
  const settings = { ...defaultSettings, stockfish: defaultStockfishSettings };
  const changed = { ...settings, stockfish: { time_ms: 30000, lines: 5, depth: 40 } };
  expect(stockfishPolicy(settings.stockfish)).toBe('sf19-ms750-mpv2-d0-t4-h128-v3');
  expect(stockfishPolicy(changed.stockfish)).toBe('sf19-ms30000-mpv5-d40-t4-h128-v3');
  expect(reviewKey('sf', node, changed)).not.toBe(reviewKey('sf', node, settings));
  expect(reviewKey('maia', node, changed)).toBe(reviewKey('maia', node, settings));
  // Coverage derives from these same keys: a settings change misses the old
  // rows without any parallel freshness record.
  expect(reviewKey('sf', node, { ...settings, eloMaia: 1800 })).toBe(reviewKey('sf', node, settings));
});

it('sends requested options and rejects a response from another search policy', async () => {
  const settings = { time_ms: 2000, lines: 1, depth: 12 };
  const node = testNodes(START_FEN, [])[0];
  const score = { type: 'cp', value: 12 };
  const body = { engine: 'Stockfish 19', search_policy: stockfishPolicy(settings), depth: 12, terminal: null, best_move: 'e2e4', score, lines: [{ move: 'e2e4', score, depth: 12 }] };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body)));
  await fetchEvaluation(node, new AbortController().signal, fetcher, settings);
  expect(JSON.parse(requestBodyText(fetcher.mock.calls[0][1])).settings).toEqual(settings);
  body.search_policy = stockfishPolicy(defaultStockfishSettings);
  await expect(fetchEvaluation(node, new AbortController().signal, fetcher, settings)).rejects.toThrow('incompatible search settings');
});

it('primes terminal positions with the selected policy without engine requests', async () => {
  const fen = '7k/6Q1/6K1/8/8/8/8/8 b - - 1 1';
  const node = testNodes(fen, [])[0];
  const fetcher = vi.fn();
  const coordinator = new ReviewCoordinator(fetcher);
  const settings = { ...defaultSettings, stockfish: { time_ms: 30000, lines: 5, depth: 40 } };
  expect(await coordinator.ensure([node], settings, { signal: new AbortController().signal })).toEqual({ covered: 1, total: 1 });
  expect(coordinator.result('sf', node, settings)?.search_policy).toBe(stockfishPolicy(settings.stockfish));
  expect(fetcher).not.toHaveBeenCalled();
});
