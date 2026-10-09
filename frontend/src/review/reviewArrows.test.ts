import { expect, it } from 'vitest';
import { reviewBrushes, reviewShapes, type SquareBadge } from './reviewArrows';
const allToggles = { actual: true, next: true, bot: true, objective: true, stockfish: true } as const;
const noMoves = { actual: null, bot: null, objective: null, stockfish: null, next: null };
it('keeps all agreeing arrows in widest-first order with distinct brushes', () => {
  const shapes = reviewShapes({ actual: 'e2e4', next: 'd2d4', bot: 'e2e4', objective: 'e2e3', stockfish: 'e2e4' }, { ...allToggles });
  expect(shapes.map(shape => shape.brush)).toEqual(['actual', 'next', 'bot', 'stockfish', 'objective']);
  expect(shapes.map(shape => reviewBrushes[shape.brush!].lineWidth)).toEqual([12, 10, 8, 6, 4]);
  expect(shapes.every(shape => reviewBrushes[shape.brush!].opacity === .45)).toBe(true);
});
it('skips the next-best arrow when it coincides with the Stockfish arrow', () => {
  const shapes = reviewShapes({ actual: 'e2e4', next: 'e2e4', bot: 'g1f3', objective: 'd2d4', stockfish: 'e2e4' }, { ...allToggles });
  expect(shapes.map(shape => shape.brush)).toEqual(['actual', 'bot', 'stockfish', 'objective']);
});
it('removes toggled and absent arrows', () => {
  const shapes = reviewShapes({ actual: null, next: null, bot: 'e2e4', objective: 'd2d4', stockfish: null }, { actual: true, next: true, bot: false, objective: true, stockfish: true });
  expect(shapes.map(shape => shape.brush)).toEqual(['objective']);
});
it('rejects malformed engine moves before creating SVG content', () => {
  expect(reviewShapes({ actual: null, next: null, bot: 'e2e4--><svg>', objective: 'zzzz', stockfish: 'zzzz' }, { ...allToggles }, null)).toEqual([]);
});
it('marks blunder and mistake destinations with label badges', () => {
  const blunder = reviewShapes({ ...noMoves }, { ...allToggles }, { square: 'f3', glyph: '??' });
  expect(blunder).toHaveLength(1);
  expect(blunder[0]).toMatchObject({ orig: 'f3', label: { text: '??', fill: '#e5484d' } });
  const mistake = reviewShapes({ ...noMoves }, { ...allToggles }, { square: 'e5', glyph: '?' });
  expect(mistake[0]).toMatchObject({ orig: 'e5', label: { text: '?', fill: '#f5a524' } });
  expect(reviewShapes({ ...noMoves }, { ...allToggles }, { square: 'z9', glyph: '??' } as unknown as SquareBadge)).toEqual([]);
  expect(reviewShapes({ ...noMoves }, { ...allToggles }, { square: 'f3', glyph: '!' } as unknown as SquareBadge)).toEqual([]);
});
it('marks allowed-mate destinations with the shared dark-red badge', () => {
  const allowedMate = reviewShapes({ ...noMoves }, { ...allToggles }, { square: 'g3', glyph: '💀' });
  expect(allowedMate).toHaveLength(1);
  expect(allowedMate[0]).toMatchObject({ orig: 'g3', label: { text: '💀', fill: '#7f1d1d' } });
});
it('marks the losing king with a flag badge that outranks quality badges', () => {
  const flag = reviewShapes({ ...noMoves }, { ...allToggles }, { square: 'e8', glyph: '⚑' });
  expect(flag).toHaveLength(1);
  expect(flag[0]).toMatchObject({ orig: 'e8', label: { text: '⚑', fill: '#111827' } });
  const both = reviewShapes({ ...noMoves }, { ...allToggles }, [{ square: 'e8', glyph: '⚑' }, { square: 'e8', glyph: '??' }, { square: 'f3', glyph: '??' }]);
  expect(both.map(shape => shape.orig)).toEqual(['e8', 'f3']);
  expect(both[0]).toMatchObject({ label: { text: '⚑' } });
});
