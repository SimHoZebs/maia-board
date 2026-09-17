import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { MaiaApiError, type MoveResponse } from './api';
import { absoluteWdl, analysisLine, buildTimeline, defaultSettings, exportExplored, exportLine, extendLine, legalPrefixLength, lineRecord, lineRecordMissesForTests, loadLine, positionOf, replay, resetLineRecordsForTests, resetTimelinesForTests, resultTextForTip, retreatLine, START_FEN, terminalFlags, timelineBuildsForTests } from './domain';
import { testNodes } from './testUtils';
import { computeReviewQualities, type ReviewQualitiesMemo, type ReviewQualitiesStats } from './useReview';
import { reviewKey, type ReviewNode } from './reviewCoordinator';
import { terminalEvaluation, type Evaluation } from './reviewMetrics';
import { outcomeEvaluation } from './outcomeEvaluation';
import { HistorySyncStore } from './syncStore';
import type { RepositorySnapshot } from './gameRepository';
import { currentPosition, initialState, reducer, snapshotOf } from './state';
import { KEYS, restoreGame } from './storage';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
});
const response: MoveResponse = { move: 'e7e5', top_moves: [], wdl: [0.2, 0.3, 0.5], model_used: '79m', degraded: false };
const started = () => reducer(initialState(), { type: 'new', id: 'test', createdAt: '2026-09-10' });

