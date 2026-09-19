import { describe, expect, it } from 'vitest';
import { BEST_LINE_WINDOW_MAX, bestLineMaterialNote, bestLinePreview, capturesFromLine, capturedLabel, DEFAULT_BEST_LINE_WINDOW, fusePinWithMate, fusePinWithMaterial, materialFromFen, materialLeadFor, normalizeBestLineWindow, playedCapture, playedMoveExchangeNote, playedMoveForkNote, playedMoveGainNote, playedMovePinNote, playedMoveSkewerNote, sortCaptured } from './material';
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

  it('bounds the claim to the default 3-ply window', () => {
    const note = bestLineMaterialNote('4k3/8/4p3/3P4/8/8/8/4K3 b - - 0 1', ['e6d5', 'e1e2', 'e8e7', 'e2e3'], 'white');
    expect(note).toBe('This line wins a pawn for Black.');
  });

  it('normalizes junk windows to the default', () => {
    expect(normalizeBestLineWindow(undefined)).toBe(DEFAULT_BEST_LINE_WINDOW);
    expect(normalizeBestLineWindow(2.5)).toBe(DEFAULT_BEST_LINE_WINDOW);
    expect(normalizeBestLineWindow(0)).toBe(DEFAULT_BEST_LINE_WINDOW);
    expect(normalizeBestLineWindow(99)).toBe(DEFAULT_BEST_LINE_WINDOW);
    expect(normalizeBestLineWindow(BEST_LINE_WINDOW_MAX)).toBe(BEST_LINE_WINDOW_MAX);
  });

  it('reads only the first ply on a window of 1', () => {
    expect(bestLineMaterialNote('4k3/8/4p3/3P4/8/8/8/4K3 b - - 0 1', ['e6d5'], 'white', 1))
      .toBe('This line wins a pawn for Black.');
  });

  it('catches slower wins on wider windows', () => {
    const slowFen = '4k3/8/8/5n2/8/1Q6/2B5/4K3 b - - 0 1';
    const slowPv = ['f5d4', 'b3c3', 'e8e7', 'c3a5', 'd4c2'];
    // The bishop falls on ply 5: the default window sees only Nd4/Qc3/Ke7.
    expect(bestLineMaterialNote(slowFen, slowPv, 'white')).toBeNull();
    expect(bestLineMaterialNote(slowFen, slowPv, 'white', 5))
      .toBe("Nd4 forks White's bishop and queen, losing the bishop.");
    const preview = bestLinePreview(slowFen, slowPv, 'white', 5);
    expect(preview?.sans).toEqual(['Nd4', 'Qc3', 'Ke7', 'Qa5', 'Nxc2+']);
    expect(preview?.text).toBe('1… Nd4 2. Qc3 2… Ke7 3. Qa5 3… Nxc2+');
  });

  it('trims trailing quiet moves after the last capture', () => {
    const fen = '4k3/8/4p3/3P4/8/8/8/4K3 b - - 0 1';
    const preview = bestLinePreview(fen, ['e6d5', 'e1e2', 'e8e7'], 'white');
    expect(preview?.note).toBe('This line wins a pawn for Black.');
    expect(preview?.ucis).toEqual(['e6d5']);
    expect(preview?.sans).toEqual(['exd5']);
    expect(preview?.text).toBe('1… exd5');
  });

  it('trims the fork line to the falling piece', () => {
    const forkFen = '4k3/8/8/5n2/8/1Q6/2B5/4K3 b - - 0 1';
    const preview = bestLinePreview(forkFen, ['f5d4', 'b3c3', 'd4c2', 'e1e2'], 'white', 4);
    // The queen retakes on c2 one ply past the window: contested, no fall.
    expect(preview?.note).toBe("Nd4 forks White's bishop and queen, but only forces an even exchange.");
    expect(preview?.ucis).toEqual(['f5d4', 'b3c3', 'd4c2']);
    expect(preview?.text).toBe('1… Nd4 2. Qc3 2… Nxc2+');
  });
});

