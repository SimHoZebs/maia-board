import { describe, expect, it } from 'vitest';
import { SOUND_FILES, playSound, resetAudioForTests, unlockSounds } from './player';

// Mapping assertions only: there is no DOM audio in this environment, so
// playback itself stays a guarded no-op. playSound/unlockSounds must never
// throw without Audio available.
describe('SOUND_FILES', () => {
  it('maps quiet moves and captures to the lichess knocks', () => {
    expect(SOUND_FILES.move).toHaveLength(1);
    expect(SOUND_FILES.move[0]).toMatch(/move\.mp3$/);
    expect(SOUND_FILES.capture).toHaveLength(1);
    expect(SOUND_FILES.capture[0]).toMatch(/capture\.mp3$/);
  });

  it('resolves checks to the plain move knock (lichess ships check as silence)', () => {
    expect(SOUND_FILES.check).toEqual(SOUND_FILES.move);
  });

  it('layers the move knock under the game-end chime for checkmate', () => {
    expect(SOUND_FILES.checkmate).toHaveLength(2);
    expect(SOUND_FILES.checkmate[0]).toMatch(/move\.mp3$/);
    expect(SOUND_FILES.checkmate[1]).toMatch(/notify\.mp3$/);
  });

  it('plays the lichess draw/defeat chime for game ends', () => {
    expect(SOUND_FILES.gameEnd).toHaveLength(1);
    expect(SOUND_FILES.gameEnd[0]).toMatch(/notify\.mp3$/);
  });

  it('stays silent without throwing when Audio is unavailable', () => {
    resetAudioForTests();
    expect(() => unlockSounds()).not.toThrow();
    expect(() => playSound('move')).not.toThrow();
    expect(() => playSound('capture')).not.toThrow();
    expect(() => playSound('check')).not.toThrow();
    expect(() => playSound('checkmate')).not.toThrow();
    expect(() => playSound('gameEnd')).not.toThrow();
  });
});
