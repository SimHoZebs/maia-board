import type { SoundKind } from './moveSound';

// Synthesized board sounds. No audio assets: every kind is a short WebAudio
// physical-modeling recipe for stone-against-wood: a hard, broadband stone
// click (fast highpassed noise transient) striking a hollow wooden knock
// (bandpassed noise body plus two fast-decaying low resonances). Check,
// mate, and drawn ends reuse the same knock so the material stays constant
// and add only short wooden ticks on top, never a synth ping.
// The shared context is created lazily so construction never runs in tests
// or before a user gesture; every entry point is guarded so audio can never
// break the board.

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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

function woodTone(
  ctx: AudioContext,
  at: number,
  freq: number,
  dur: number,
  vol: number,
  type: OscillatorType = 'sine',
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  // Slight per-hit detune keeps repeated moves from sounding mechanical.
  const jitter = 1 + (Math.random() - 0.5) * 0.06;
  osc.frequency.setValueAtTime(Math.max(30, freq * jitter), at);
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(vol, at + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

let noiseBuffer: AudioBuffer | null = null;

function ensureNoise(ctx: AudioContext): AudioBuffer | null {
  try {
    noiseBuffer ??= (() => {
      const buffer = ctx.createBuffer(
        1,
        Math.max(1, Math.floor(ctx.sampleRate * 0.2)),
        ctx.sampleRate,
      );
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      return buffer;
    })();
    return noiseBuffer;
  } catch {
    return null;
  }
}

// One filtered noise transient with a 1.5 ms stone-like attack and an
// exponential fall. Type is highpass for the contact click, bandpass for
// the wooden body.
function burst(
  ctx: AudioContext,
  at: number,
  dur: number,
  vol: number,
  type: BiquadFilterType,
  freq: number,
  q = 1,
): void {
  const buffer = ensureNoise(ctx);
  if (!buffer) return;
  const jitter = 1 + (Math.random() - 0.5) * 0.08;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = 0.95 + Math.random() * 0.1;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = Math.max(40, freq * jitter);
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(vol, at + 0.0015);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  src.start(at, Math.random() * 0.05);
  src.stop(at + dur + 0.02);
}

interface StoneHit {
  clickHp: number;
  clickVol: number;
  clickDur: number;
  bodyFreq: number;
  bodyQ: number;
  bodyVol: number;
  bodyDur: number;
  lowFreq: number;
  lowVol: number;
  lowDur: number;
  midFreq: number;
  midVol: number;
  midDur: number;
}

const LIGHT_HIT: StoneHit = {
  // Light stone tap on wood: sharp 4.2 kHz contact, hollow 1.6 kHz board.
  clickHp: 4200,
  clickVol: 0.5,
  clickDur: 0.022,
  bodyFreq: 1650,
  bodyQ: 0.9,
  bodyVol: 0.6,
  bodyDur: 0.065,
  lowFreq: 235,
  lowVol: 0.32,
  lowDur: 0.085,
  midFreq: 560,
  midVol: 0.11,
  midDur: 0.05,
};

const HEAVY_HIT: StoneHit = {
  // Heavier stone: duller click, lower board knock, stronger low thump.
  clickHp: 3100,
  clickVol: 0.65,
  clickDur: 0.028,
  bodyFreq: 950,
  bodyQ: 1.1,
  bodyVol: 0.75,
  bodyDur: 0.095,
  lowFreq: 140,
  lowVol: 0.5,
  lowDur: 0.11,
  midFreq: 340,
  midVol: 0.2,
  midDur: 0.07,
};

// Stone-against-wood: highpassed contact click + bandpassed board body +
// two fast low resonances. Never a sustained synth tone.
function stoneHit(ctx: AudioContext, at: number, hit: StoneHit, gainScale = 1): void {
  burst(ctx, at, hit.clickDur, hit.clickVol * gainScale, 'highpass', hit.clickHp);
  burst(ctx, at, hit.bodyDur, hit.bodyVol * gainScale, 'bandpass', hit.bodyFreq, hit.bodyQ);
  woodTone(ctx, at, hit.lowFreq, hit.lowDur, hit.lowVol * gainScale);
  woodTone(ctx, at, hit.midFreq, hit.midDur, hit.midVol * gainScale);
}

export function playSound(kind: SoundKind): void {
  try {
    const ctx = audio();
    if (!ctx) return;
    if (ctx.state === 'suspended') void ctx.resume();
    const at = ctx.currentTime;
    switch (kind) {
      case 'move':
        stoneHit(ctx, at, LIGHT_HIT);
        break;
      case 'capture':
        stoneHit(ctx, at, HEAVY_HIT);
        break;
      case 'check':
        // Same stone tap, plus two short wooden ticks (not a synth ping).
        stoneHit(ctx, at, LIGHT_HIT, 0.7);
        woodTone(ctx, at + 0.005, 987.77, 0.07, 0.16);
        woodTone(ctx, at + 0.08, 1318.5, 0.09, 0.16);
        break;
      case 'checkmate':
        // Heavy stone, then three small wooden blocks ascending.
        stoneHit(ctx, at, HEAVY_HIT);
        woodTone(ctx, at + 0.02, 659.25, 0.08, 0.18);
        woodTone(ctx, at + 0.12, 880, 0.08, 0.18);
        woodTone(ctx, at + 0.22, 1174.66, 0.14, 0.2);
        break;
      case 'gameEnd':
        // Two soft stones settling: tap, then a lower tap a beat later.
        stoneHit(ctx, at, LIGHT_HIT, 0.6);
        stoneHit(ctx, at + 0.15, { ...LIGHT_HIT, lowFreq: 175, midFreq: 420 }, 0.55);
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
