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
    expect(playTransitionSound({ id: 'a', ply: 2 }, 'a', 3, ['e2e4', 'd7d5', 'e4d5'], false, false)).toBe('capture');
  });

  it('sounds checkmate at the tip', () => {
    expect(playTransitionSound({ id: 'a', ply: 3 }, 'a', 4, ['f2f3', 'e7e5', 'g2g4', 'd8h4'], false, false)).toBe('checkmate');
  });

  it('stays silent on takebacks, jumps, and backwards steps', () => {
    expect(playTransitionSound({ id: 'a', ply: 4 }, 'a', 2, ['e2e4', 'e7e5'], false, false)).toBeNull();
    expect(playTransitionSound({ id: 'a', ply: 1 }, 'a', 3, ['e2e4', 'e7e5', 'g1f3'], false, false)).toBeNull();
    expect(playTransitionSound({ id: 'a', ply: 2 }, 'a', 2, ['e2e4', 'e7e5'], false, false)).toBeNull();
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
    expect(analysisTransitionSound({ root: 'other', ply: 1 }, root, 2, START_FEN, ['e2e4', 'e7e5'])).toBeNull();
  });

  it('sounds single-step navigation and stays silent otherwise', () => {
    expect(analysisTransitionSound({ root, ply: 1 }, root, 2, START_FEN, ['e2e4', 'e7e5'])).toBe('move');
    expect(analysisTransitionSound({ root, ply: 2 }, root, 1, START_FEN, ['e2e4'])).toBeNull();
    expect(analysisTransitionSound({ root, ply: 1 }, root, 3, START_FEN, ['e2e4', 'e7e5', 'g1f3'])).toBeNull();
  });
});
