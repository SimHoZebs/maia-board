import { describe, expect, it } from 'vitest';
import { START_FEN } from '../shared/domain';
import { walkObjectiveLine, type WalkScore, type WalkTop } from './bestLine';

const top = (uci: string): WalkTop => ({ kind: 'top', uci });
const none: WalkTop = { kind: 'none' };
const missing: WalkTop = { kind: 'missing' };
const cp = (value: number): WalkScore => ({ kind: 'score', score: { type: 'cp', value } });
const mateFor = (side: 'white' | 'black'): WalkScore => ({
  kind: 'score',
  score: { type: 'mate', value: 1, winning_side: side },
});
const sfMissing: WalkScore = { kind: 'missing' };
const sfNone: WalkScore = { kind: 'none' };

describe('walkObjectiveLine', () => {
  it('walks tops to the window cap', () => {
    const tops = ['e2e4', 'e7e5', 'g1f3'];
    const walk = walkObjectiveLine({
      initialFen: START_FEN,
      baseMoves: [],
      maxPlies: 3,
      topAt: moves => top(tops[moves.length]),
      sfAt: () => cp(0),
    });
    expect(walk.ucis).toEqual(tops);
    expect(walk.stop).toBe('complete');
    expect(walk.maiaFrontier).toBeNull();
    expect(walk.sfFrontier).toBeNull();
  });

  it('names the maia frontier when the next top is unfetched', () => {
    const walk = walkObjectiveLine({
      initialFen: START_FEN,
      baseMoves: ['e2e4'],
      maxPlies: 3,
      topAt: moves => (moves.length <= 1 ? top('e7e5') : missing),
      sfAt: () => cp(0),
    });
    expect(walk.ucis).toEqual(['e7e5']);
    expect(walk.stop).toBe('need-maia');
    expect(walk.maiaFrontier).toEqual(['e2e4', 'e7e5']);
    expect(walk.sfFrontier).toBeNull();
  });

  it('ends honestly when the lane settles without a top', () => {
    const walk = walkObjectiveLine({
      initialFen: START_FEN,
      baseMoves: [],
      maxPlies: 3,
      topAt: moves => (moves.length === 0 ? top('e2e4') : none),
      sfAt: () => cp(0),
    });
    expect(walk.ucis).toEqual(['e2e4']);
    expect(walk.stop).toBe('settled');
  });

  it('stops on an illegal lane top and keeps the verified prefix', () => {
    const walk = walkObjectiveLine({
      initialFen: START_FEN,
      baseMoves: [],
      maxPlies: 3,
      topAt: moves => (moves.length === 0 ? top('e2e4') : top('e2e4')),
      sfAt: () => cp(0),
    });
    expect(walk.ucis).toEqual(['e2e4']);
    expect(walk.stop).toBe('illegal');
  });

  it('includes a delivering mate then stops at the terminal', () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4#.
    const line = ['f2f3', 'e7e5', 'g2g4'];
    const walk = walkObjectiveLine({
      initialFen: START_FEN,
      baseMoves: line,
      maxPlies: 3,
      topAt: () => top('d8h4'),
      sfAt: () => cp(0),
    });
    expect(walk.ucis).toEqual(['d8h4']);
    expect(walk.stop).toBe('terminal');
  });

  it('vetoes a step that walks into cached forced mate, excluding it', () => {
    const walk = walkObjectiveLine({
      initialFen: START_FEN,
      baseMoves: ['e2e4'],
      maxPlies: 3,
      topAt: () => top('e7e5'),
      // Synthetic gate check: child is White to move with mate for White,
      // so Black's stepped reply hangs mate and must not be suggested.
      sfAt: () => mateFor('white'),
    });
    expect(walk.ucis).toEqual([]);
    expect(walk.stop).toBe('vetoed');
  });

  it('keeps the step but names the sf frontier when verification is missing', () => {
    const walk = walkObjectiveLine({
      initialFen: START_FEN,
      baseMoves: [],
      maxPlies: 3,
      topAt: () => top('e2e4'),
      sfAt: moves => (moves.length <= 1 ? sfMissing : cp(0)),
    });
    expect(walk.ucis).toEqual(['e2e4']);
    expect(walk.stop).toBe('need-sf');
    expect(walk.sfFrontier).toEqual(['e2e4']);
  });

  it('keeps the step and ends when the referee failed', () => {
    const walk = walkObjectiveLine({
      initialFen: START_FEN,
      baseMoves: [],
      maxPlies: 3,
      topAt: moves => (moves.length === 0 ? top('e2e4') : none),
      sfAt: () => sfNone,
    });
    expect(walk.ucis).toEqual(['e2e4']);
    expect(walk.stop).toBe('settled');
  });

  it('clamps the window to the display cap', () => {
    const walk = walkObjectiveLine({
      initialFen: START_FEN,
      baseMoves: [],
      maxPlies: 99,
      topAt: moves => top(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'e7e6'][moves.length]),
      sfAt: () => cp(0),
    });
    expect(walk.ucis).toHaveLength(5);
    expect(walk.stop).toBe('complete');
  });
});
