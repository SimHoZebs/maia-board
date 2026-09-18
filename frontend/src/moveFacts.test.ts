import { describe, expect, it } from 'vitest';
import { createMoveFacts } from './moveFacts';

// Fact layer: one parse per position, memoized geometry. These tests pin the
// facts the wording layer reads, independently of any verdict copy.
describe('createMoveFacts', () => {
  it('parses the applied move once', () => {
    const facts = createMoveFacts({ beforeFen: '4k3/8/8/5n2/8/1Q6/2B5/4K3 b - - 0 1', playedUci: 'f5d4', mover: 'black' });
    expect(facts?.san).toBe('Nd4');
    expect(facts?.from).toBe('f5');
    expect(facts?.to).toBe('d4');
    expect(facts?.captured).toBeNull();
    expect(facts?.moverPiece).toBe('n');
    expect(facts?.givesCheck).toBe(false);
  });

  it('returns null on illegal moves and bad FENs, never throws', () => {
    expect(createMoveFacts({ beforeFen: 'bad', playedUci: 'f5d4', mover: 'black' })).toBeNull();
    expect(createMoveFacts({ beforeFen: '4k3/8/8/5n2/8/1Q6/2B5/4K3 b - - 0 1', playedUci: 'e2e9', mover: 'black' })).toBeNull();
    expect(createMoveFacts({ beforeFen: '4k3/8/8/5n2/8/1Q6/2B5/4K3 b - - 0 1', playedUci: 'a7a8q', mover: 'black' })).toBeNull();
  });

  it('grades the contested fork: defended cheapest, even net, safe forker', () => {
    const facts = createMoveFacts({ beforeFen: '4k3/8/8/5n2/8/1Q6/2B5/4K3 b - - 0 1', playedUci: 'f5d4', mover: 'black' });
    expect(facts?.fork()).toMatchObject({
      victims: ['b', 'q'],
      hasKing: false,
      cheapest: 'b',
      cheapestSquare: 'c2',
      cheapestDefended: true,
      forkerType: 'n',
      net: 0,
      hanging: false,
    });
  });

  it('grades the winning trade: defended rook, positive net', () => {
    const facts = createMoveFacts({ beforeFen: '4k3/8/8/5n2/8/1Q6/2R5/4K3 b - - 0 1', playedUci: 'f5d4', mover: 'black' });
    expect(facts?.fork()).toMatchObject({ victims: ['r', 'q'], cheapest: 'r', cheapestDefended: true, net: 2, hanging: false });
  });

  it('marks royal forks king-first', () => {
    const facts = createMoveFacts({ beforeFen: '4k3/8/8/8/8/3n4/8/3Q3K b - - 0 1', playedUci: 'd3f2', mover: 'black' });
    expect(facts?.fork()).toMatchObject({ victims: ['k', 'q'], hasKing: true, cheapest: 'q', hanging: false });
  });

  it('flags hanging forkers, including king takes', () => {
    const pawnTakes = createMoveFacts({ beforeFen: '4k3/8/8/5n2/8/1QP5/2B5/4K3 b - - 0 1', playedUci: 'f5d4', mover: 'black' });
    expect(pawnTakes?.fork()).toMatchObject({ hanging: true });
    const kingTakes = createMoveFacts({ beforeFen: '4k3/8/8/5n2/8/1Q2K3/2B5/8 b - - 0 1', playedUci: 'f5d4', mover: 'black' });
    expect(kingTakes?.fork()).toMatchObject({ hanging: true });
  });

  it('stays silent on captures, promotions, and quiet moves', () => {
    const capture = createMoveFacts({
      beforeFen: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      playedUci: 'e4d5',
      mover: 'white',
    });
    expect(capture?.fork()).toBeNull();
    expect(createMoveFacts({ beforeFen: '8/P7/7k/8/8/8/8/7K w - - 0 1', playedUci: 'a7a8q', mover: 'white' })?.fork() ?? null).toBeNull();
  });

  it('detects checking skewers through the king', () => {
    const facts = createMoveFacts({ beforeFen: '8/2qk4/8/2B5/8/8/5K2/4R3 w - - 0 1', playedUci: 'e1e7', mover: 'white' });
    expect(facts?.givesCheck).toBe(true);
    expect(facts?.skewer()).toMatchObject({
      back: 'q',
      backSquare: 'c7',
      checkerType: 'r',
      defended: true,
      net: 4,
      hanging: false,
    });
  });

  it('rejects skewers without check, without sliders, and with hanging checkers', () => {
    const quiet = createMoveFacts({ beforeFen: '8/2qk4/8/2B5/8/8/5K2/4R3 w - - 0 1', playedUci: 'f2f3', mover: 'white' });
    expect(quiet?.skewer()).toBeNull();
    const knight = createMoveFacts({ beforeFen: '4k3/8/8/8/8/3n4/8/3Q3K b - - 0 1', playedUci: 'd3f2', mover: 'black' });
    expect(knight?.skewer()).toBeNull();
    // No bishop on c5: the king simply eats the rook.
    const hanging = createMoveFacts({ beforeFen: '8/2qk4/8/8/8/8/5K2/4R3 w - - 0 1', playedUci: 'e1e7', mover: 'white' });
    expect(hanging?.skewer()).toMatchObject({ hanging: true });
  });

  it('pairs same-square take-takes with the net', () => {
    // Nxc2+ answered by Qxc2: bishop for knight, all square.
    const even = createMoveFacts({
      beforeFen: '4k3/8/8/8/8/2Q5/2n5/4K3 w - - 0 3',
      playedUci: 'c3c2',
      mover: 'white',
      prevBeforeFen: '4k3/8/8/8/3n4/2Q5/2B5/4K3 b - - 2 2',
      prevUci: 'd4c2',
    });
    expect(even?.recapture()).toEqual({ prevPiece: 'b', thisPiece: 'n', sameSquare: true, net: 0 });
    // Nxe5 answered by dxe5: knight won for a pawn.
    const winning = createMoveFacts({
      beforeFen: '4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 2',
      playedUci: 'd4e5',
      mover: 'white',
      prevBeforeFen: '4k3/3n4/8/4P3/3P4/8/8/4K3 b - - 0 1',
      prevUci: 'd7e5',
    });
    expect(winning?.recapture()).toEqual({ prevPiece: 'p', thisPiece: 'n', sameSquare: true, net: 2 });
  });

  it('stays silent off the recapture shape', () => {
    const facts = createMoveFacts({ beforeFen: '4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 2', playedUci: 'd4e5', mover: 'white' });
    // No prev move at all (game start shape).
    expect(facts?.recapture()).toBeNull();
    // Previous move was quiet: not a take-take.
    const quietPrev = createMoveFacts({
      beforeFen: '4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 2',
      playedUci: 'd4e5',
      mover: 'white',
      prevBeforeFen: '4k3/3n4/8/4P3/3P4/8/8/4K3 b - - 0 1',
      prevUci: 'd7f6',
    });
    expect(quietPrev?.recapture()).toBeNull();
  });
});
