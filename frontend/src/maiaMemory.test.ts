import { describe, expect, it } from 'vitest';
import { isMaiaPosition, maiaIdentityOf, sameMaiaIdentity } from './useReview';
import { buildTimeline, loadLine } from './domain';

describe('maia per-move identity', () => {
  it('compares elo and model', () => {
    expect(sameMaiaIdentity(maiaIdentityOf({ eloMaia: 1600, model: '79m' }), { eloMaia: 1600, model: '79m' })).toBe(true);
    expect(sameMaiaIdentity({ eloMaia: 1600, model: '79m' }, { eloMaia: 1800, model: '79m' })).toBe(false);
    expect(sameMaiaIdentity({ eloMaia: 1600, model: '79m' }, { eloMaia: 1600, model: '5m' })).toBe(false);
  });

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