describe('request ownership', () => {
  it('retains the accepted fallback identity and ignores stale replies after a newer identity', () => {
    const pending = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    const firstRequest = pending.request!;
    expect(firstRequest.payload.model).toBe('79m');
    const fallback: MoveResponse = { ...response, model_used: '5m', degraded: true };
    const accepted = reducer(pending, { type: 'reply', request: firstRequest, response: fallback });
    expect(accepted.play.moves).toEqual(['e2e4', 'e7e5']);
    expect(accepted.insight).toEqual({ response: fallback, fen: firstRequest.payload.fen, mode: 'play' });
    expect(accepted.play.settings.model).toBe('79m');
    const next = reducer(accepted, { type: 'move', from: 'g1', to: 'f3' });
    expect(next.insight).toBeNull();
    const latestResponse: MoveResponse = { ...response, move: 'b8c6' };
    const latest = reducer(next, { type: 'reply', request: next.request!, response: latestResponse });
    expect(latest.insight?.response).toBe(latestResponse);
    expect(reducer(latest, { type: 'reply', request: firstRequest, response: fallback })).toBe(latest);
    expect(reducer(accepted, { type: 'takeback' }).insight).toBeNull();
    expect(reducer(accepted, { type: 'new', id: 'fresh', createdAt: '2026-09-14' }).insight).toBeNull();
  });
  it.each(['play', 'analysis', 'history'] as const)('initializes %s before deciding whether to resume Maia', mode => {
    const game = { id: 'pending', createdAt: '2026-09-10', moves: ['e2e4'], settings: defaultSettings };
    localStorage.setItem(KEYS.current, JSON.stringify(game));
    const state = initialState(mode);
    expect(state.mode).toBe(mode);
    expect(state.play).toEqual(game);
    expect(state.started).toBe(true);
    if (mode === 'play') expect(state.request?.payload.moves).toEqual(['e2e4']);
    else expect(state.request).toBeNull();
  });
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
    expect(state.play.settings.eloMaia).toBe(1600);
    expect(currentPosition(reducer(state, { type: 'view', ply: null })).moves).toEqual(state.play.moves);
  });
  it('analysis ratings retire play requests and leave analysis inference to its owner', () => {
    const playing = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    const request = playing.request!;
    let state = reducer(playing, { type: 'review' });
    state = reducer(state, { type: 'analysis-settings', settings: { eloMaia: 2200 } });
    expect(state.request).toBeNull();
    expect(state.insight).toBeNull();
    expect(reducer(state, { type: 'reply', request, response })).toBe(state);
    expect(state.request).toBeNull();
    expect(state.analysisSettings.eloMaia).toBe(2200);
    expect(state.play.settings.eloMaia).toBe(1600);
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
    expect(currentPosition(state).moves).toEqual(['e2e4', 'c7c5', 'd2d4']);
    expect(replay(currentPosition(state).moves).fen()).toBe(currentPosition(state).fen);
    expect(state.request).toBeNull();
    state = reducer(state, { type: 'original' });
    expect(state.analysis.branchFromPly).toBeNull();
    expect(state.analysis.index).toBe(1);
    expect(state.analysis.moves).toHaveLength(3);
  });
  it('advances from the fork back onto the original line, dropping the branch', () => {
    let state = reducer(started(), { type: 'mode', mode: 'analysis' });
    state = reducer(state, { type: 'inputs', inputs: { pgn: '1. e4 e5 2. Nf3' } });
    state = reducer(state, { type: 'load' });
    state = reducer(state, { type: 'view', ply: 1 });
    state = reducer(state, { type: 'move', from: 'c7', to: 'c5' });
    expect(state.analysis.branchFromPly).toBe(1);
    // Notation clicks still enter the branch.
    state = reducer(state, { type: 'view', ply: 1 });
    state = reducer(state, { type: 'view', ply: 2 });
    expect(analysisLine(state.analysis).moves).toEqual(['e2e4', 'c7c5']);
    // Next from the fork continues the original instead.
    state = reducer(state, { type: 'view', ply: 1 });
    state = reducer(state, { type: 'advance' });
    expect(state.analysis.branchFromPly).toBeNull();
    expect(state.analysis.branchMoves).toEqual([]);
    expect(state.analysis.index).toBe(2);
    expect(analysisLine(state.analysis).moves).toEqual(['e2e4', 'e7e5']);
    // Plain advance without a branch steps forward.
    state = reducer(state, { type: 'advance' });
    expect(state.analysis.index).toBe(3);
  });
  it('explores candidate UCI moves without a promotion dialog', () => {
    let state = reducer(started(), { type: 'mode', mode: 'analysis' });
    state = reducer(state, { type: 'inputs', inputs: { pgn: '1. e4 e5 2. Nf3' } });
    state = reducer(state, { type: 'load' });
    state = reducer(state, { type: 'preview', uci: 'g8f6' });
    state = reducer(state, { type: 'explore', uci: 'g8f6' });
    expect(state.preview).toBeNull();
    expect(state.analysis.branchFromPly).toBe(3);
    expect(analysisLine(state.analysis).moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'g8f6']);
    expect(state.analysis.index).toBe(4);
    expect(state.promotion).toBeNull();
    // Same UCI from either engine list lands on the same branch tip.
    const replayed = reducer({ ...state, analysis: { ...state.analysis, index: 3, branchFromPly: null, branchMoves: [] } }, { type: 'explore', uci: 'g8f6' });
    expect(analysisLine(replayed.analysis).moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'g8f6']);
  });
  it('spawns a PV branch from the verdict line and lands on its first move', () => {
    let state = reducer(started(), { type: 'mode', mode: 'analysis' });
    state = reducer(state, { type: 'inputs', inputs: { pgn: '1. e4 e5 2. Nf3' } });
    state = reducer(state, { type: 'load' });
    // At the tip (ply 3, Black to move): the verdict PV Nxd4-style line.
    state = reducer(state, { type: 'explore-line', ucis: ['b8c6', 'f1c4'] });
    expect(state.analysis.branchFromPly).toBe(3);
    expect(state.analysis.branchMoves).toEqual(['b8c6', 'f1c4']);
    expect(state.analysis.index).toBe(4);
    expect(analysisLine(state.analysis).moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6']);
    expect(state.preview).toBeNull();
    // Stepping forward enters the rest of the spawned line.
    state = reducer(state, { type: 'view', ply: 5 });
    expect(analysisLine(state.analysis).moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
    // Illegal and empty lines never branch.
    const illegal = reducer(state, { type: 'explore-line', ucis: ['e2e9'] });
    expect(illegal).toBe(state);
    const empty = reducer(state, { type: 'explore-line', ucis: [] });
    expect(empty).toBe(state);
  });
  it('extends a branch tip, replaces from its root, and guards pre-fork origins', () => {
    let state = reducer(started(), { type: 'mode', mode: 'analysis' });
    state = reducer(state, { type: 'inputs', inputs: { pgn: '1. e4 e5 2. Nf3' } });
    state = reducer(state, { type: 'load' });
    state = reducer(state, { type: 'explore-line', ucis: ['b8c6', 'f1c4'] });
    // Extend from the branch tip: prefix preserved, cursor lands on the new
    // first move (second click from inside a spawned verdict line).
    state = reducer(state, { type: 'view', ply: 5 });
    state = reducer(state, { type: 'explore-line', ucis: ['g8f6'] });
    expect(state.analysis.branchFromPly).toBe(3);
    expect(state.analysis.branchMoves).toEqual(['b8c6', 'f1c4', 'g8f6']);
    expect(state.analysis.index).toBe(6);
    expect(analysisLine(state.analysis).moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'g8f6']);
    // Spawn from the branch root: the old tail is replaced, not appended.
    state = reducer(state, { type: 'view', ply: 3 });
    state = reducer(state, { type: 'explore-line', ucis: ['g8f6'] });
    expect(state.analysis.branchFromPly).toBe(3);
    expect(state.analysis.branchMoves).toEqual(['g8f6']);
    expect(state.analysis.index).toBe(4);
    // Before the fork: same guard as single-explore, branch preserved.
    state = reducer(state, { type: 'view', ply: 1 });
    const guarded = reducer(state, { type: 'explore-line', ucis: ['d7d5'] });
    expect(guarded.error).toBe('Step forward to the branching point before exploring from an earlier position.');
    expect(guarded.analysis.branchFromPly).toBe(3);
    expect(guarded.analysis.branchMoves).toEqual(['g8f6']);
    expect(guarded.analysis.index).toBe(1);
  });
  it('defaults the best-line window to 3 and normalizes the rest', () => {
    expect(initialState().bestLineWindow).toBe(3);
    const state = reducer(initialState(), { type: 'best-line-window', window: 5 });
    expect(state.bestLineWindow).toBe(5);
    expect(reducer(state, { type: 'best-line-window', window: 5 })).toBe(state);
    expect(reducer(state, { type: 'best-line-window', window: 99 }).bestLineWindow).toBe(3);
  });
  it('restores the persisted best-line window', () => {
    localStorage.setItem(KEYS.bestLineWindow, JSON.stringify(5));
    expect(initialState().bestLineWindow).toBe(5);
    localStorage.setItem(KEYS.bestLineWindow, JSON.stringify('wide'));
    expect(initialState().bestLineWindow).toBe(3);
  });
  it('loads shared analysis links without resetting an identical line', () => {
    let state = reducer(initialState(), { type: 'mode', mode: 'analysis' });
    state = reducer(state, { type: 'inputs', inputs: { pgn: '1. e4 e5' } });
    state = reducer(state, { type: 'load' });
    const loaded = state.analysis;
    state = reducer(state, { type: 'view', ply: 1 });
    const kept = reducer(state, { type: 'url-line', initialFen: loaded.initialFen, moves: loaded.moves });
    expect(kept).toBe(state);
    expect(kept.analysis.index).toBe(1);
    const switched = reducer(state, { type: 'url-line', initialFen: START_FEN, moves: ['d2d4'] });
    expect(switched.analysis.moves).toEqual(['d2d4']);
    expect(switched.analysis.index).toBe(1);
    expect(switched.analysisLoaded).toBe(true);
  });
  it('boots shared links over the snapshot but keeps its cursor on match', () => {
    localStorage.setItem(KEYS.snapshot, JSON.stringify(snapshotOf({ ...loadLine('', '1. e4 e5'), index: 1 })));
    const matched = initialState('analysis', { initialFen: START_FEN, moves: ['e2e4', 'e7e5'] });
    expect(matched.analysisLoaded).toBe(true);
    expect(matched.analysis.index).toBe(1);
    const linked = initialState('analysis', { initialFen: START_FEN, moves: ['d2d4'] });
    expect(linked.analysis.moves).toEqual(['d2d4']);
    expect(linked.analysis.index).toBe(1);
    expect(linked.analysisSourceId).toBeNull();
  });
  it('replays custom-start black promotion with the complete analysis history', () => {
    let state = reducer(started(), { type: 'mode', mode: 'analysis' });
    const fen = '4k3/8/8/8/8/8/p6P/4K3 b - - 0 12';
    state = reducer(state, { type: 'inputs', inputs: { fen } });
    state = reducer(state, { type: 'load' });
    state = reducer(state, { type: 'move', from: 'a2', to: 'a1' });
    state = reducer(state, { type: 'promote', piece: 'n' });
    expect(currentPosition(state).moves).toEqual(['a2a1n']);
    expect(replay(currentPosition(state).moves, fen).fen()).toBe(currentPosition(state).fen);
    expect(new Chess(currentPosition(state).fen).turn()).toBe('w');
    expect(state.request).toBeNull();
  });
  it('deleting the current saved record clears its current storage source', () => {
    const played = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    const deleted = reducer(played, { type: 'delete', id: played.play.id });
    expect(deleted.play.moves).toEqual([]);
    expect(deleted.saved).toEqual([]);
    expect(deleted.request).toBeNull();
  });
  it('ends a repetition draw using full game history', () => {
    const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
    localStorage.setItem(KEYS.current, JSON.stringify({ id: 'draw', createdAt: 'today', moves, settings: defaultSettings }));
    const state = initialState();
    expect(replay(moves).isThreefoldRepetition()).toBe(true);
    expect(reducer(state, { type: 'move', from: 'e2', to: 'e4' })).toBe(state);
  });
  it('scopes the review summary to the played side', () => {
    expect(loadLine().perspective).toBe('white');
    expect(loadLine('4k3/8/8/8/8/8/4P3/4K3 b - - 0 12').perspective).toBe('black');
    const game = { id: 'g', createdAt: '2026-09-10', moves: ['e2e4'], settings: { ...defaultSettings, userColor: 'black' as const } };
    const reviewed = reducer({ ...initialState(), saved: [game] }, { type: 'review', id: 'g' });
    expect(reviewed.analysis.perspective).toBe('black');
    expect(reviewed.analysis.ownGame).toBe(true);
  });
  it('defaults analysis Elo/model to the reviewed game and pins its source', () => {
    const game = { id: 'elo-game', createdAt: '2026-09-10', moves: ['e2e4', 'e7e5'], settings: { ...defaultSettings, eloMaia: 2000, eloUser: 2000, model: '5m' as const } };
    const base = { ...initialState(), saved: [game] };
    expect(base.analysisSettings.eloMaia).toBe(1600);
    const reviewed = reducer(base, { type: 'review', id: 'elo-game' });
    expect(reviewed.analysisSettings.eloMaia).toBe(2000);
    expect(reviewed.analysisSettings.model).toBe('5m');
    expect(reviewed.analysisSourceId).toBe('elo-game');
    // Reviewing the live game without an id still seeds from play settings.
    const live = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    const liveReviewed = reducer(live, { type: 'review' });
    expect(liveReviewed.analysisSettings.eloMaia).toBe(live.play.settings.eloMaia);
    expect(liveReviewed.analysisSourceId).toBe(live.play.id);
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
    expect(state.play.id).toBe('old'); expect(state.play.settings).toEqual(settings);
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
    expect(restored.moves.slice(0, 1)).toEqual(['e8d7']);
    expect(restored.sanMoves).toEqual(['Kd7', 'e4']);
  });
  it('parses comments, variations, UCI and PGN while rejecting illegal tokens', () => {
    expect(loadLine('', '1. e4 {comment} (1. d4 (1... d5)) e7e5 $1 2. Nf3 ; note\n*').moves).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(() => loadLine('', '1. e5')).toThrow('Could not read PGN move "e5".');
  });
});

