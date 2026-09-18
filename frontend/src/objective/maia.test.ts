import { expect, it } from 'vitest';
import { candidatesFor, maiaExpected, maiaPoint } from './maia';

it('reads mover-relative expected scores from WDL triples', () => {
  expect(maiaExpected([0.2, 0.3, 0.5])).toBeCloseTo(65, 9);
  expect(maiaExpected([0, 0, 1])).toBe(100);
  expect(maiaExpected([1, 0, 0])).toBe(0);
});

it('names the objective top only from clean responses', () => {
  expect(maiaPoint(undefined)).toEqual({ top: null, expected: null });
  expect(maiaPoint({ top_moves: [{ move: 'e2e4', prob: 0.5, wdl: [0.2, 0.3, 0.5] }], wdl: [0.2, 0.3, 0.5], degraded: false }))
    .toEqual({ top: 'e2e4', expected: 65 });
  // Degraded rows still carry an expectation (shown, not graded).
  expect(maiaPoint({ top_moves: [{ move: 'e2e4', prob: 0.5, wdl: [0.2, 0.3, 0.5] }], wdl: [0.2, 0.3, 0.5], degraded: true }))
    .toEqual({ top: null, expected: 65 });
  expect(maiaPoint({ top_moves: [], wdl: [0.2, 0.3, 0.5], degraded: false }))
    .toEqual({ top: null, expected: 65 });
});

it('lists ranked candidates with per-choice expectations', () => {
  const node = { fen: '', turn: 'white' } as never;
  expect(candidatesFor(undefined, node)).toBeUndefined();
  const list = candidatesFor({
    move: 'e2e4',
    top_moves: [
      { move: 'e2e4', prob: 0.5, wdl: [0.2, 0.3, 0.5] },
      { move: 'd2d4', prob: 0.3, wdl: [0.5, 0.3, 0.2] },
    ],
    wdl: [0.2, 0.3, 0.5], model_used: '79m', degraded: false,
  }, node);
  expect(list?.entries).toEqual([
    { uci: 'e2e4', expected: 65 },
    { uci: 'd2d4', expected: 35 },
  ]);
  expect(list).toMatchObject({ degraded: false });
});
