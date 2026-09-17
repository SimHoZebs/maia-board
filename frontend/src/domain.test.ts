import { Chess } from 'chess.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyUci, buildTimeline, lineRecord, replay, resetTimelinesForTests, START_FEN } from './domain';

afterEach(() => vi.restoreAllMocks());
describe('bounded canonical timeline', () => {
  it('builds cold replay and its cached timeline in one history walk', () => {
    resetTimelinesForTests();
    const moves = ['e2e4', 'e7e5', 'g1f3'];
    const apply = vi.spyOn(Chess.prototype, 'move');
    const game = replay(moves);
    expect(apply).toHaveBeenCalledTimes(3);
    const timeline = buildTimeline(START_FEN, moves);
    expect(timeline.rows[3].fen).toBe(game.fen());
    expect(apply).toHaveBeenCalledTimes(3);
    const next = replay(moves);
    expect(apply).toHaveBeenCalledTimes(6);
    applyUci(next, 'b8c6');
    expect(game.history()).toHaveLength(3);
    expect(timeline.moves).toEqual(moves);
  });
  it('shares full-prefix row identity through extensions, branches and takebacks', () => {
    resetTimelinesForTests();
    const first = buildTimeline(START_FEN, ['e2e4', 'e7e5']);
    const extension = buildTimeline(START_FEN, ['e2e4', 'e7e5', 'g1f3']);
    const branch = buildTimeline(START_FEN, ['e2e4', 'c7c5']);
    expect(extension.rows[2]).toBe(first.rows[2]);
    expect(branch.rows[1]).toBe(first.rows[1]);
    expect(branch.rows[2]).not.toBe(first.rows[2]);
    expect(branch.rows[2].fen).not.toBe(first.rows[2].fen);
    expect(buildTimeline(START_FEN, ['e2e4']).rows[1]).toBe(first.rows[1]);
    expect(buildTimeline(START_FEN, [...first.moves])).toBe(first);
    expect(lineRecord(first.moves).fen).toBe(first.rows[2].fen);
  });
  it('releases old content-cache identities after the bounded retention window', () => {
    resetTimelinesForTests();
    const original = buildTimeline(START_FEN, []);
    for (let clock = 1; clock <= 65; clock++) buildTimeline(START_FEN.replace('0 1', `${clock} 1`), []);
    const rebuilt = buildTimeline(START_FEN, []);
    expect(rebuilt).not.toBe(original);
    expect(rebuilt.rows[0]).not.toBe(original.rows[0]);
    expect(rebuilt.rows[0].fen).toBe(original.rows[0].fen);
  });
  it.each([
    [START_FEN, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']],
    [START_FEN, ['f2f3', 'e7e5', 'g2g4', 'd8h4']],
    ['r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['e1g1', 'e8c8']],
    ['7k/8/8/3pP3/8/8/8/K7 w - d6 0 1', ['e5d6']],
    ['8/P7/7k/8/8/8/8/7K w - - 0 1', ['a7a8q']],
    ['8/8/8/8/8/7k/p7/7K b - - 0 1', ['a2a1n']],
  ] satisfies [string, string[]][])('matches independent history facts for %s', (fen, moves) => {
    const timeline = buildTimeline(fen, moves), game = new Chess(fen);
    timeline.rows.forEach((row, ply) => {
      const applied = ply ? applyUci(game, moves[ply - 1]) : undefined;
      expect(row.fen).toBe(game.fen());
      expect(row.san).toBe(applied?.san ?? '');
      expect(row.turn).toBe(game.turn() === 'w' ? 'white' : 'black');
      expect(row.lastMove).toEqual(applied ? [applied.from, applied.to] : undefined);
      expect(row.outcome !== null).toBe(game.isGameOver());
      if (game.isCheckmate()) expect(row.outcome).toEqual({ kind: 'checkmate', winner: game.turn() === 'w' ? 'black' : 'white' });
    });
  });
  it('never equates repeated boards or mutable caller arrays with their previous histories', () => {
    const moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8'];
    const timeline = buildTimeline(START_FEN, moves);
    expect(timeline.rows[0]).not.toBe(timeline.rows[4]);
    moves.push(...moves);
    const repeated = buildTimeline(START_FEN, moves);
    expect(timeline.moves).toHaveLength(4);
    expect(repeated.rows[8].outcome).toEqual({ kind: 'draw' });
    expect(new Chess(repeated.rows[8].fen).isThreefoldRepetition()).toBe(false);
    expect(() => { timeline.rows[0].fen = 'poison'; }).toThrow();
    expect(() => applyUci(new Chess(), 'e2e4junk')).toThrow();
  });
});
