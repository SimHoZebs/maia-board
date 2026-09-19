import { expect, it } from 'vitest';
import { candidatesFor, deltaBaseline, deltaColumnTitle, fixedElo, formatWinrateDelta, lanePoints, maiaDisplayParts, maiaExpected, maiaPoint, maiaWhiteWdl } from './maia';

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

it('falls back to delta vs best winrate without a baseline', () => {
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

it('falls back to the best winrate, not policy order', () => {
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

it('prices the display list against the before-position winrate (gain)', () => {
  // Before-position 2400 winrate is 33; candidates at 70 and 66 read as
  // gains of +37 and +33 for the side to move.
  const parts = maiaDisplayParts(
    [
      { move: 'f6f7', prob: 0.87, wdl: [0.14, 0.32, 0.54] },
      { move: 'e7e6', prob: 0.12, wdl: [0.18, 0.32, 0.5] },
    ],
    33,
  );
  expect(parts).toEqual([
    { prob: '87%', delta: '+37.0%' },
    { prob: '12%', delta: '+33.0%' },
  ]);
});

it('selects the before point over the best listed winrate', () => {
  expect(deltaBaseline(53.15, 53.8)).toEqual({ baseline: 53.15, kind: 'before' });
  expect(deltaBaseline(null, 53.8)).toEqual({ baseline: 53.8, kind: 'best' });
  expect(deltaBaseline(null, null)).toEqual({ baseline: null, kind: null });
});

it('titles the column from the baseline source', () => {
  expect(deltaColumnTitle('before')).toBe('Win-rate delta versus position before move');
  expect(deltaColumnTitle('best')).toBe('Win-rate change versus 2400 best');
  expect(deltaColumnTitle(null)).toBe('Win-rate change versus best listed move');
});

it('wires the panel assembly over real startpos data: top defines the bar', () => {
  // Live Maia 2400 startpos row: the position triple IS e2e4's triple.
  const posWdl: [number, number, number] = [0.437, 0.063, 0.5];
  const topMoves: { move: string; prob: number; wdl: [number, number, number] }[] = [
    { move: 'e2e4', prob: 0.466, wdl: posWdl },
    { move: 'd2d4', prob: 0.335, wdl: [0.435, 0.066, 0.499] },
    { move: 'g1f3', prob: 0.083, wdl: [0.427, 0.07, 0.503] },
  ];
  const before = maiaExpected(posWdl);
  expect(before).toBe(maiaExpected(topMoves[0].wdl));
  const best = Math.max(...topMoves.map(candidate => maiaExpected(candidate.wdl)));
  const { baseline, kind } = deltaBaseline(before, best);
  expect(kind).toBe('before');
  const parts = maiaDisplayParts(topMoves, baseline);
  expect(parts[0]).toEqual({ prob: '47%', delta: '0.0%' });
  expect(parts[2]).toEqual({ prob: '8%', delta: '+0.7%' });
});

it('keeps deltas side-to-move-relative: Black gains read positive', () => {
  // Live Maia 2400 row after 1. e4, Black to move: c5 defines 47.0, e5
  // reaches 48.1 — good for the mover, so positive.
  const topMoves: { move: string; prob: number; wdl: [number, number, number] }[] = [
    { move: 'c7c5', prob: 0.378, wdl: [0.5, 0.06, 0.44] },
    { move: 'e7e5', prob: 0.175, wdl: [0.488, 0.062, 0.45] },
  ];
  const before = maiaExpected(topMoves[0].wdl);
  const { baseline, kind } = deltaBaseline(before, null);
  expect(kind).toBe('before');
  const parts = maiaDisplayParts(topMoves, baseline);
  expect(parts[0]).toEqual({ prob: '38%', delta: '0.0%' });
  expect(parts[1]).toEqual({ prob: '18%', delta: '+1.1%' });
});
