import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import {
  bookFlagsForLine,
  epdKey,
  loadOpenings,
  openingForLine,
  type OpeningTable,
} from './openings';
import { OPENINGS } from './openings.generated';
import { describeMove } from './reviewMetrics';
import { START_FEN } from './domain';

const fenAfter = (sans: string[]): string => {
  const game = new Chess();
  sans.forEach((san) => game.move(san));
  return game.fen();
};

describe('epdKey', () => {
  it('strips move counters so transposed clocks share a key', () => {
    const fen = fenAfter(['e4', 'e5']);
    const [board, turn, castling, ep] = fen.split(' ');
    expect(epdKey(`${board} ${turn} ${castling} ${ep} 0 1`)).toBe(epdKey(`${board} ${turn} ${castling} ${ep} 7 23`));
  });

  it('keeps a legally capturable en-passant square', () => {
    const fen = fenAfter(['e4', 'Nf6', 'e5', 'd5']);
    expect(fen.split(' ')[3]).toBe('d6');
    expect(epdKey(fen)).toContain(' d6');
  });
});

describe('line lookup with a synthetic table', () => {
  const table: OpeningTable = {
    [epdKey(fenAfter(['e4']))]: ['B00', 'Test Opening'],
    [epdKey(fenAfter(['e4', 'e5', 'Nf3']))]: ['C50', 'Test Opening: Variation'],
  };
  const line = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'];

  it('returns the deepest named ancestor and flags exact hits per move', () => {
    expect(openingForLine(table, line.slice(0, 1))).toEqual({ eco: 'B00', name: 'Test Opening', matchedPly: 1, isExact: true });
    expect(openingForLine(table, line)).toEqual({ eco: 'C50', name: 'Test Opening: Variation', matchedPly: 3, isExact: false });
    expect(openingForLine(table, line, START_FEN, 3)).toEqual({ eco: 'C50', name: 'Test Opening: Variation', matchedPly: 3, isExact: true });
    expect(bookFlagsForLine(table, line)).toEqual([true, false, true, false, false]);
  });

  it('returns null for empty lines and custom starts', () => {
    expect(openingForLine(table, [])).toBeNull();
    expect(openingForLine(table, ['e2e4'], 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3')).toBeNull();
    expect(bookFlagsForLine(table, ['e2e4'], 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3')).toEqual([false]);
  });
});

describe('real book', () => {
  it('names the Italian Game and the Najdorf', () => {
    const italian = openingForLine(OPENINGS, ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4']);
    expect(italian?.eco).toBe('C50');
    expect(italian?.name).toContain('Italian');
    expect(italian?.isExact).toBe(true);
    const najdorf = openingForLine(OPENINGS, ['e2e4', 'c7c5', 'g1f3', 'd7d6', 'd2d4', 'c5d4', 'f3d4', 'g8f6', 'b1c3', 'a7a6']);
    expect(najdorf?.name).toContain('Najdorf');
    expect(najdorf?.isExact).toBe(true);
  });

  it('converges transpositions to one name', () => {
    const a = openingForLine(OPENINGS, ['g1f3', 'd7d5', 'd2d4']);
    const b = openingForLine(OPENINGS, ['d2d4', 'd7d5', 'g1f3']);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it('loads the generated chunk with the full book', async () => {
    const table = await loadOpenings();
    expect(Object.keys(table).length).toBeGreaterThan(3000);
    expect(table).toBe(OPENINGS);
  });
});

describe('describeMove book clause', () => {
  const quality = { label: 'Best' as const, accuracy: 100, loss: 0 };
  const rarity = { label: 'Expected' as const, r: 1, prob: 0.4, topProb: 0.4 };

  it('names the book line instead of restating engine grades', () => {
    expect(describeMove({ san: 'Bc4', quality, rarity, elo: 1600, opening: { eco: 'C50', name: 'Italian Game' } }))
      .toBe('Bc4 — Italian Game (C50). Book move.');
  });

  it('still names the line before any engine result settles', () => {
    expect(describeMove({
      san: 'Nf3',
      quality: { label: 'Unreviewed', accuracy: null, loss: null },
      rarity: undefined,
      elo: 1600,
      opening: { eco: 'C40', name: "King's Knight Opening" },
    })).toBe("Nf3 — King's Knight Opening (C40). Book move.");
  });

  it('keeps engine wording off-book', () => {
    expect(describeMove({ san: 'Nf3', quality, rarity, elo: 1600 }))
      .toBe("Best — Nf3 is the engine's top choice. Maia at 1600 predicts 40% for this move.");
  });
});
