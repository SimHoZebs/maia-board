import type { SoundKind } from './moveSound';

// Synthesized board sounds. No audio assets: every kind is a short WebAudio
// recipe (a woody "thock" for moves, a lower thud for captures, a bright
// ping for check, a small fanfare for mate, a falling pair for drawn ends).
// The shared context is created lazily so construction never runs in tests
// or before a user gesture; every entry point is guarded so audio can never
// break the board.

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    context ??= new Ctor();
    return context;
  } catch {
    return null;
  }
}

// Browsers suspend the context until a user gesture. Call from the first
// pointer/key interaction so committed moves can sound immediately.
export function unlockSounds(): void {
  try {
    const ctx = audio();
    if (ctx && ctx.state === 'suspended') void ctx.resume();
  } catch {
    // Never break the board over audio.
  }
}

function tone(ctx: AudioContext, at: number, freq: number, dur: number, vol: number, type: OscillatorType, freqEnd?: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  if (freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(freqEnd, at + dur);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(vol, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

let noiseBuffer: AudioBuffer | null = null;

function thock(ctx: AudioContext, at: number, dur: number, cutoff: number, vol: number): void {
  try {
    noiseBuffer ??= (() => {
      const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.15)), ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      return buffer;
    })();
  } catch {
    return;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = cutoff;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  src.start(at);
  src.stop(at + dur + 0.02);
}

export function playSound(kind: SoundKind): void {
  try {
    const ctx = audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const at = ctx.currentTime;
    switch (kind) {
      case 'move':
        thock(ctx, at, 0.07, 2200, 0.5);
        tone(ctx, at, 320, 0.07, 0.2, 'triangle', 170);
        break;
      case 'capture':
        thock(ctx, at, 0.1, 900, 0.7);
        tone(ctx, at, 190, 0.11, 0.45, 'sine', 85);
        break;
      case 'check':
        thock(ctx, at, 0.05, 2600, 0.25);
        tone(ctx, at, 880, 0.09, 0.26, 'sine');
        tone(ctx, at + 0.085, 1318.5, 0.14, 0.26, 'sine');
        break;
      case 'checkmate':
        thock(ctx, at, 0.06, 2000, 0.35);
        tone(ctx, at, 523.25, 0.12, 0.28, 'triangle');
        tone(ctx, at + 0.11, 659.25, 0.12, 0.28, 'triangle');
        tone(ctx, at + 0.22, 783.99, 0.12, 0.28, 'triangle');
        tone(ctx, at + 0.33, 1046.5, 0.3, 0.3, 'triangle');
        break;
      case 'gameEnd':
        tone(ctx, at, 392, 0.15, 0.26, 'sine');
        tone(ctx, at + 0.14, 261.63, 0.25, 0.26, 'sine');
        break;
    }
  } catch {
    // Never break the board over audio.
  }
}

// Test observability only: drops the shared context so suites start clean.
export function resetAudioForTests(): void {
  context = null;
  noiseBuffer = null;
}
