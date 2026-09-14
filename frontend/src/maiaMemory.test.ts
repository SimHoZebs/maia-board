import { describe, expect, it } from 'vitest';
import { isMaiaPosition } from './useReview';
import { buildTimeline, loadLine } from './domain';

describe('maia per-move identity', () => {
  it('pins Maia moves by side to move, never terminals or non-own lines', () => {
    const line = loadLine('', '1. e4 e5 2. Nf3');
    const rows = buildTimeline(line.initialFen, line.moves).rows;
    // White user: even plies (white to move) are adjustable, odd are Maia's.
    expect(isMaiaPosition(rows[0], 'white', true)).toBe(false);
    expect(isMaiaPosition(rows[1], 'white', true)).toBe(true);
    expect(isMaiaPosition(rows[2], 'white', true)).toBe(false);
    // Black user: inverse.
    expect(isMaiaPosition(rows[0], 'black', true)).toBe(true);
    expect(isMaiaPosition(rows[1], 'black', true)).toBe(false);
    // Non-own lines never pin.
    expect(isMaiaPosition(rows[1], 'white', false)).toBe(false);
    // Terminals never pin even on Maia's side.
    const mate = loadLine('', '1. f3 e5 2. g4 Qh4#');
    const mateRow = buildTimeline(mate.initialFen, mate.moves).rows.at(-1)!;
    expect(isMaiaPosition(mateRow, 'white', true)).toBe(false);
    expect(isMaiaPosition(mateRow, 'black', true)).toBe(false);
  });
});
