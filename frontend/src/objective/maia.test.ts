import { expect, it } from 'vitest';
import { candidatesFor, fixedElo, formatWinrateDelta, lanePoints, maiaDisplayParts, maiaExpected, maiaPoint, maiaWhiteWdl } from './maia';

it('reads mover-relative expected scores from WDL triples', () => {
  expect(maiaExpected([0.2, 0.3, 0.5])).toBeCloseTo(65, 9);
  expect(maiaExpected([0, 0, 1])).toBe(100);
  expect(maiaExpected([1, 0, 0])).toBe(0);
});

it('converts mover-relative WDL triples to white-relative percentages', () => {
  expect(maiaWhiteWdl([0.2, 0.3, 0.5], 'white')).toEqual({ white: 50, draw: 30, black: 20 });
  expect(maiaWhiteWdl([0.2, 0.3, 0.5], 'black')).toEqual({ white: 20, draw: 30, black: 50 });
});

it('carries the white-relative WDL on lane points for the eval bar', () => {
  const nodes = [{ turn: 'white' }, { turn: 'black' }] as never;
  const rows = [
    { top_moves: [{ move: 'e2e4', prob: 0.5, wdl: [0.2, 0.3, 0.5] }], wdl: [0.2, 0.3, 0.5], degraded: false },
    { top_moves: [{ move: 'e7e5', prob: 0.5, wdl: [0.2, 0.3, 0.5] }], wdl: [0.2, 0.3, 0.5], degraded: false },
  ] as never;
  const points = lanePoints(rows, nodes);
  expect(points[0]).toMatchObject({ expected: 65, wdl: { white: 50, draw: 30, black: 20 } });
  expect(points[1]).toMatchObject({ expected: 65, wdl: { white: 20, draw: 30, black: 50 } });
  expect(lanePoints([undefined] as never, nodes)).toEqual([undefined]);
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
    { uci: 'e2e4', expected: 65, prob: 0.5 },
    { uci: 'd2d4', expected: 35, prob: 0.3 },
  ]);
  expect(list).toMatchObject({ degraded: false });
});

it('pins the panel dropdown to 2400', () => {
  expect(fixedElo()).toBe(2400);
});

it('formats winrate deltas with one decimal and a zero guard', () => {
  expect(formatWinrateDelta(0)).toBe('0.0%');
  expect(formatWinrateDelta(-0.04)).toBe('0.0%');
  expect(formatWinrateDelta(-2.34)).toBe('-2.3%');
  expect(formatWinrateDelta(1.25)).toBe('+1.3%');
});

it('renders display parts as prob plus delta vs best winrate', () => {
  expect(maiaDisplayParts([])).toEqual([]);
  const parts = maiaDisplayParts([
    { move: 'e2e4', prob: 0.5, wdl: [0.2, 0.3, 0.5] },
    { move: 'd2d4', prob: 0.3, wdl: [0.5, 0.3, 0.2] },
  ]);
  // 65 vs 35 expected: best reads 0.0%, the other -30.0%.
  expect(parts).toEqual([
    { prob: '50%', delta: '0.0%' },
    { prob: '30%', delta: '-30.0%' },
  ]);
});

it('baselines the delta on the best winrate, not policy order', () => {
  const parts = maiaDisplayParts([
    { move: 'e2e4', prob: 0.5, wdl: [0.5, 0.3, 0.2] },
    { move: 'd2d4', prob: 0.3, wdl: [0.2, 0.3, 0.5] },
  ]);
  // Policy top loses 30 points to the better winrate below it.
  expect(parts).toEqual([
    { prob: '50%', delta: '-30.0%' },
    { prob: '30%', delta: '0.0%' },
  ]);
});

it('prices the display list against the 2400 best, not its own max', () => {
  // 1400-popular Rg7 leads its own list at 55, but 2400 prefers Re6 at 60.
  const parts = maiaDisplayParts(
    [
      { move: 'g7g7', prob: 0.04, wdl: [0.3, 0.3, 0.4] },
      { move: 'f3f3', prob: 0.09, wdl: [0.6, 0.2, 0.2] },
    ],
    60,
  );
  expect(parts).toEqual([
    { prob: '4%', delta: '-5.0%' },
    { prob: '9%', delta: '-30.0%' },
  ]);
});