describe('server sync', () => {
  const serverGame = (id: string, moves: string[] = []) => ({ id, createdAt: '2026-09-10', moves, settings: defaultSettings });
  it('preserves live request identity and historical cursor on same-tip hydration', () => {
    const live = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    const viewing = reducer(live, { type: 'view', ply: 0 });
    const { userColor, model, eloMaia, eloUser, temperature } = viewing.play.settings;
    const hydratedGame = { ...viewing.play, settings: { temperature, model, eloUser, eloMaia, userColor } };
    const next = reducer(viewing, { type: 'sync', saved: [hydratedGame], currentId: viewing.play.id, pending: [], total: 1 });
    expect(next.request).toBe(live.request);
    expect(next.viewedPly).toBe(0);
    const failed = reducer(next, { type: 'failure', request: live.request!, error: new Error('offline') });
    const hydrated = reducer(failed, { type: 'sync', saved: [{ ...failed.play }], currentId: failed.play.id, pending: [], total: 1 });
    expect(hydrated.request).toBeNull();
    expect(hydrated.error).toBe(failed.error);
  });
  it('adopts the server current game and requeues a Maia turn', () => {
    const state = reducer(initialState(), {
      type: 'sync', saved: [serverGame('s', ['e2e4'])], currentId: 's', total: 1, pending: [],
    });
    expect(state.play.id).toBe('s');
    expect(state.started).toBe(true);
    expect(state.request?.payload.moves).toEqual(['e2e4']);
  });
  it('retires the current game when its repository delete is projected', () => {
    const local = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    const next = reducer(local, { type: 'sync', saved: [], currentId: null, total: 0, pending: [{ op: 'delete', id: local.play.id }] });
    expect(next.started).toBe(false);
    expect(next.saved).toEqual([]);
    expect(next.request).toBeNull();
  });
  it('keeps unsynced local edits over the server snapshot', () => {
    const local = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    const pending = [{ op: 'save', game: local.play, current: true }] as const;
    const next = reducer(local, {
      type: 'sync', saved: [serverGame('other')], currentId: 'other', total: 1,
      pending: [...pending],
    });
    expect(next.play.moves).toEqual(['e2e4']);
    expect(next.saved.map(game => game.id)).toEqual(['test', 'other']);
    expect(next.request).toBe(local.request);
  });
  it('starts fresh when the server has no current game', () => {
    const state = reducer(initialState(), { type: 'sync', saved: [serverGame('s')], currentId: null, total: 1, pending: [] });
    expect(state.started).toBe(false);
    expect(state.play.moves).toEqual([]);
    expect(state.setup).not.toBeNull();
  });
  it('keeps a cache-seeded game when the server is empty', () => {
    const game = { id: 'cache', createdAt: '2026-09-10', moves: ['e2e4'], settings: defaultSettings };
    localStorage.setItem(KEYS.current, JSON.stringify(game));
    const state = reducer(initialState(), { type: 'sync', saved: [], currentId: null, total: 0, pending: [] });
    expect(state.play.id).toBe('cache');
    expect(state.started).toBe(true);
  });
  it('keeps history beyond the old eight-game cap', () => {
    let state = initialState();
    const games = Array.from({ length: 12 }, (_, index) => serverGame(`g${index}`, ['e2e4']));
    state = reducer(state, { type: 'sync', saved: games, currentId: null, total: 12, pending: [] });
    expect(state.saved).toHaveLength(12);
  });
});

