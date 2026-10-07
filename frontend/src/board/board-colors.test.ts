import { describe, expect, it } from 'vitest';
import { toGroundColor } from './board-colors';

describe('toGroundColor', () => {
  it.each([
    ['w', 'white'],
    ['b', 'black'],
  ] as const)('maps chess.js %s to Chessground %s', (chessColor, groundColor) => {
    expect(toGroundColor(chessColor)).toBe(groundColor);
  });
});
