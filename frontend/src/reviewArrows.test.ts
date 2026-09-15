import { expect, it } from 'vitest';
import { reviewBrushes, reviewShapes, type SquareBadge } from './reviewArrows';
it('keeps all agreeing arrows in widest-first order with distinct brushes', () => {
  const shapes = reviewShapes({ actual: 'e2e4', maia: 'e2e4', stockfish: 'e2e4' }, { actual: true, maia: true, stockfish: true });
  expect(shapes.map(shape => shape.brush)).toEqual(['actual', 'maia', 'stockfish']);
  expect(shapes.map(shape => reviewBrushes[shape.brush!].lineWidth)).toEqual([12, 8, 4]);
  expect(shapes.every(shape => reviewBrushes[shape.brush!].opacity === .45)).toBe(true);
});
it('removes toggled and absent arrows and separates optional preview', () => {
  const shapes = reviewShapes({ actual: null, maia: 'e2e4', stockfish: 'd2d4' }, { actual: true, maia: false, stockfish: true }, 'g1f3');
  expect(shapes.map(shape => shape.brush)).toEqual(['stockfish', 'candidate']);
});
it('rejects malformed engine moves before creating SVG content', () => {
  expect(reviewShapes({ actual: null, maia: 'e2e4--><svg>', stockfish: 'zzzz' }, { actual: true, maia: true, stockfish: true }, '<svg>')).toEqual([]);
});
it('marks blunder and mistake destinations with label badges', () => {
  const blunder = reviewShapes({ actual: null, maia: null, stockfish: null }, { actual: true, maia: true, stockfish: true }, null, { square: 'f3', glyph: '??' });
  expect(blunder).toHaveLength(1);
  expect(blunder[0]).toMatchObject({ orig: 'f3', label: { text: '??', fill: '#e5484d' } });
  const mistake = reviewShapes({ actual: null, maia: null, stockfish: null }, { actual: true, maia: true, stockfish: true }, null, { square: 'e5', glyph: '?' });
  expect(mistake[0]).toMatchObject({ orig: 'e5', label: { text: '?', fill: '#f5a524' } });
  expect(reviewShapes({ actual: null, maia: null, stockfish: null }, { actual: true, maia: true, stockfish: true }, null, { square: 'z9', glyph: '??' } as unknown as SquareBadge)).toEqual([]);
  expect(reviewShapes({ actual: null, maia: null, stockfish: null }, { actual: true, maia: true, stockfish: true }, null, { square: 'f3', glyph: '!' } as unknown as SquareBadge)).toEqual([]);
});
it('marks allowed-mate destinations with the shared dark-red badge', () => {
  const allowedMate = reviewShapes({ actual: null, maia: null, stockfish: null }, { actual: true, maia: true, stockfish: true }, null, { square: 'g3', glyph: '💀' });
  expect(allowedMate).toHaveLength(1);
  expect(allowedMate[0]).toMatchObject({ orig: 'g3', label: { text: '💀', fill: '#7f1d1d' } });
});
