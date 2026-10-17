import type { SoundKind } from './moveSound';
import captureUrl from './files/capture.mp3';
import moveUrl from './files/move.mp3';
import notifyUrl from './files/notify.mp3';

// Board sounds are verbatim lichess standard-set recordings (see
// files/README.md for provenance and license). Playback is plain
// HTMLAudio: the kinds map to one or two files each, layered like
// lichess does (a checking move replays its underlying knock; mate
// layers the knock under the game-end chime). Every entry point is
// guarded so audio can never break the board, and so suites without a
// DOM stay silent.

// Pure data mapping (tested without audio): which files sound for a kind.
export const SOUND_FILES: Record<SoundKind, readonly string[]> = {
  move: [moveUrl],
  capture: [captureUrl],
  check: [moveUrl],
  checkmate: [moveUrl, notifyUrl],
  gameEnd: [notifyUrl],
};

const cache = new Map<string, HTMLAudioElement>();

function elementFor(url: string): HTMLAudioElement | null {
  try {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return null;
    let el = cache.get(url);
    if (!el) {
      el = new Audio(url);
      el.preload = 'auto';
      cache.set(url, el);
    }
    return el;
  } catch {
    return null;
  }
}

function playFile(url: string): void {
  try {
    const seed = elementFor(url);
    if (!seed) return;
    // Clone per play so rapid moves overlap instead of restarting.
    const el = seed.cloneNode() as HTMLAudioElement;
    const played = el.play();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  } catch {
    // Never break the board over audio.
  }
}

// Browsers suspend autoplay until a user gesture. Call from the first
// pointer/key interaction so the files are fetched and the committed
// moves can sound immediately.
export function unlockSounds(): void {
  try {
    for (const files of Object.values(SOUND_FILES)) {
      for (const url of files) elementFor(url);
    }
  } catch {
    // Never break the board over audio.
  }
}

export function playSound(kind: SoundKind): void {
  try {
    for (const url of SOUND_FILES[kind] ?? []) playFile(url);
  } catch {
    // Never break the board over audio.
  }
}

// Test observability only: drops cached elements so suites start clean.
export function resetAudioForTests(): void {
  cache.clear();
}
