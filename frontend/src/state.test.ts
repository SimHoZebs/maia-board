import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MaiaApiError, type MoveResponse } from './api';
import { defaultSettings, exportLine, loadLine, replay, START_FEN } from './domain';
import { initialState, reducer } from './state';
import { KEYS, restoreGame } from './storage';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
});
const response: MoveResponse = { move: 'e7e5', top_moves: [], wdl: [0.2, 0.3, 0.5], model_used: '79m', degraded: false };

describe('request ownership', () => {
  it('rejects success and failure from another game at the same position', () => {
    const a = { id: 'a', createdAt: '2026-09-10', moves: ['e2e4'], settings: defaultSettings };
    localStorage.setItem(KEYS.current, JSON.stringify(a));
    localStorage.setItem(KEYS.saved, JSON.stringify([a, { ...a, id: 'b' }]));
    const old = initialState();
    const next = reducer(old, { type: 'saved', id: 'b' });
    expect(next.request!.payload.fen).toBe(old.request!.payload.fen);
    expect(reducer(next, { type: 'reply', request: old.request!, response })).toBe(next);
    expect(reducer(next, { type: 'failure', request: old.request!, error: new MaiaApiError('engine_busy', 'busy') })).toBe(next);
    expect(reducer(next, { type: 'reply', request: next.request!, response }).play.moves).toEqual(['e2e4', 'e7e5']);
  });
  it('rejects illegal Maia moves without changing authoritative history and settles pending', () => {
    const state = reducer(initialState(), { type: 'move', from: 'e2', to: 'e4' });
    const next = reducer(state, { type: 'reply', request: state.request!, response: { ...response, move: 'e7e4' } });
    expect(next.play.moves).toEqual(['e2e4']);
    expect(next.request).toBeNull();
    expect(next.error).toBe('Maia returned an illegal move.');
  });
  it('empty takeback replaces the saved record rather than resurrecting undone moves', () => {
    const played = reducer(initialState(), { type: 'move', from: 'e2', to: 'e4' });
    const undone = reducer(played, { type: 'takeback' });
    expect(undone.saved[0].moves).toEqual([]);
    expect(reducer(undone, { type: 'saved', id: played.play.id }).play.moves).toEqual([]);
  });
});

describe('legacy storage and analysis', () => {
  it('restores all four v1 formats including non-menu Elo values', () => {
    const settings = { ...defaultSettings, eloMaia: 1701, eloUser: 1512, model: '5m' };
    localStorage.setItem(KEYS.current, JSON.stringify({ id: 'old', createdAt: '2026-01-01', moves: ['d2d4', 'd7d5'], settings }));
    localStorage.setItem(KEYS.settings, JSON.stringify(settings));
    localStorage.setItem(KEYS.analysis, JSON.stringify({ fen: '', pgn: '1. e4 e5' }));
    const state = initialState();
    expect(state.play.id).toBe('old'); expect(state.settings).toEqual(settings);
    expect(state.analysis.index).toBe(2); expect(state.analysis.moves).toEqual(['e2e4', 'e7e5']);
  });
  it('handles corrupt storage without losing access to the board', () => {
    localStorage.setItem(KEYS.current, JSON.stringify({ id: 'bad', moves: ['e2e8'] }));
    localStorage.setItem(KEYS.saved, '{}');
    localStorage.setItem(KEYS.analysis, JSON.stringify({ fen: 'invalid', pgn: '' }));
    const state = initialState();
    expect(state.play.moves).toEqual([]); expect(state.saved).toEqual([]);
    expect(state.analysis.initialFen).toBe(START_FEN); expect(state.inputs.fen).toBe('invalid');
    expect(restoreGame({ moves: 'not an array' })).toBeUndefined();
  });
  it('round-trips custom-start PGN with history and black to move', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 b - - 0 12';
    const line = loadLine(fen, '12... Kd7 13. e4');
    const restored = loadLine('', exportLine(line));
    expect(restored).toEqual(line);
    expect(restored.timeline[1].moves).toEqual(['e8d7']);
    expect(restored.timeline[2].fen).toBe(replay(restored.moves, fen).fen());
  });
  it('parses comments, variations, UCI and PGN while rejecting illegal tokens', () => {
    expect(loadLine('', '1. e4 {comment} (1. d4 (1... d5)) e7e5 $1 2. Nf3 ; note\n*').moves).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(() => loadLine('', '1. e5')).toThrow('Could not read PGN move "e5".');
  });
});
