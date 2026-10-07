import { describe, expect, it } from 'vitest';
import { buildKeyMoves, formatKeyDelta, formatProb, keyHeads, keyRowOrder, type KeyMove } from './keyMoves';
import { candidateSan } from '../shared/domain';

describe('buildKeyMoves', () => {
  const wdl = (expected: number): [number, number, number] => [0, 2 * (1 - expected / 100), 2 * (expected / 100) - 1].map(v => Math.max(0, v)) as [number, number, number];
  // Simpler: construct WDL triples with exact expectations via win + draw/2.
  const triple = (win: number, draw: number): [number, number, number] => [Math.max(0, 1 - win - draw), draw, win];

  it('merges shared moves into one row each', () => {
    const moves = buildKeyMoves({
      sfBest: 'e2e4',
      objective: {
        entries: [
          { uci: 'd2d4', expected: 55, prob: 0.4 },
          { uci: 'e2e4', expected: 60, prob: 0.3 },
          { uci: 'c2c4', expected: 50, prob: 0.1 },
        ],
        degraded: false,
      },
      displayTopMoves: [
        { move: 'e2e4', prob: 0.2, wdl: triple(0.5, 0.2) },
        { move: 'g1f3', prob: 0.5, wdl: triple(0.5, 0.2) },
      ],
      played: 'g1f3',
      beforeExpected: 52,
      trueDeltaByUci: new Map([['e2e4', { value: 8, pending: false }]]),
    });
    // Backbone runners-up without a role (c2c4) and display-only extras stay
    // out; the played move rows even when listed nowhere else.
    expect(moves.map(m => m.uci)).toEqual(['e2e4', 'd2d4', 'g1f3']);
    expect(moves[0].roles).toEqual(['sf-best', 'best-2400']);
    expect(moves[1].roles).toEqual(['likely-2400']);
    expect(moves[2].roles).toEqual(['played']);
    expect(moves[0].delta).toBe(8);
    expect(moves[0].probMine).toBe(0.2);
    expect(moves[2].prob2400).toBeNull();
  });

  it('floats an unlisted Stockfish best above the 2400 list', () => {
    const moves = buildKeyMoves({
      sfBest: 'h2h4',
      objective: { entries: [{ uci: 'e2e4', expected: 55, prob: 0.5 }], degraded: false },
      displayTopMoves: [],
      played: undefined,
      beforeExpected: 50,
      trueDeltaByUci: new Map(),
    });
    expect(moves.map(m => m.uci)).toEqual(['h2h4', 'e2e4']);
    expect(moves[0].roles).toEqual(['sf-best']);
    expect(moves[1].roles).toEqual(['best-2400', 'likely-2400']);
  });

  it('rows a distinct my-likely move without flair', () => {
    const moves = buildKeyMoves({
      sfBest: 'e2e4',
      objective: { entries: [{ uci: 'e2e4', expected: 60, prob: 0.6 }], degraded: false },
      displayTopMoves: [{ move: 'd2d4', prob: 0.5, wdl: triple(0.5, 0.2) }],
      played: 'e2e4',
      beforeExpected: 55,
      trueDeltaByUci: new Map(),
    });
    expect(moves.map(m => m.uci)).toEqual(['e2e4', 'd2d4']);
    expect(moves[0].roles).toEqual(['sf-best', 'best-2400', 'likely-2400', 'played']);
    expect(moves[1].roles).toEqual([]);
    expect(moves[1].probMine).toBe(0.5);
    expect(moves[1].prob2400).toBeNull();
  });

  it('keeps distinct best vs likely when policy and value disagree', () => {
    const moves = buildKeyMoves({
      sfBest: null,
      objective: {
        entries: [
          { uci: 'd2d4', expected: 50, prob: 0.5 },
          { uci: 'e2e4', expected: 60, prob: 0.2 },
        ],
        degraded: false,
      },
      displayTopMoves: [],
      played: 'd2d4',
      beforeExpected: 52,
      trueDeltaByUci: new Map(),
    });
    expect(moves.map(m => m.uci)).toEqual(['e2e4', 'd2d4']);
    expect(moves[0].roles).toEqual(['best-2400']);
    expect(moves[1].roles).toEqual(['likely-2400', 'played']);
  });

  it('falls back to the prospective delta while the child row is pending', () => {
    const moves = buildKeyMoves({
      sfBest: 'e2e4',
      objective: { entries: [{ uci: 'e2e4', expected: 60, prob: 0.5 }], degraded: false },
      displayTopMoves: [],
      played: undefined,
      beforeExpected: 55,
      trueDeltaByUci: new Map([['e2e4', { value: null, pending: true }]]),
    });
    expect(moves[0].delta).toBeNull();
    expect(moves[0].deltaPending).toBe(true);
    expect(formatKeyDelta(moves[0])).toBe('…');
    expect(moves[0].prospective).toBeCloseTo(5);
  });

  it('formats missing shares as em-dash', () => {
    expect(formatProb(null)).toBe('—');
    expect(formatProb(0.156)).toBe('16%');
  });

  it('reads heads and orders at most five rows', () => {
    const objective = {
      entries: [
        { uci: 'd2d4', expected: 55, prob: 0.4 },
        { uci: 'e2e4', expected: 60, prob: 0.3 },
      ],
      degraded: false,
    };
    const display = [
      { move: 'g1f3', prob: 0.5, wdl: triple(0.5, 0.2) },
      { move: 'e2e4', prob: 0.2, wdl: triple(0.5, 0.2) },
    ];
    expect(keyHeads(objective, display)).toEqual({ best2400: 'e2e4', likely2400: 'd2d4', myLikely: 'g1f3' });
    expect(keyRowOrder({ sfBest: 'c2c4', best2400: 'e2e4', likely2400: 'd2d4', myLikely: 'g1f3', played: 'd2d4' }))
      .toEqual(['c2c4', 'e2e4', 'd2d4', 'g1f3']);
  });

  it('uses display expectations for SF-best moves 2400 never lists', () => {
    const display = [{ move: 'h2h4', prob: 0.05, wdl: triple(0.55, 0.2) }];
    const moves = buildKeyMoves({
      sfBest: 'h2h4',
      objective: { entries: [{ uci: 'e2e4', expected: 55, prob: 0.5 }], degraded: false },
      displayTopMoves: display,
      played: 'h2h4',
      beforeExpected: 50,
      trueDeltaByUci: new Map(),
    });
    expect(moves.map(m => m.uci)).toEqual(['h2h4', 'e2e4']);
    // 0.55 win + 0.1 draw-half = 65% expected, minus 50 baseline = +15.
    expect(moves[0].expected2400).toBeCloseTo(65);
    expect(moves[0].prospective).toBeCloseTo(15);
    expect(candidateSan('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'h2h4')).toBe('h4');
  });
});
