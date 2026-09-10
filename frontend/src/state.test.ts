import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MaiaApiError, type MoveResponse } from './api';
import { absoluteWdl, analysisLine, defaultSettings, exportExplored, exportLine, loadLine, replay, START_FEN } from './domain';
import { currentPosition, initialState, reducer } from './state';
import { KEYS, restoreGame } from './storage';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
});
const response: MoveResponse = { move: 'e7e5', top_moves: [], wdl: [0.2, 0.3, 0.5], model_used: '79m', degraded: false };
const started = () => reducer(initialState(), { type: 'new', id: 'test', createdAt: '2026-09-10' });

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
    const state = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    const next = reducer(state, { type: 'reply', request: state.request!, response: { ...response, move: 'e7e4' } });
    expect(next.play.moves).toEqual(['e2e4']);
    expect(next.request).toBeNull();
    expect(next.error).toBe('Maia returned an illegal move.');
  });
  it('empty takeback replaces the saved record rather than resurrecting undone moves', () => {
    const played = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    const undone = reducer(played, { type: 'takeback' });
    expect(undone.saved[0].moves).toEqual([]);
    expect(reducer(undone, { type: 'saved', id: played.play.id }).play.moves).toEqual([]);
  });
});

describe('task lifecycles', () => {
  it('waits for Start and commits one rating atomically', () => {
    const setup = reducer(initialState(), { type: 'setup', draft: { userColor: 'black', eloMaia: 1800 } });
    expect(setup.request).toBeNull();
    expect(reducer(setup, { type: 'move', from: 'e2', to: 'e4' }).play.moves).toEqual([]);
    const game = reducer(setup, { type: 'new', id: 'new', createdAt: 'today' });
    expect(game.setup).toBeNull();
    expect(game.request?.payload).toMatchObject({ elo_maia: 1800, elo_user: 1800, maia_color: 'white' });
  });
  it('historical navigation and setup cancel preserve a live reply', () => {
    const pending = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    let state = reducer(pending, { type: 'view', ply: 0 });
    state = reducer(state, { type: 'setup', draft: { eloMaia: 2000 } });
    expect(state.request).toBe(pending.request);
    state = reducer(state, { type: 'reply', request: pending.request!, response });
    state = reducer(state, { type: 'cancel-setup' });
    expect(state.play.moves).toEqual(['e2e4', 'e7e5']);
    expect(currentPosition(state).moves).toEqual([]);
    expect(state.settings.eloMaia).toBe(1600);
    expect(currentPosition(reducer(state, { type: 'view', ply: null })).moves).toEqual(state.play.moves);
  });
  it('analysis ratings retire results and requests without changing play settings', () => {
    let state = reducer(started(), { type: 'review' });
    state = reducer(state, { type: 'analyze' });
    const request = state.request!;
    state = reducer(state, { type: 'analysis-settings', settings: { eloMaia: 2200 } });
    expect(state.request).toBeNull();
    expect(state.insight).toBeNull();
    expect(reducer(state, { type: 'reply', request, response })).toBe(state);
    state = reducer(state, { type: 'analyze' });
    expect(state.request?.payload).toMatchObject({ elo_maia: 2200, elo_user: 2200, maia_color: 'white' });
    expect(state.settings.eloMaia).toBe(1600);
  });
  it('keeps original mainline while replaying and editing one multi-ply branch', () => {
    let state = reducer(started(), { type: 'mode', mode: 'analysis' });
    state = reducer(state, { type: 'inputs', inputs: { pgn: '1. e4 e5 2. Nf3' } });
    state = reducer(state, { type: 'load' });
    state = reducer(state, { type: 'view', ply: 1 });
    state = reducer(state, { type: 'move', from: 'c7', to: 'c5' });
    state = reducer(state, { type: 'move', from: 'g1', to: 'f3' });
    expect(state.analysis.moves).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(analysisLine(state.analysis).moves).toEqual(['e2e4', 'c7c5', 'g1f3']);
    expect(exportExplored(state.analysis)).toContain('1. e4 c5 2. Nf3');
    expect(exportLine(state.analysis)).toContain('1. e4 e5 2. Nf3');
    state = reducer(state, { type: 'view', ply: 2 });
    state = reducer(state, { type: 'move', from: 'd2', to: 'd4' });
    state = reducer(state, { type: 'analyze' });
    expect(state.request!.payload.moves).toEqual(['e2e4', 'c7c5', 'd2d4']);
    expect(replay(state.request!.payload.moves).fen()).toBe(state.request!.payload.fen);
    state = reducer(state, { type: 'original' });
    expect(state.analysis.branchFromPly).toBeNull();
    expect(state.analysis.index).toBe(1);
    expect(state.analysis.moves).toHaveLength(3);
  });
  it('replays custom-start black promotion with the identical request history', () => {
    let state = reducer(started(), { type: 'mode', mode: 'analysis' });
    const fen = '4k3/8/8/8/8/8/p6P/4K3 b - - 0 12';
    state = reducer(state, { type: 'inputs', inputs: { fen } });
    state = reducer(state, { type: 'load' });
    state = reducer(state, { type: 'move', from: 'a2', to: 'a1' });
    state = reducer(state, { type: 'promote', piece: 'n' });
    state = reducer(state, { type: 'analyze' });
    expect(state.request!.payload.moves).toEqual(['a2a1n']);
    expect(replay(state.request!.payload.moves, fen).fen()).toBe(state.request!.payload.fen);
    expect(state.request!.payload.maia_color).toBe('white');
  });
  it('deleting the current saved record clears its current storage source', () => {
    const played = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    const deleted = reducer(played, { type: 'delete', id: played.play.id });
    expect(deleted.play.moves).toEqual([]);
    expect(deleted.saved).toEqual([]);
    expect(deleted.request).toBeNull();
  });
  it('maps choosing-side WDL to absolute colors for both request turns', () => {
    expect(absoluteWdl(START_FEN, response.wdl)).toEqual([0.5, 0.3, 0.2]);
    expect(absoluteWdl(replay(['e2e4']).fen(), response.wdl)).toEqual([0.2, 0.3, 0.5]);
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
