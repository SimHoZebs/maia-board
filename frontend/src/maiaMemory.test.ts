import { describe, expect, it } from 'vitest';
import { backfillMaiaMemory, isMaiaPosition, maiaIdentityOf, sameMaiaIdentity, selectMaiaDisplay } from './useReview';
import { loadLine, testNodes } from './domain';

describe('maia per-move identity', () => {
  it('compares elo and model', () => {
    expect(sameMaiaIdentity(maiaIdentityOf({ eloMaia: 1600, model: '79m' }), { eloMaia: 1600, model: '79m' })).toBe(true);
    expect(sameMaiaIdentity({ eloMaia: 1600, model: '79m' }, { eloMaia: 1800, model: '79m' })).toBe(false);
    expect(sameMaiaIdentity({ eloMaia: 1600, model: '79m' }, { eloMaia: 1600, model: '5m' })).toBe(false);
  });

  it('backfills unvisited moves with the old rating and invalidates only the current move', () => {
    const prev = { eloMaia: 1600, model: '79m' } as const;
    const next = { eloMaia: 1800, model: '79m' } as const;
    const out = backfillMaiaMemory({}, prev, next, 2, 4);
    expect(out).toEqual({ 0: prev, 1: prev, 2: next, 3: prev });
    const keep = backfillMaiaMemory({ 1: prev }, prev, next, 0, 2);
    expect(keep).toEqual({ 0: next, 1: prev });
  });

  it('keeps the stale move visible until the fresh result lands', () => {
    const old = { eloMaia: 1600, model: '79m' } as const;
    const fresh = { eloMaia: 1800, model: '79m' } as const;
    expect(selectMaiaDisplay({ memory: undefined, global: fresh, fresh: undefined, stale: undefined })).toEqual({ identity: fresh, useFresh: true });
    expect(selectMaiaDisplay({ memory: old, global: fresh, fresh: undefined, stale: { move: 'e2e4' } })).toEqual({ identity: old, useFresh: false });
    expect(selectMaiaDisplay({ memory: old, global: fresh, fresh: { move: 'd2d4' }, stale: { move: 'e2e4' } })).toEqual({ identity: fresh, useFresh: true });
    expect(selectMaiaDisplay({ memory: old, global: fresh, fresh: undefined, stale: undefined })).toEqual({ identity: fresh, useFresh: true });
  });

  it('pins Maia moves by side to move, never terminals or non-own lines', () => {
    const line = loadLine('', '1. e4 e5 2. Nf3');
    const nodes = testNodes(line.initialFen, line.moves);
    // White user: even plies (white to move) are adjustable, odd are Maia's.
    expect(isMaiaPosition(nodes[0], 'white', true)).toBe(false);
    expect(isMaiaPosition(nodes[1], 'white', true)).toBe(true);
    expect(isMaiaPosition(nodes[2], 'white', true)).toBe(false);
    // Black user: inverse.
    expect(isMaiaPosition(nodes[0], 'black', true)).toBe(true);
    expect(isMaiaPosition(nodes[1], 'black', true)).toBe(false);
    // Non-own lines never pin.
    expect(isMaiaPosition(nodes[1], 'white', false)).toBe(false);
    // Terminals never pin even on Maia's side.
    const mate = loadLine('', '1. f3 e5 2. g4 Qh4#');
    const mateNode = testNodes(mate.initialFen, mate.moves).at(-1)!;
    expect(isMaiaPosition(mateNode, 'white', true)).toBe(false);
    expect(isMaiaPosition(mateNode, 'black', true)).toBe(false);
  });
});
