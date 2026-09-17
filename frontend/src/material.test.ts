import { describe, expect, it } from 'vitest';
import { bestLineMaterialNote, bestLinePreview, capturesFromLine, capturedLabel, materialFromFen, materialLeadFor, sortCaptured } from './material';
import { START_FEN } from './domain';

describe('material', () => {
  it('starts even with no captures', () => {
    expect(materialFromFen(START_FEN)).toEqual({ white: 39, black: 39, diff: 0 });
    expect(capturesFromLine(START_FEN, [])).toEqual({ white: [], black: [] });
  });

  it('tracks a pawn capture and the pawn lead', () => {
    const moves = ['e2e4', 'd7d5', 'e4d5'];
    const captures = capturesFromLine(START_FEN, moves);
    expect(captures).toEqual({ white: ['p'], black: [] });
    const fen = 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
    expect(materialFromFen(fen).diff).toBe(1);
    expect(materialLeadFor(1, 'white')).toBe(1);
    expect(materialLeadFor(1, 'black')).toBe(-1);
  });

  it('rewinds captures to the viewed ply', () => {
    const moves = ['e2e4', 'd7d5', 'e4d5', 'd8d5'];
    expect(capturesFromLine(START_FEN, moves, 3)).toEqual({ white: ['p'], black: [] });
    expect(capturesFromLine(START_FEN, moves, 4)).toEqual({ white: ['p'], black: ['p'] });
    expect(capturesFromLine(START_FEN, moves, 0)).toEqual({ white: [], black: [] });
  });

  it('sorts captures queen-first, bishops before knights', () => {
    expect(sortCaptured(['p', 'q', 'n', 'b', 'r', 'p'])).toEqual(['q', 'r', 'b', 'n', 'p', 'p']);
  });

  it('handles en passant as a pawn capture', () => {
    const moves = ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6'];
    expect(capturesFromLine(START_FEN, moves)).toEqual({ white: ['p'], black: [] });
  });

  it('ignores pieces already missing from a custom start', () => {
    const initialFen = 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    expect(capturesFromLine(initialFen, [])).toEqual({ white: [], black: [] });
    expect(materialFromFen(initialFen).diff).toBe(0);
  });

  it('counts a promoted queen in material but not as a capture', () => {
    const captures = capturesFromLine('8/P7/7k/8/8/8/8/7K w - - 0 1', ['a7a8q']);
    expect(captures).toEqual({ white: [], black: [] });
    expect(materialFromFen('Q6k/8/8/8/8/8/8/7K b - - 0 1').diff).toBe(9);
  });

  it('labels captures and the lead for screen readers', () => {
    expect(capturedLabel('white', ['q', 'p', 'p'], 11)).toBe('White captured 1 queen, 2 pawns, up 11 pawns');
    expect(capturedLabel('black', [], 0)).toBe('Black has captured nothing');
  });
});

describe('bestLineMaterialNote', () => {
  it('names a hanging pawn won in the best line', () => {
    expect(bestLineMaterialNote('4k3/8/4p3/3P4/8/8/8/4K3 b - - 0 1', ['e6d5'], 'white'))
      .toBe('This line wins a pawn for Black.');
  });

  it('names an exchange loss without net when both sides capture', () => {
    expect(bestLineMaterialNote('4k3/8/8/8/8/4n3/8/3RK3 b - - 0 1', ['e3d1', 'e1d1'], 'white'))
      .toBe('This line loses a rook for a knight.');
  });

  it('stays silent for positional windows with no material swing', () => {
    expect(bestLineMaterialNote(START_FEN, ['e2e4', 'e7e5'], 'white')).toBeNull();
  });

  it('phrases the swing, not the absolute lead, when already ahead', () => {
    expect(bestLineMaterialNote('4k3/8/4p3/3P4/7Q/8/8/4K3 b - - 0 1', ['e6d5'], 'white'))
      .toBe('This line wins a pawn for Black.');
  });

  it('silences promotions, illegal PVs, and missing lines', () => {
    expect(bestLineMaterialNote('7k/P7/8/8/8/8/8/4K3 w - - 0 1', ['a7a8q'], 'white')).toBeNull();
    expect(bestLineMaterialNote(START_FEN, ['e2e9'], 'white')).toBeNull();
    expect(bestLineMaterialNote(START_FEN, undefined, 'white')).toBeNull();
    expect(bestLineMaterialNote(START_FEN, [], 'white')).toBeNull();
  });

  it('bounds the claim to a 3-ply window', () => {
    const note = bestLineMaterialNote('4k3/8/4p3/3P4/8/8/8/4K3 b - - 0 1', ['e6d5', 'e1e2', 'e8e7', 'e2e3'], 'white');
    expect(note).toBe('This line wins a pawn for Black.');
  });
});

