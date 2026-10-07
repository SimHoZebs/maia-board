import { describe, expect, it } from 'vitest';
import { applyPreset, buildLabVerdict, DEFAULT_STATE, PRESETS } from './verdictLabModel';

function verdictFor(id: string) {
  const result = buildLabVerdict(applyPreset(DEFAULT_STATE, id));
  return { verdict: result.verdict, rules: result.rules, facts: result.facts, trace: result.trace };
}

describe('verdict lab presets', () => {
  it('covers the eleven planned presets', () => {
    expect(PRESETS.map(preset => preset.id)).toEqual([
      'common-mistake', 'rare-find', 'alien', 'allowed-mate-pin', 'book-hit',
      'novelty-bright-spot', 'scholars-mate', 'hard-to-avoid', 'underpromotion', 'dead-draw',
      'forced-move',
    ]);
  });

  it('grades a 14.6-point loss as a common mistake', () => {
    const { verdict, rules, trace } = verdictFor('common-mistake');
    expect(trace.engineGrade.label).toBe('Mistake');
    expect(trace.engineGrade.loss).toBeCloseTo(14.6, 1);
    expect(verdict).toBe('A common mistake.');
    expect(rules).toEqual({ standalone: null, note: null });
  });

  it('renders the exceptional find with a blind-spot note', () => {
    const { verdict, rules, trace } = verdictFor('rare-find');
    expect(trace.engineGrade.label).toBe('Critical');
    expect(trace.rarity.label).toBe('Absent');
    expect(trace.rarity2400.label).toBe('Rare');
    expect(verdict).toBe('An exceptional find. Even 2400s rarely play this.');
    expect(rules).toEqual({ standalone: null, note: 'blind-spot' });
  });

  it('upgrades to Alien on a 35-point gap', () => {
    const { verdict, rules, trace } = verdictFor('alien');
    expect(trace.sfGap).toBeGreaterThanOrEqual(30);
    expect(verdict).toBe('An alien find. Stockfish sees nothing else that holds.');
    expect(rules).toEqual({ standalone: null, note: 'only-move' });
  });

  it('fuses the pin with mate behind a hard-to-avoid head', () => {
    const { verdict, rules, trace } = verdictFor('allowed-mate-pin');
    expect(trace.engineGrade.label).toBe('Allowed mate');
    expect(verdict).toBe('Hard to avoid at your level. Pins the queen to the king, but allows mate.');
    expect(rules).toEqual({ standalone: 'pin-allowed-mate', note: null });
  });

  it('names the book hit standalone', () => {
    const { verdict, rules } = verdictFor('book-hit');
    expect(verdict).toBe('Bc4 — Italian Game (C50).');
    expect(rules).toEqual({ standalone: 'book', note: null });
  });

  it('prefixes novelty ahead of the bright-spot note', () => {
    const { verdict, rules, facts, trace } = verdictFor('novelty-bright-spot');
    expect(trace.rarity.label).toBe('Uncommon');
    expect(facts.novelty).toEqual({ priorName: 'French Defense', priorEco: 'C00' });
    expect(verdict).toBe('Leaves French Defense book. A sharp find. Stronger players play this regularly.');
    expect(rules).toEqual({ standalone: null, note: 'bright-spot' });
  });

  it('names Scholar\'s mate with terminal priority', () => {
    const { verdict, rules, facts } = verdictFor('scholars-mate');
    expect(facts.terminal).toBe('checkmate');
    expect(facts.matePatternName).toBe("Scholar's mate");
    expect(verdict).toBe("Scholar's mate.");
    expect(rules).toEqual({ standalone: 'checkmate', note: null });
  });

  it('reads hard-to-avoid as the whole head', () => {
    const { verdict, rules, trace } = verdictFor('hard-to-avoid');
    expect(trace.engineGrade.label).toBe('Blunder');
    expect(verdict).toBe('Hard to avoid at your level.');
    expect(rules).toEqual({ standalone: null, note: null });
  });

  it('proves the underpromotion avoids stalemate', () => {
    const { verdict, rules, facts } = verdictFor('underpromotion');
    expect(facts.underpromotionAvoids).toBe(true);
    expect(verdict).toBe('b8=N underpromotes to avoid stalemate.');
    expect(rules).toEqual({ standalone: 'underpromotion', note: null });
  });

  it('reads KNN vs K as a known dead draw', () => {
    const { verdict, rules, facts } = verdictFor('dead-draw');
    expect(facts.deadDraw).toBe(true);
    expect(verdict).toBe('Nb8 — known theoretical draw.');
    expect(rules).toEqual({ standalone: 'dead-draw', note: null });
  });

  it('reads the single legal move as forced', () => {
    const { verdict, rules, trace } = verdictFor('forced-move');
    expect(trace.legalMoves).toBe(1);
    expect(trace.engineGrade.label).toBe('Forced');
    expect(verdict).toBe('The only legal move.');
    expect(rules).toEqual({ standalone: 'forced', note: null });
  });

  it('sits the rarity bands on their real edges', () => {
    expect(verdictFor('novelty-bright-spot').trace.rarity.r).toBeCloseTo(0.15 / 0.35, 5);
    expect(verdictFor('rare-find').trace.rarity2400.r).toBeCloseTo(0.03 / 0.4, 5);
  });
});