describe('resign', () => {
  it('ends the game, retires the pending reply, and blocks further play', () => {
    const pending = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    expect(pending.request).not.toBeNull();
    const resigned = reducer(pending, { type: 'resign' });
    expect(resigned.play.result).toBe('resigned');
    expect(resigned.request).toBeNull();
    expect(resigned.saved[0].result).toBe('resigned');
    // Stale Maia reply is rejected by request identity.
    expect(reducer(resigned, { type: 'reply', request: pending.request!, response })).toBe(resigned);
    expect(reducer(resigned, { type: 'move', from: 'd2', to: 'd4' })).toBe(resigned);
    expect(reducer(resigned, { type: 'takeback' })).toBe(resigned);
    expect(reducer(resigned, { type: 'resign' })).toBe(resigned);
  });
  it('is a no-op before start or after checkmate', () => {
    const fresh = initialState();
    expect(reducer(fresh, { type: 'resign' })).toBe(fresh);
    const mate = { id: 'mate', createdAt: '2026-09-10', moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], settings: defaultSettings };
    localStorage.setItem(KEYS.current, JSON.stringify(mate));
    const over = initialState();
    expect(replay(over.play.moves).isCheckmate()).toBe(true);
    expect(reducer(over, { type: 'resign' })).toBe(over);
  });
});

