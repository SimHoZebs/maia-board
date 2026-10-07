import { describe, expect, it } from 'vitest';
import { classifyPlayTip, classifyTip } from './moveSound';

describe('classifyTip', () => {
  it('stays silent on an empty prefix', () => {
    expect(classifyPlayTip([])).toBeNull();
  });

  it('classifies a quiet move', () => {
    expect(classifyPlayTip(['e2e4'])).toBe('move');
  });

  it('classifies castling as a quiet move', () => {
    expect(classifyPlayTip(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'e1g1'])).toBe('move');
  });

  it('classifies a capture', () => {
    expect(classifyPlayTip(['e2e4', 'd7d5', 'e4d5'])).toBe('capture');
  });

  it('ranks check above capture', () => {
    // Qxf7+ takes a pawn with check: platforms play the check sound.
    expect(classifyPlayTip(['e2e4', 'e7e5', 'd1h5', 'g8f6', 'h5f7'])).toBe('check');
  });

  it('classifies checkmate', () => {
    expect(classifyPlayTip(['f2f3', 'e7e5', 'g2g4', 'd8h4'])).toBe('checkmate');
  });

  it('classifies a capturing checkmate as checkmate', () => {
    expect(classifyPlayTip(['e2e4', 'e7e5', 'd1h5', 'b8c6', 'f1c4', 'g8f6', 'h5f7'])).toBe('checkmate');
  });

  it('classifies stalemate as a game end', () => {
    expect(classifyTip('k7/8/1Q6/8/8/8/8/K7 w - - 0 1', ['b6c7'])).toBe('gameEnd');
  });

  it('stays silent on unparseable lines', () => {
    expect(classifyPlayTip(['e2e4', 'bogus'])).toBeNull();
    expect(classifyTip('not-a-fen', ['e2e4'])).toBeNull();
  });
});
