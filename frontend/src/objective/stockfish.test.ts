import { expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { SEARCH_POLICY, reviewMove, whiteWin, type Evaluation } from '../reviewMetrics';
import { candidatesFor, sfPoint } from './stockfish';

const evaluation = (cp: number, best = 'e2e4'): Evaluation => ({
  engine: 'Stockfish 19', search_policy: SEARCH_POLICY, score: { type: 'cp', value: cp },
  depth: 14, best_move: best, lines: [], terminal: null,
});

it('reads mover-relative points from evaluations, both colors', () => {
  expect(sfPoint(undefined, 'white')).toEqual({ top: null, expected: null });
  expect(sfPoint(evaluation(100), 'white')).toEqual({ top: 'e2e4', expected: whiteWin({ type: 'cp', value: 100 }) });
  const black = sfPoint(evaluation(100), 'black');
  expect(black.top).toBe('e2e4');
  expect(black.expected!).toBeCloseTo(100 - whiteWin({ type: 'cp', value: 100 }), 9);
  // Terminal outcome rows flow through the same score shapes.
  expect(sfPoint({ ...evaluation(0), score: { type: 'mate', value: 0, winning_side: 'white' }, best_move: null }, 'white'))
    .toEqual({ top: null, expected: 100 });
});

it('stockfish-sourced objectives reproduce the legacy pure-engine grades', () => {
  // The reversibility proof: grading through sfPoint-built objectives must
  // equal grading without an objective lane on every label family.
  const cases: { before: Evaluation; after: Evaluation; game: Chess; played: string }[] = [
    { before: evaluation(600, 'g1f3'), after: evaluation(0), game: new Chess(), played: 'e2e4' }, // Blunder
    { before: evaluation(60, 'g1f3'), after: evaluation(-60), game: new Chess(), played: 'e2e4' }, // Mistake
    { before: evaluation(20), after: evaluation(10), game: new Chess(), played: 'd2d4' }, // Holds
    { before: evaluation(600, 'g1f3'), after: evaluation(600), game: new Chess(), played: 'g1f3' }, // Top
  ];
  const critical = evaluation(200);
  critical.lines = [
    { move: 'e2e4', score: critical.score, depth: 14 },
    { move: 'd2d4', score: { type: 'cp', value: 0 }, depth: 14 },
  ];
  cases.push({ before: critical, after: critical, game: new Chess(), played: 'e2e4' }); // Critical
  const mateAfter = { ...evaluation(0), score: { type: 'mate' as const, value: -1, winning_side: 'black' as const } };
  const mateBefore = evaluation(-1000); mateBefore.best_move = 'g1f3';
  cases.push({ before: mateBefore, after: mateAfter, game: new Chess(), played: 'e2e4' }); // Allowed mate
  for (const { before, after, game, played } of cases) {
    const mover = game.turn() === 'w' ? 'white' : 'black';
    const opp = mover === 'white' ? 'black' : 'white';
    const beforePoint = sfPoint(before, mover);
    const afterPoint = sfPoint(after, opp);
    const objective = {
      top: beforePoint.top,
      expected: beforePoint.expected,
      afterExpected: afterPoint.expected === null ? null : 100 - afterPoint.expected,
      beforePending: false,
      afterPending: false,
    };
    const graded = reviewMove(before, after, game, played, objective);
    const legacy = reviewMove(before, after, game, played);
    expect(graded.label).toBe(legacy.label);
    expect(graded.loss ?? 0).toBeCloseTo(legacy.loss ?? 0, 9);
  }
});

it('lists engine lines with mover-relative expectations, terminal rows fall back', () => {
  const node = { fen: '', turn: 'white' } as never;
  expect(candidatesFor(undefined, node)).toBeUndefined();
  const lines = [
    { move: 'e2e4', score: { type: 'cp' as const, value: 100 }, depth: 14 },
    { move: 'd2d4', score: { type: 'cp' as const, value: -100 }, depth: 14 },
  ];
  const white = candidatesFor({ engine: 'Stockfish 19', search_policy: SEARCH_POLICY, score: lines[0].score,
    depth: 14, best_move: 'e2e4', lines, terminal: null }, node);
  expect(white?.entries.map(entry => entry.uci)).toEqual(['e2e4', 'd2d4']);
  expect(white?.entries[0].expected).toBeGreaterThan(50);
  expect(white?.entries[1].expected).toBeLessThan(50);
  expect(white).toMatchObject({ modelUsed: null, requestedModel: null, degraded: false });
  const blackNode = { fen: '', turn: 'black' } as never;
  const black = candidatesFor({ engine: 'Stockfish 19', search_policy: SEARCH_POLICY, score: lines[0].score,
    depth: 14, best_move: 'e2e4', lines, terminal: null }, blackNode);
  expect(black?.entries[0].expected).toBeCloseTo(100 - white!.entries[0].expected, 9);
  expect(candidatesFor({ engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 0, terminal: 'draw',
    best_move: null, lines: [], score: { type: 'cp' as const, value: 0 } }, node)).toBeUndefined();
});