describe('bestLinePreview', () => {
  it('bundles the note with numbered SAN for the same window', () => {
    const preview = bestLinePreview('4k3/8/4p3/3P4/8/8/8/4K3 b - - 0 1', ['e6d5'], 'white');
    expect(preview?.note).toBe('This line wins a pawn for Black.');
    expect(preview?.ucis).toEqual(['e6d5']);
    expect(preview?.sans).toEqual(['exd5']);
    expect(preview?.text).toBe('1… exd5');
  });

  it('numbers a multi-ply window from the after-FEN turn', () => {
    const preview = bestLinePreview('4k3/8/8/8/8/4n3/8/3RK3 b - - 0 1', ['e3d1', 'e1d1'], 'white');
    expect(preview?.note).toBe('This line loses a rook for a knight.');
    expect(preview?.sans).toEqual(['Nxd1', 'Kxd1']);
    expect(preview?.text).toBe('1… Nxd1 2. Kxd1');
  });

  it('stays silent exactly when the note does', () => {
    expect(bestLinePreview(START_FEN, ['e2e4', 'e7e5'], 'white')).toBeNull();
    expect(bestLinePreview('7k/P7/8/8/8/8/8/4K3 w - - 0 1', ['a7a8q'], 'white')).toBeNull();
    expect(bestLinePreview(START_FEN, ['e2e9'], 'white')).toBeNull();
    expect(bestLinePreview(START_FEN, undefined, 'white')).toBeNull();
  });
});

describe('bestLineForkNote', () => {
  const forkFen = '4k3/8/8/5n2/8/1Q6/2B5/4K3 b - - 0 1';
  const forkPv = ['f5d4', 'b3c3', 'd4c2'];
  it('names the fork and the falling piece', () => {
    expect(bestLineMaterialNote(forkFen, forkPv, 'white'))
      .toBe("Nd4 forks White's bishop and queen, losing the bishop.");
  });

  it('keeps the preview line agreeing with the fork note', () => {
    const preview = bestLinePreview(forkFen, forkPv, 'white');
    expect(preview?.note).toBe("Nd4 forks White's bishop and queen, losing the bishop.");
    expect(preview?.ucis).toEqual(forkPv);
    expect(preview?.sans).toEqual(['Nd4', 'Qc3', 'Nxc2+']);
    expect(preview?.text).toBe('1… Nd4 2. Qc3 2… Nxc2+');
  });

  it('names royal forks with the king first', () => {
    const royalFen = '4k3/8/8/8/8/3n4/8/3Q3K b - - 0 1';
    const royalPv = ['d3f2', 'h1h2', 'f2d1'];
    expect(bestLineMaterialNote(royalFen, royalPv, 'white'))
      .toBe("Nf2+ forks White's king and queen, losing the queen.");
    const preview = bestLinePreview(royalFen, royalPv, 'white');
    expect(preview?.sans).toEqual(['Nf2+', 'Kh2', 'Nxd1']);
    expect(preview?.text).toBe('1… Nf2+ 2. Kh2 2… Nxd1');
    expect(preview?.note).toBe("Nf2+ forks White's king and queen, losing the queen.");
  });

  it('falls back to generic when the forked piece does not fall', () => {
    // Nd4 attacks bishop and queen, but White evacuates the bishop and the
    // knight takes the queen instead: the composition no longer matches the
    // fork claim. (Pawn-only and capture-first-move fallbacks ride on the
    // hanging-pawn and exchange cases above.)
    expect(bestLineMaterialNote(forkFen, ['f5d4', 'c2b1', 'd4b3'], 'white'))
      .toBe('This line wins a queen for Black.');
  });

  it('falls back to generic when the first move captures the forked type', () => {
    // Nxd5 takes a bishop outright, then attacks queen and bishop: the
    // bishop counted as "lost" was taken on the fork move itself, not won
    // through fork pressure, so the generic composition holds.
    expect(bestLineMaterialNote('4k3/8/8/3B4/5n2/2Q1B3/8/4K3 b - - 0 1', ['f4d5', 'c3b3', 'e8e7'], 'white'))
      .toBe('This line wins a bishop for Black.');
  });
});