describe('playedMoveGainNote', () => {
  it('names an immediate pawn win', () => {
    expect(playedMoveGainNote(
      'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2',
      'e4d5',
      'white',
    )).toBe('Wins a pawn.');
  });

  it('names a queen win by composition, not magnitude', () => {
    expect(playedMoveGainNote(
      '4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1',
      '4k3/8/8/3R4/8/8/8/3RK3 b - - 0 1',
      'd1d5',
      'white',
    )).toBe('Wins a queen.');
  });

  it('reads the gain for Black from Black-relative swing', () => {
    expect(playedMoveGainNote(
      '4k3/8/4p3/3P4/8/8/8/4K3 b - - 0 1',
      '4k3/8/8/3p4/8/8/8/4K3 w - - 0 1',
      'e6d5',
      'black',
    )).toBe('Wins a pawn.');
  });

  it('stays silent on quiet moves, promotions, and bad data', () => {
    expect(playedMoveGainNote(START_FEN, START_FEN, 'e2e4', 'white')).toBeNull();
    expect(playedMoveGainNote(
      '8/P7/7k/8/8/8/8/7K w - - 0 1',
      'Q6k/8/8/8/8/8/8/7K b - - 0 1',
      'a7a8q',
      'white',
    )).toBeNull();
    expect(playedMoveGainNote('bad', START_FEN, 'e2e4', 'white')).toBeNull();
    expect(playedMoveGainNote(START_FEN, START_FEN, 'e2e9', 'white')).toBeNull();
  });
});

