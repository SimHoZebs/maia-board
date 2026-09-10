import { expect, it } from 'vitest';
import { reviewBrushes, reviewShapes } from './reviewArrows';
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