describe('line records', () => {
  beforeEach(() => { resetLineRecordsForTests(); });
  const italian = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'];

  it('matches replay ground truth for fen, SAN, last move, and terminality', () => {
    const record = lineRecord(italian);
    const truth = replay(italian);
    expect(record.fen).toBe(truth.fen());
    expect(record.moves).toEqual(italian);
    expect(record.sanMoves).toEqual(truth.history());
    expect(record.lastMove).toEqual(['f1', 'c4']);
    expect(record.terminal).toBeNull();
  });

  it('extends with exactly one replay for the new tip', () => {
    lineRecord(italian);
    expect(lineRecordMissesForTests()).toBe(1);
    const { moves, record } = extendLine(italian, START_FEN, 'f8', 'c5');
    expect(moves).toEqual([...italian, 'f8c5']);
    // Base hit, new tip miss: the single replay this commit will ever cost.
    expect(lineRecordMissesForTests()).toBe(2);
    const truth = replay(moves);
    expect(record.fen).toBe(truth.fen());
    expect(record.sanMoves).toEqual(truth.history());
    expect(record.sanMoves.at(-1)).toBe('Bc5');
    // Re-deriving the same tip is fully shared.
    expect(extendLine(italian, START_FEN, 'f8', 'c5').record.fen).toBe(record.fen);
    expect(lineRecordMissesForTests()).toBe(2);
  });

  it('chains castling, en passant, and promotion identically to replay', () => {
    const castleBase = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'];
    const castled = extendLine(castleBase, START_FEN, 'e1', 'g1');
    expect(castled.moves.at(-1)).toBe('e1g1');
    expect(castled.record.sanMoves.at(-1)).toBe('O-O');
    expect(castled.record.fen).toBe(replay(castled.moves).fen());

    const epBase = ['e2e4', 'a7a6', 'e4e5', 'd7d5'];
    const ep = extendLine(epBase, START_FEN, 'e5', 'd6');
    expect(ep.record.sanMoves.at(-1)).toBe('exd6');
    expect(ep.record.fen).toBe(replay(ep.moves).fen());

    const promoFen = '8/2P5/8/8/1k6/8/8/4K3 w - - 0 1';
    const promo = extendLine([], promoFen, 'c7', 'c8', 'q');
    expect(promo.moves).toEqual(['c7c8q']);
    const promoTruth = replay(['c7c8q'], promoFen);
    expect(promo.record.fen).toBe(promoTruth.fen());
    expect(promo.record.sanMoves).toEqual(promoTruth.history());
  });

  it('serves takebacks from cache after incremental play with zero replays', () => {
    let moves: string[] = [];
    for (const [from, to] of [['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6']] as const) {
      moves = extendLine(moves, START_FEN, from, to).moves;
    }
    const warm = lineRecordMissesForTests();
    const { moves: back, record } = retreatLine(moves, START_FEN, 2);
    expect(back).toEqual(['e2e4', 'e7e5']);
    expect(record.fen).toBe(replay(back).fen());
    expect(record.sanMoves).toEqual(replay(back).history());
    expect(lineRecordMissesForTests()).toBe(warm);
  });

  it('falls back to one replay for cold takebacks', () => {
    const { moves, record } = retreatLine(['e2e4', 'e7e5', 'g1f3'], START_FEN, 1);
    expect(moves).toEqual(['e2e4', 'e7e5']);
    expect(record.fen).toBe(replay(moves).fen());
    expect(lineRecordMissesForTests()).toBe(1);
  });

  it('agrees with replay on terminality incl. repetition, stalemate, and fifty-move', () => {
    const repetition = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
    expect(lineRecord(repetition).terminal?.terminal).toBe('draw');
    // A FEN-parsed instance misses the repetition: the trap the memo avoids.
    expect(new Chess(lineRecord(repetition).fen).isGameOver()).toBe(false);
    expect(lineRecord(['f2f3', 'e7e5', 'g2g4', 'd8h4']).terminal?.terminal).toBe('black_win');
    expect(lineRecord([], 'k7/8/1Q6/8/8/8/8/7K b - - 0 1').terminal?.terminal).toBe('draw');
    expect(lineRecord([], 'k7/8/8/8/8/8/8/K7 w - - 0 1').terminal?.terminal).toBe('draw');
    expect(lineRecord([], 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 100 51').terminal?.terminal).toBe('draw');
    expect(lineRecord([], START_FEN).terminal).toBeNull();
  });

  it('never derives history from a FEN-parsed instance', () => {
    const base = ['e2e4', 'e7e5', 'g1f3'];
    const truth = replay(base);
    const parsed = new Chess(truth.fen());
    parsed.move({ from: 'b8', to: 'c6' });
    expect(positionOf(parsed).sanMoves).toHaveLength(1);
    const { record } = extendLine(base, START_FEN, 'b8', 'c6');
    expect(record.sanMoves).toHaveLength(4);
    expect(record.sanMoves).toEqual(replay([...base, 'b8c6']).history());
  });

  it('isolates callers from cache mutations', () => {
    const first = lineRecord(italian);
    first.sanMoves.push('junk');
    expect(lineRecord(italian).sanMoves).toEqual(replay(italian).history());
  });

  it('renders result text without replaying', () => {
    const mate = lineRecord(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(resultTextForTip(mate.fen, mate.terminal)).toBe('Black wins');
    const stale = lineRecord([], 'k7/8/1Q6/8/8/8/8/7K b - - 0 1');
    expect(resultTextForTip(stale.fen, stale.terminal)).toBe('Draw');
    expect(resultTextForTip(lineRecord([]).fen, lineRecord([]).terminal)).toBe('Unfinished');
  });

  it('commits an own move with at most one replay and shares derivations', () => {
    let state = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    expect(state.play.moves).toEqual(['e2e4']);
    const preReply = lineRecordMissesForTests();
    state = reducer(state, { type: 'reply', request: state.request!, response });
    expect(state.play.moves).toEqual(['e2e4', 'e7e5']);
    // Reply: base hit, new tip miss — the single replay on this path too.
    expect(lineRecordMissesForTests() - preReply).toBe(1);
    // Warm steady state: the next commit resolves only its new tip.
    const warm = lineRecordMissesForTests();
    state = reducer(state, { type: 'move', from: 'g1', to: 'f3' });
    expect(state.play.moves).toEqual(['e2e4', 'e7e5', 'g1f3']);
    expect(lineRecordMissesForTests() - warm).toBeLessThanOrEqual(1);
    // Render-side derivations add zero replays and agree with ground truth.
    const settled = lineRecordMissesForTests();
    const truth = replay(state.play.moves);
    expect(currentPosition(state).fen).toBe(truth.fen());
    expect(currentPosition(state).sanMoves).toEqual(truth.history());
    expect(lineRecord(state.play.moves).fen).toBe(truth.fen());
    expect(state.request?.payload.fen).toBe(truth.fen());
    expect(lineRecordMissesForTests()).toBe(settled);
  });

  it('takes back through the reducer without replaying', () => {
    let state = reducer(started(), { type: 'move', from: 'e2', to: 'e4' });
    state = reducer(state, { type: 'reply', request: state.request!, response });
    state = reducer(state, { type: 'move', from: 'g1', to: 'f3' });
    const warm = lineRecordMissesForTests();
    // Black (Maia) to move: takeback removes one ply from a cached prefix.
    state = reducer(state, { type: 'takeback' });
    expect(state.play.moves).toEqual(['e2e4', 'e7e5']);
    expect(lineRecordMissesForTests()).toBe(warm);
  });
});

describe('history sync store', () => {
  it('notifies only when repository display values change', () => {
    const store = new HistorySyncStore();
    expect(store.pending).toBe(0);
    expect(store.error).toBe('');
    expect(store.total).toBeNull();
    const calls: number[] = [];
    const stop = store.subscribe(() => calls.push(store.snapshot()));
    const snapshot = (overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot => ({
      schema: 2, games: [], currentId: null, pending: [], recovery: [],
      error: '', durabilityError: '', conflict: false, failedVersion: null,
      total: null, nextOffset: null, loading: false, ...overrides,
    });
    store.setSnapshot(snapshot());
    store.setSnapshot(snapshot());
    expect(calls).toHaveLength(0);
    const pendingOps = [
      { op: 'delete', id: 'a', version: 'v1' },
      { op: 'delete', id: 'b', version: 'v2' },
      { op: 'delete', id: 'c', version: 'v3' },
    ] satisfies RepositorySnapshot['pending'];
    store.setSnapshot(snapshot({ pending: pendingOps }));
    store.setSnapshot(snapshot({ pending: pendingOps, error: 'down' }));
    store.setSnapshot(snapshot({ pending: pendingOps, error: 'down', total: 12 }));
    expect(store.pending).toBe(3);
    expect(store.error).toBe('down');
    expect(store.total).toBe(12);
    expect(calls).toHaveLength(3);
    store.setSnapshot(snapshot({ pending: pendingOps, error: '', total: 12 }));
    expect(store.error).toBe('');
    stop();
  });
  it('keeps sync display state out of the game reducer', () => {
    const state = initialState();
    expect('syncError' in state).toBe(false);
    expect('syncPending' in state).toBe(false);
    expect('historyTotal' in state).toBe(false);
  });
});

describe('terminal flags', () => {
  const agreement = (initialFen: string, moves: string[]) => {
    const flags = terminalFlags(initialFen, moves);
    expect(flags).toHaveLength(moves.length + 1);
    for (let index = 0; index <= moves.length; index++) {
      const expected = terminalEvaluation(replay(moves.slice(0, index), initialFen)) !== undefined;
      expect(flags[index]).toBe(expected);
    }
  };

  it('matches per-prefix replays incl. mates, stalemate, and repetition', () => {
    agreement(START_FEN, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
    agreement(START_FEN, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    agreement(START_FEN, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
    agreement('k7/8/1Q6/8/8/8/8/7K b - - 0 1', []);
    agreement('k7/8/8/8/8/8/8/K7 w - - 0 1', []);
    agreement('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 100 51', []);
    agreement('4k3/8/8/8/8/8/p6P/4K3 b - - 0 12', ['a2a1n']);
    const mates = terminalFlags(START_FEN, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    expect(mates.at(-1)).toBe(true);
    expect(mates.slice(0, -1)).toEqual([false, false, false, false]);
    expect(terminalFlags(START_FEN, []).at(-1)).toBe(false);
  });
});

describe('canonical timeline', () => {
  it('matches per-prefix replays for fen, turn, san, and terminality', () => {
    const lines: [string, string[]][] = [
      [START_FEN, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']],
      [START_FEN, ['f2f3', 'e7e5', 'g2g4', 'd8h4']],
      [START_FEN, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']],
      [START_FEN, []],
    ];
    for (const [initialFen, moves] of lines) {
      const timeline = buildTimeline(initialFen, moves);
      expect(timeline.rows).toHaveLength(moves.length + 1);
      for (let ply = 0; ply <= moves.length; ply++) {
        const game = replay(moves.slice(0, ply), initialFen);
        const row = timeline.rows[ply];
        const history = game.history({ verbose: true });
        const last = history.at(-1);
        expect(row.ply).toBe(ply);
        expect(row.fen).toBe(game.fen());
        expect(row.turn).toBe(game.turn() === 'w' ? 'white' : 'black');
        expect(row.san).toBe(last?.san ?? '');
        expect(row.uci).toBe(last ? `${last.from}${last.to}${last.promotion ?? ''}` : '');
        expect(row.lastMove).toEqual(last ? [last.from, last.to] : undefined);
        expect(row.outcome !== null).toBe(terminalEvaluation(game) !== undefined);
      }
    }
  });

  it('agrees with the play-tip memo on tip fen, SAN, and terminality', () => {
    const moves = ['e2e4', 'e7e5', 'g1f3', 'b8c6'];
    resetLineRecordsForTests();
    const record = lineRecord(moves);
    const timeline = buildTimeline(START_FEN, moves);
    const tip = timeline.rows.at(-1)!;
    expect(tip.fen).toBe(record.fen);
    expect(outcomeEvaluation(tip.outcome) ?? null).toEqual(record.terminal);
    expect(timeline.rows.slice(1).map(row => row.san)).toEqual(record.sanMoves);
  });

  it('builds once per line no matter how many rows are read', () => {
    resetTimelinesForTests();
    const timeline = buildTimeline(START_FEN, ['e2e4', 'e7e5', 'g1f3']);
    // A coverage-style full pass plus navigation lookups: pure row reads.
    let covered = 0;
    for (const row of timeline.rows) if (row.outcome !== null || row.fen) covered++;
    expect(timeline.rows[2].fen).toContain(' ');
    expect(covered).toBe(4);
    expect(timelineBuildsForTests()).toBe(1);
  });

  it('throws on illegal moves; legalPrefixLength narrows untrusted lines', () => {
    expect(() => buildTimeline(START_FEN, ['e2e4', 'e7e5', 'not-a-move'])).toThrow();
    expect(legalPrefixLength(START_FEN, ['e2e4', 'e7e5', 'not-a-move'])).toBe(2);
    expect(legalPrefixLength(START_FEN, ['e2e4', 'e7e5'])).toBe(2);
    const narrowed = buildTimeline(START_FEN, ['e2e4', 'e7e5', 'not-a-move'].slice(0, 2));
    expect(narrowed.rows).toHaveLength(3);
  });
});

describe('review qualities incremental', () => {
  const settings = { eloMaia: 1600, eloUser: 1600, model: '79m' as const };
  const evaluation = (move: string, value: number): Evaluation => ({
    engine: 'Stockfish 19', search_policy: 'sf19-n100k-ms750-mpv2-t4-h128-v3', depth: 12, terminal: null, best_move: move,
    score: { type: 'cp', value },
    lines: [{ move, score: { type: 'cp', value }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: value - 20 }, depth: 12 }],
  });
  const italianMoves = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'];
  const italianNodes = testNodes(START_FEN, italianMoves);
  const italianEvals: [string[], Evaluation][] = [
    [[], evaluation('e2e4', 20)],
    [['e2e4'], evaluation('e7e5', 15)],
    [['e2e4', 'e7e5'], evaluation('g1f3', 10)],
    [['e2e4', 'e7e5', 'g1f3'], evaluation('b8c6', 12)],
    [['e2e4', 'e7e5', 'g1f3', 'b8c6'], evaluation('f1c4', 8)],
    [['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'], evaluation('d7d5', 6)],
  ];
  const byNodes = (entries: [string[], Evaluation][]) => {
    const map = new Map(entries.map(([slice, entry]) => [JSON.stringify(slice), entry]));
    return (node: ReviewNode) => map.get(JSON.stringify(node.timeline.moves.slice(0, node.ply)));
  };
  const run = (
    moves: string[],
    nodes: ReviewNode[],
    lookup: (node: ReviewNode) => Evaluation | undefined,
    prev: ReviewQualitiesMemo | null,
    pending: Set<string> = new Set(),
    stats?: ReviewQualitiesStats,
    resolve: (node: ReviewNode) => typeof settings = () => settings,
  ) => computeReviewQualities({
    line: { moves }, nodes, evaluations: nodes.map(lookup), settingsForNode: resolve, pending, prev, stats,
  });

  it('computes settled verdicts with one review per settled ply', () => {
    const stats: ReviewQualitiesStats = { reviews: 0 };
    const { qualities } = run(italianMoves, italianNodes, byNodes(italianEvals), null, new Set(), stats);
    expect(stats).toEqual({ reviews: 5 });
    expect(qualities).toHaveLength(5);
    expect(qualities[0]?.label).toBe('Top');
    expect(qualities[4]).toBeDefined();
  });

  it('reuses everything on an identical rerun', () => {
    const first = run(italianMoves, italianNodes, byNodes(italianEvals), null);
    const stats: ReviewQualitiesStats = { reviews: 0 };
    const second = run(italianMoves, italianNodes, byNodes(italianEvals), first.memo, new Set(), stats);
    expect(stats).toEqual({ reviews: 0 });
    expect(second.qualities).toBe(first.qualities);
  });

  it('settle arrival recomputes only the changed plies', () => {
    const partial = italianEvals.filter(([slice]) => JSON.stringify(slice) !== JSON.stringify(['e2e4', 'e7e5', 'g1f3']));
    const moves = ['e2e4', 'e7e5', 'g1f3'];
    const nodes = testNodes(START_FEN, moves);
    const afterNode = nodes[3];
    const pending = new Set([reviewKey('sf', afterNode, settings)]);
    const first = run(moves, nodes, byNodes(partial), null, pending);
    expect(first.qualities[0]?.label).toBe('Top');
    expect(first.qualities[2]?.label).toBe('Unreviewed');
    const stats: ReviewQualitiesStats = { reviews: 0 };
    const second = run(moves, nodes, byNodes(italianEvals), first.memo, new Set(), stats);
    expect(stats).toEqual({ reviews: 1 });
    expect(second.qualities[0]).toBe(first.qualities[0]);
    expect(second.qualities[2]).toBeDefined();
    expect(second.qualities[2]?.label).not.toBe('Unreviewed');
  });

  it('neighbor sharing only one foreground endpoint never flashes pending', () => {
    // Viewing P1 (after e4, before e5) foregrounds N0+N1 while move e5 needs
    // N1+N2. The neighbor must stay blank, not spin then disappear.
    const moves = ['e2e4', 'e7e5', 'g1f3'];
    const nodes = testNodes(START_FEN, moves);
    const key = (node: ReviewNode) => reviewKey('sf', node, settings);
    const foreground = new Set([key(nodes[0]), key(nodes[1])]);
    const cold = run(moves, nodes, () => undefined, null, foreground);
    expect(cold.qualities[0]?.label).toBe('Unreviewed');
    expect(cold.qualities[1]).toBeUndefined();
    const settled = run(moves, nodes, byNodes(italianEvals.filter(([slice]) => slice.length <= 1)), null, new Set());
    expect(settled.qualities[0]?.label).not.toBe('Unreviewed');
    expect(settled.qualities[1]).toBeUndefined();
  });

  it('matches a fresh compute exactly across build, settle, append, and takeback', () => {
    const store = new Map(italianEvals.map(([slice, entry]) => [JSON.stringify(slice), entry]));
    const lookup = (node: ReviewNode) => store.get(JSON.stringify(node.timeline.moves.slice(0, node.ply)));
    const fresh = (moves: string[]) => {
      const nodes = testNodes(START_FEN, moves);
      return computeReviewQualities({
        line: { moves }, nodes, evaluations: nodes.map(lookup),
        settingsForNode: () => settings, pending: new Set(), prev: null,
      }).qualities;
    };
    let prev: ReviewQualitiesMemo | null = null;
    const steps = [
      ['e2e4', 'e7e5'],
      ['e2e4', 'e7e5', 'g1f3'],
      ['e2e4', 'e7e5', 'g1f3', 'b8c6'],
      ['e2e4', 'e7e5'],
      ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'],
    ];
    for (const [index, moves] of steps.entries()) {
      if (index === 3) store.delete(JSON.stringify(['e2e4', 'e7e5']));
      const nodes = testNodes(START_FEN, moves);
      const next = run(moves, nodes, lookup, prev);
      expect(next.qualities).toEqual(fresh(moves));
      prev = next.memo;
    }
  });

  it('recomputes replaced eval objects even with equal values', () => {
    const moves = ['e2e4', 'e7e5'];
    const nodes = testNodes(START_FEN, moves);
    const first = run(moves, nodes, byNodes(italianEvals), null);
    // Same values, fresh objects (e.g. refetch after eviction): recompute.
    const stats: ReviewQualitiesStats = { reviews: 0 };
    const second = run(moves, nodes, byNodes(italianEvals), first.memo, new Set(), stats);
    expect(stats).toEqual({ reviews: 0 });
    expect(second.qualities).toBe(first.qualities);
    const clone = (node: ReviewNode) => {
      const found = byNodes(italianEvals)(node);
      return found && { ...found, lines: found.lines.map(line => ({ ...line, score: { ...line.score } })) };
    };
    const third = run(moves, nodes, clone, first.memo, new Set(), stats);
    expect(stats.reviews).toBeGreaterThan(0);
    expect(third.qualities).toEqual(first.qualities);
  });
});