describe('playedMoveForkNote', () => {
  const forkFen = '4k3/8/8/5n2/8/1Q6/2B5/4K3 b - - 0 1';
  it('stays silent on detected even exchanges: no fork to name', () => {
    // Mutual defense (Q guards B, B guards Q): the knight takes, the queen
    // takes back — an even exchange means there is no tactic to name.
    expect(playedMoveForkNote(forkFen, 'f5d4', 'black')).toBeNull();
  });

  it('leaves winning trades unqualified', () => {
    // The rook is defended, but knight-for-rook still wins the exchange.
    expect(playedMoveForkNote('4k3/8/8/5n2/8/1Q6/2R5/4K3 b - - 0 1', 'f5d4', 'black'))
      .toBe("Nd4 forks White's rook and queen.");
  });

  it('suppresses hanging forkers', () => {
    // White's c-pawn simply takes the knight: no fork story to tell.
    expect(playedMoveForkNote('4k3/8/8/5n2/8/1QP5/2B5/4K3 b - - 0 1', 'f5d4', 'black')).toBeNull();
    // The king eats the forker outright.
    expect(playedMoveForkNote('4k3/8/8/5n2/8/1Q2K3/2B5/8 b - - 0 1', 'f5d4', 'black')).toBeNull();
  });

  it('names royal forks with the king first', () => {
    expect(playedMoveForkNote('4k3/8/8/8/8/3n4/8/3Q3K b - - 0 1', 'd3f2', 'black'))
      .toBe("Nf2+ forks White's king and queen.");
  });

  it('rejects captures, single victims, quiet moves, and bad data', () => {
    expect(playedMoveForkNote(
      'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      'e4d5',
      'white',
    )).toBeNull();
    expect(playedMoveForkNote(START_FEN, 'e2e4', 'white')).toBeNull();
    expect(playedMoveForkNote('8/P7/7k/8/8/8/8/7K w - - 0 1', 'a7a8q', 'white')).toBeNull();
    expect(playedMoveForkNote('bad', 'e2e4', 'white')).toBeNull();
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
  it('qualifies the fork when the recapture sits past the window', () => {
    expect(bestLineMaterialNote(forkFen, forkPv, 'white'))
      .toBe("Nd4 forks White's bishop and queen, but only forces an even exchange.");
  });

  it('keeps the preview line agreeing with the fork note', () => {
    const preview = bestLinePreview(forkFen, forkPv, 'white');
    expect(preview?.note).toBe("Nd4 forks White's bishop and queen, but only forces an even exchange.");
    expect(preview?.ucis).toEqual(forkPv);
    expect(preview?.sans).toEqual(['Nd4', 'Qc3', 'Nxc2+']);
    expect(preview?.text).toBe('1… Nd4 2. Qc3 2… Nxc2+');
  });

  it('names proven exchanges with the net', () => {
    // Even: the window holds Nxc2 and Qxc2 — bishop for knight, all square.
    expect(bestLineMaterialNote(forkFen, ['f5d4', 'b3c3', 'd4c2', 'c3c2'], 'white', 4))
      .toBe("Nd4 forks White's bishop and queen, only forcing an even bishop-for-knight exchange.");
    // Winning: knight given for a defended rook still wins after the retake.
    const rookFen = '4k3/8/8/5n2/8/1Q6/2R5/4K3 b - - 0 1';
    expect(bestLineMaterialNote(rookFen, ['f5d4', 'b3c3', 'd4c2', 'c3c2'], 'white', 4))
      .toBe("Nd4 forks White's rook and queen, losing the rook for the knight.");
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

describe('playedMoveSkewerNote', () => {
  it('names a checking skewer through the king', () => {
    // Re7+ forces the king off the e-file's d7 square, uncovering the queen.
    expect(playedMoveSkewerNote('8/2qk4/8/2B5/8/8/5K2/4R3 w - - 0 1', 'e1e7', 'white'))
      .toBe("Re7+ skewers Black's king and queen.");
  });

  it('stays silent on detected even exchanges: no skewer to name', () => {
    // The knight is guarded (pawn and king): bishop for knight comes out
    // even, so there is no tactic to name.
    expect(playedMoveSkewerNote('8/8/5p2/4n3/3k4/8/8/2B4K w - - 0 1', 'c1b2', 'white')).toBeNull();
  });

  it('lets capturing checkers tell the skewer story, not the gain', () => {
    // Rxe7+ takes a pawn, but the forced evacuation outranks the fresh win.
    expect(playedMoveSkewerNote('8/2qkp3/8/2B5/8/8/5K2/4R3 w - - 0 1', 'e1e7', 'white'))
      .toBe("Rxe7+ skewers Black's king and queen.");
  });

  it('rejects quiet moves, non-sliders, and hanging checkers', () => {
    expect(playedMoveSkewerNote('8/2qk4/8/2B5/8/8/5K2/4R3 w - - 0 1', 'f2f3', 'white')).toBeNull();
    // Knight checks never skewer: no ray, no shield.
    expect(playedMoveSkewerNote('4k3/8/8/8/8/3n4/8/3Q3K b - - 0 1', 'd3f2', 'black')).toBeNull();
    // Undefended checker the king simply eats: Re7 hangs when Bc5 is gone.
    expect(playedMoveSkewerNote('8/2qk4/8/8/8/8/5K2/4R3 w - - 0 1', 'e1e7', 'white')).toBeNull();
    expect(playedMoveSkewerNote('bad', 'e1e7', 'white')).toBeNull();
  });
});

describe('bestLineSkewerNote', () => {
  const skewerFen = '8/2qk4/8/2B5/8/8/5K2/4R3 w - - 0 1';
  it('names the skewer and the falling piece', () => {
    // Rxc7 hangs to Kxc7, but queen-for-rook still wins the exchange.
    expect(bestLineMaterialNote(skewerFen, ['e1e7', 'd7c8', 'e7c7'], 'black'))
      .toBe("Re7+ skewers Black's king and queen, losing the queen.");
  });

  it('keeps the preview line agreeing with the skewer note', () => {
    const preview = bestLinePreview(skewerFen, ['e1e7', 'd7c8', 'e7c7'], 'black');
    expect(preview?.note).toBe("Re7+ skewers Black's king and queen, losing the queen.");
    expect(preview?.sans).toEqual(['Re7+', 'Kc8', 'Rxc7+']);
  });

  it('stays silent on even non-tactic windows, note and preview together', () => {
    // Bxe3/dxe3 is bishop-for-knight with no fork or skewer: the generic
    // composition has no swing to report, so nothing may claim the line.
    const evenFen = '4k3/8/8/8/3b4/4N3/3PP3/4K3 b - - 0 1';
    expect(bestLineMaterialNote(evenFen, ['d4e3', 'd2e3'], 'white')).toBeNull();
    expect(bestLinePreview(evenFen, ['d4e3', 'd2e3'], 'white')).toBeNull();
  });
});

describe('playedMovePinNote', () => {
  const pinBefore = 'r4rk1/pp1bn1pp/2n1pp2/3p4/qP1P1B2/P2B1NP1/2P3PP/R2QR1K1 w - - 1 15';
  it('names a relative pin to the rook without claiming the fall', () => {
    expect(playedMovePinNote(pinBefore, 'f4d6', 'white'))
      .toBe("Bd6 pins Black's knight to the rook.");
  });

  it('names absolute pins to the king', () => {
    expect(playedMovePinNote('4k3/8/2n5/8/2B5/8/8/4K3 w - - 0 1', 'c4b5', 'white'))
      .toBe("Bb5 pins Black's knight to the king.");
  });

  it('suppresses hanging pinners', () => {
    expect(playedMovePinNote('4k3/8/p1n5/8/2B5/8/8/4K3 w - - 0 1', 'c4b5', 'white')).toBeNull();
  });

  it('rejects captures, promotions, non-sliders, quiet moves, and bad data', () => {
    expect(playedMovePinNote(
      'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      'e4d5',
      'white',
    )).toBeNull();
    expect(playedMovePinNote('8/P7/7k/8/8/8/8/7K w - - 0 1', 'a7a8q', 'white')).toBeNull();
    expect(playedMovePinNote(START_FEN, 'e2e4', 'white')).toBeNull();
    expect(playedMovePinNote('bad', 'e2e4', 'white')).toBeNull();
  });
});

describe('fusePinConcessions', () => {
  it('fuses pins with generic lines by lowercasing This', () => {
    expect(fusePinWithMaterial(
      "Bd6 pins Black's knight to the rook.",
      'This line wins a bishop for Black.',
    )).toBe("Bd6 pins Black's knight to the rook, but this line wins a bishop for Black.");
  });

  it('keeps tactic SAN leads verbatim after but', () => {
    expect(fusePinWithMaterial(
      "Bd6 pins Black's knight to the rook.",
      "Nd4 forks White's bishop and queen, losing the bishop.",
    )).toBe("Bd6 pins Black's knight to the rook, but Nd4 forks White's bishop and queen, losing the bishop.");
  });

  it('fuses pins with mate', () => {
    expect(fusePinWithMate("Bd6 pins Black's knight to the rook."))
      .toBe("Bd6 pins Black's knight to the rook, but allows mate.");
  });
});
describe('boundaryCrossingTrades', () => {
  const bxe7After = '4rrk1/pp1bB1pp/2n1pp2/3p4/qP1P4/P2B1NP1/2P3PP/R2QR1K1 b - - 0 16';
  it('reads the played take, not just the window', () => {
    expect(playedCapture('4rrk1/pp1bn1pp/2nBpp2/3p4/qP1P4/P2B1NP1/2P3PP/R2QR1K1 w - - 3 16', 'd6e7')).toBe('n');
    expect(playedCapture(START_FEN, 'e2e4')).toBeNull();
    expect(playedCapture('8/P7/7k/8/8/8/8/7K w - - 0 1', 'a7a8q')).toBeNull();
    expect(playedCapture('bad', 'e2e4')).toBeNull();
  });

  it('omits the Bxe7 even trade instead of claiming a fresh bishop loss', () => {
    // Without the boundary take the lone recapture reads as a fresh win.
    expect(bestLineMaterialNote(bxe7After, ['e8e7'], 'white'))
      .toBe('This line wins a bishop for Black.');
    // Counting the knight just taken (Bxe7/Rxe7) makes it an even trade.
    expect(bestLineMaterialNote(bxe7After, ['e8e7'], 'white', DEFAULT_BEST_LINE_WINDOW, 'n')).toBeNull();
    expect(bestLinePreview(bxe7After, ['e8e7'], 'white', DEFAULT_BEST_LINE_WINDOW, 'n')).toBeNull();
  });

  it('names the net loss honestly across the boundary', () => {
    const after = '4k3/8/4p3/3N4/8/8/8/4K3 b - - 0 1';
    expect(bestLineMaterialNote(after, ['e6d5'], 'white'))
      .toBe('This line wins a knight for Black.');
    // Pawn taken on the move, knight lost in reply: down a knight for a pawn.
    expect(bestLineMaterialNote(after, ['e6d5'], 'white', DEFAULT_BEST_LINE_WINDOW, 'p'))
      .toBe('This line loses a knight for a pawn.');
    expect(bestLinePreview(after, ['e6d5'], 'white', DEFAULT_BEST_LINE_WINDOW, 'p')?.note)
      .toBe('This line loses a knight for a pawn.');
  });

  it('keeps proven tactic falls even with a boundary take', () => {
    const forkFen = '4k3/8/8/5n2/8/1Q6/2B5/4K3 b - - 0 1';
    const pv = ['f5d4', 'b3c3', 'd4c2'];
    expect(bestLineMaterialNote(forkFen, pv, 'white', DEFAULT_BEST_LINE_WINDOW, 'b'))
      .toBe("Nd4 forks White's bishop and queen, but only forces an even exchange.");
  });
});
describe('playedMoveExchangeNote', () => {
  it('frames even recaptures as exchanges, not wins', () => {
    expect(playedMoveExchangeNote('n', 'b'))
      .toBe('Takes the knight back.');
  });

  it('names winning recaptures with the net', () => {
    expect(playedMoveExchangeNote('n', 'p')).toBe('Wins a knight for a pawn.');
  });

  it('stays silent on losing recaptures', () => {
    expect(playedMoveExchangeNote('p', 'n')).toBeNull();
  });
});
