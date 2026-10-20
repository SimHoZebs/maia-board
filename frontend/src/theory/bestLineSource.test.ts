import { describe, expect, it } from 'vitest';
import {
  BEST_LINE_SOURCE,
  resolveBestLineUcis,
  shouldWalkMaia,
  stockfishBestLineUcis,
} from './bestLineSource';
import type { Evaluation } from '../review/reviewMetrics';

function sfEval(pv: string[] | undefined): Evaluation {
  return {
    engine: 'Stockfish 19',
    search_policy: 'sf19-n100k-ms750-mpv2-t4-h128-v3',
    depth: 12,
    terminal: null,
    best_move: pv?.[0] ?? null,
    score: { type: 'cp', value: 0 },
    lines: pv ? [{ move: pv[0], score: { type: 'cp', value: 0 }, depth: 12, pv }] : [],
  };
}

describe('bestLineSource', () => {
  it('defaults to stockfish', () => {
    expect(BEST_LINE_SOURCE).toBe('stockfish');
    expect(shouldWalkMaia()).toBe(false);
    expect(shouldWalkMaia('maia')).toBe(true);
    expect(shouldWalkMaia('stockfish')).toBe(false);
  });

  it('projects the rank-1 PV through the window', () => {
    const pv = ['a5c4', 'd2c4', 'e8e4', 'f1e1', 'g8h8', 'h2h3'];
    expect(stockfishBestLineUcis(sfEval(pv), 3)).toEqual(['a5c4', 'd2c4', 'e8e4']);
    expect(stockfishBestLineUcis(sfEval(['e2e4']), 3)).toEqual(['e2e4']);
  });

  it('returns null without a usable PV', () => {
    expect(stockfishBestLineUcis(null, 3)).toBeNull();
    expect(stockfishBestLineUcis(sfEval(undefined), 3)).toBeNull();
    expect(stockfishBestLineUcis(sfEval([]), 3)).toBeNull();
  });

  it('prefers stockfish when selected, maia otherwise', () => {
    expect(
      resolveBestLineUcis({
        source: 'stockfish',
        stockfishUcis: ['a5c4'],
        maiaUcis: ['f6e4'],
      }),
    ).toEqual(['a5c4']);
    expect(
      resolveBestLineUcis({
        source: 'maia',
        stockfishUcis: ['a5c4'],
        maiaUcis: ['f6e4'],
      }),
    ).toEqual(['f6e4']);
  });

  it('stays silent instead of crossing sources on a miss', () => {
    // Stockfish source never falls back to the Maia walk: a missing PV is
    // silence, not a cross-source substitution.
    expect(
      resolveBestLineUcis({ source: 'stockfish', stockfishUcis: null, maiaUcis: ['f6e4'] }),
    ).toBeNull();
    expect(
      resolveBestLineUcis({ source: 'maia', stockfishUcis: ['a5c4'], maiaUcis: null }),
    ).toBeNull();
  });
});
