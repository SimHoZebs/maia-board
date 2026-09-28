import { expect, it } from 'vitest';
import { candidatesFor, fixedElo, lanePoints } from './grader';

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
    { uci: 'e2e4', expected: 65, prob: 0.5, delta: null },
    { uci: 'd2d4', expected: 35, prob: 0.3, delta: null },
  ]);
  expect(list).toMatchObject({ degraded: false, baseline: null });
  // Server-attached deltas ride through to the panel selector inputs.
  const attached = candidatesFor({
    move: 'e2e4',
    top_moves: [
      { move: 'e2e4', prob: 0.5, wdl: [0.2, 0.3, 0.5], delta: 0 },
      { move: 'd2d4', prob: 0.3, wdl: [0.5, 0.3, 0.2], delta: -30 },
    ],
    wdl: [0.2, 0.3, 0.5], model_used: '79m', degraded: false,
    delta_baseline: { value: 65, kind: 'before' },
  }, node);
  expect(attached?.baseline).toEqual({ value: 65, kind: 'before' });
  expect(attached?.entries.map(entry => entry.delta)).toEqual([0, -30]);
});

it('pins the panel dropdown to 2400', () => {
  expect(fixedElo()).toBe(2400);
});
