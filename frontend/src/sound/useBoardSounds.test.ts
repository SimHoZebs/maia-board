import { describe, expect, it } from 'vitest';
import { START_FEN } from '../shared/domain';
import { analysisTransitionSound, playTransitionSound } from './useBoardSounds';

describe('playTransitionSound', () => {
  it('stays silent on mount and on new games', () => {
    expect(playTransitionSound(null, 'a', 0, [], false, false)).toBeNull();
    expect(playTransitionSound({ id: 'a', ply: 3 }, 'b', 0, [], false, false)).toBeNull();
  });

  it('sounds the committed move on a single-step advance', () => {
    expect(playTransitionSound({ id: 'a', ply: 0 }, 'a', 1, ['e2e4'], false, false)).toBe('move');
    expect(
      playTransitionSound({ id: 'a', ply: 2 }, 'a', 3, ['e2e4', 'd7d5', 'e4d5'], false, false),
    ).toBe('capture');
  });

  it('replays a check as its underlying knock, like lichess', () => {
    // Quiet check knocks like a move: 1.e4 e5 2.Qh5 Ke7?? 3.Qg5+.
    expect(
      playTransitionSound(
        { id: 'a', ply: 4 },
        'a',
        5,
        ['e2e4', 'e7e5', 'd1h5', 'e8e7', 'h5g5'],
        false,
        false,
      ),
    ).toBe('move');
    // Checking capture knocks like a capture: 1.e4 e5 2.Qh5 Nf6 3.Qxf7+.
    expect(
      playTransitionSound(
        { id: 'a', ply: 4 },
        'a',
        5,
        ['e2e4', 'e7e5', 'd1h5', 'g8f6', 'h5f7'],
        false,
        false,
      ),
    ).toBe('capture');
  });

  it('sounds checkmate at the tip', () => {
    expect(
      playTransitionSound(
        { id: 'a', ply: 3 },
        'a',
        4,
        ['f2f3', 'e7e5', 'g2g4', 'd8h4'],
        false,
        false,
      ),
    ).toBe('checkmate');
  });

  it('sounds the arrived-at position on a single-step step-back', () => {
    // Landing prefix ends in a quiet move: re-sound it.
    expect(playTransitionSound({ id: 'a', ply: 2 }, 'a', 1, ['e2e4', 'e7e5'], false, false)).toBe(
      'move',
    );
    // Stepping back over a capture lands on a quiet prefix.
    expect(
      playTransitionSound({ id: 'a', ply: 3 }, 'a', 2, ['e2e4', 'd7d5', 'e4d5'], false, false),
    ).toBe('move');
    // Back to the start: generic knock so every step-back has feedback.
    expect(playTransitionSound({ id: 'a', ply: 1 }, 'a', 0, [], false, false)).toBe('move');
  });

  it('stays silent on jumps and same-ply re-renders', () => {
    expect(
      playTransitionSound({ id: 'a', ply: 4 }, 'a', 2, ['e2e4', 'e7e5'], false, false),
    ).toBeNull();
    expect(
      playTransitionSound({ id: 'a', ply: 1 }, 'a', 3, ['e2e4', 'e7e5', 'g1f3'], false, false),
    ).toBeNull();
    expect(
      playTransitionSound({ id: 'a', ply: 2 }, 'a', 2, ['e2e4', 'e7e5'], false, false),
    ).toBeNull();
  });

  it('sounds the game end once on resignation', () => {
    expect(playTransitionSound({ id: 'a', ply: 6 }, 'a', 6, [], true, false)).toBe('gameEnd');
    expect(playTransitionSound({ id: 'a', ply: 6 }, 'a', 6, [], true, true)).toBeNull();
  });
});

describe('analysisTransitionSound', () => {
  const root = JSON.stringify([START_FEN, ['e2e4']]);
  it('stays silent on loads and root changes', () => {
    expect(analysisTransitionSound(null, root, 1, START_FEN, ['e2e4'])).toBeNull();
    expect(
      analysisTransitionSound({ root: 'other', ply: 1 }, root, 2, START_FEN, ['e2e4', 'e7e5']),
    ).toBeNull();
  });

  it('sounds single-step navigation in either direction and stays silent otherwise', () => {
    expect(analysisTransitionSound({ root, ply: 1 }, root, 2, START_FEN, ['e2e4', 'e7e5'])).toBe(
      'move',
    );
    expect(analysisTransitionSound({ root, ply: 2 }, root, 1, START_FEN, ['e2e4'])).toBe('move');
    expect(analysisTransitionSound({ root, ply: 1 }, root, 0, START_FEN, [])).toBe('move');
    // Quiet check replays the move knock.
    expect(
      analysisTransitionSound({ root, ply: 4 }, root, 5, START_FEN, [
        'e2e4',
        'e7e5',
        'd1h5',
        'e8e7',
        'h5g5',
      ]),
    ).toBe('move');
    // Checking capture replays the capture knock.
    expect(
      analysisTransitionSound({ root, ply: 4 }, root, 5, START_FEN, [
        'e2e4',
        'e7e5',
        'd1h5',
        'g8f6',
        'h5f7',
      ]),
    ).toBe('capture');
    expect(
      analysisTransitionSound({ root, ply: 1 }, root, 3, START_FEN, ['e2e4', 'e7e5', 'g1f3']),
    ).toBeNull();
  });
});
