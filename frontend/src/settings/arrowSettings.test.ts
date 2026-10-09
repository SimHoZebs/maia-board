import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ARROW_WIDTH_MAX, ARROW_WIDTH_MIN, buildReviewBrushes, defaultArrowBasis, defaultArrowSettings, normalizeArrowBasis, normalizeArrowSettings, sameArrowSettings } from './arrowSettings';
import { reviewBrushes, reviewShapes } from '../review/reviewArrows';
import { initialState, reducer } from '../state/index';
import { KEYS } from '../history/storage';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
});

describe('arrow settings', () => {
  it('keeps defaults aligned with the legacy brushes and e2e expectations', () => {
    expect(defaultArrowSettings).toEqual({
      actual: { color: '#ffffff', width: 12 },
      bot: { color: '#ef4444', width: 8 },
      objective: { color: '#3b82f6', width: 4 },
      stockfish: { color: '#facc15', width: 6 },
      next: { color: '#92400e', width: 10 },
    });
    expect(defaultArrowBasis).toBe('past');
    expect(normalizeArrowBasis('past')).toBe('past');
    expect(normalizeArrowBasis('next')).toBe('next');
    expect(normalizeArrowBasis('junk')).toBe('past');
    expect(ARROW_WIDTH_MIN).toBe(1);
    expect(ARROW_WIDTH_MAX).toBe(64);
    expect(reviewBrushes.actual).toMatchObject({ color: '#ffffff', opacity: 0.45, lineWidth: 12 });
    expect(reviewBrushes.bot).toMatchObject({ color: '#ef4444', opacity: 0.45, lineWidth: 8 });
    expect(reviewBrushes.objective).toMatchObject({ color: '#3b82f6', opacity: 0.45, lineWidth: 4 });
    expect(reviewBrushes.stockfish).toMatchObject({ color: '#facc15', opacity: 0.45, lineWidth: 6 });
    expect(reviewBrushes.next).toMatchObject({ color: '#92400e', opacity: 0.45, lineWidth: 10 });
  });
  it('normalizes junk storage to defaults', () => {
    expect(normalizeArrowSettings(null)).toBe(defaultArrowSettings);
    expect(normalizeArrowSettings('wide')).toBe(defaultArrowSettings);
    expect(normalizeArrowSettings({})).toBe(defaultArrowSettings);
    expect(normalizeArrowSettings({ actual: { color: 'red', width: 999 } })).toBe(defaultArrowSettings);
    expect(normalizeArrowSettings({ bot: { color: '#abc', width: 8 } }).bot).toBe(defaultArrowSettings.bot);
    expect(normalizeArrowSettings({ objective: { color: '#3b82f6', width: 12.5 } }).objective).toBe(defaultArrowSettings.objective);
    expect(normalizeArrowSettings({ next: { color: 'junk', width: 0 } }).next).toBe(defaultArrowSettings.next);
  });
  it('migrates the legacy stockfish key to the objective slot', () => {
    expect(normalizeArrowSettings({ stockfish: { color: '#00ff00', width: 64 } }).objective).toEqual({ color: '#00ff00', width: 64 });
  });
  it('keeps a legacy lone stockfish value off the Stockfish-best arrow', () => {
    // Old storage keyed the blue objective arrow 'stockfish' with no
    // objective sibling; that value migrates to objective only, leaving the
    // Stockfish-best arrow at its default until the user sets it.
    const migrated = normalizeArrowSettings({ stockfish: { color: '#00ff00', width: 64 } });
    expect(migrated.stockfish).toBe(defaultArrowSettings.stockfish);
    const current = normalizeArrowSettings({ objective: { color: '#3b82f6', width: 4 }, stockfish: { color: '#00ff00', width: 64 } });
    expect(current.stockfish).toEqual({ color: '#00ff00', width: 64 });
    expect(current.objective).toBe(defaultArrowSettings.objective);
  });
  it('migrates the legacy maia key to the bot slot, preferring the new key', () => {
    expect(normalizeArrowSettings({ maia: { color: '#00ff00', width: 64 } }).bot).toEqual({ color: '#00ff00', width: 64 });
    expect(normalizeArrowSettings({ bot: { color: '#0000ff', width: 16 }, maia: { color: '#00ff00', width: 64 } }).bot).toEqual({ color: '#0000ff', width: 16 });
  });
  it('accepts the full cell-width ceiling and canonicalizes hex case', () => {
    const settings = normalizeArrowSettings({ actual: { color: '#FFFFFF', width: 64 }, bot: { color: '#ef4444', width: 1 } });
    expect(settings.actual).toEqual({ color: '#ffffff', width: 64 });
    expect(settings.bot).toEqual({ color: '#ef4444', width: 1 });
    expect(settings.objective).toBe(defaultArrowSettings.objective);
    expect(sameArrowSettings(settings, defaultArrowSettings)).toBe(false);
    expect(sameArrowSettings(defaultArrowSettings, normalizeArrowSettings(undefined))).toBe(true);
  });
  it('builds brushes from settings with fixed opacities', () => {
    const brushes = buildReviewBrushes(normalizeArrowSettings({ actual: { color: '#00ff00', width: 64 } }));
    expect(brushes.actual).toMatchObject({ key: 'actual', color: '#00ff00', opacity: 0.45, lineWidth: 64 });
    expect(brushes.next.opacity).toBe(0.45);
    expect(brushes.green.lineWidth).toBe(10);
  });
  it('embeds the arrow style in the shape hash so live edits repaint', () => {
    const moves = { actual: 'e2e4', next: 'd2d4', bot: 'e2e4', objective: 'e2e4', stockfish: 'e2e4' } as const;
    const toggles = { actual: true, next: true, bot: true, objective: true, stockfish: true } as const;
    const base = reviewShapes({ ...moves }, { ...toggles }, null, defaultArrowSettings);
    const custom = reviewShapes({ ...moves }, { ...toggles }, null, normalizeArrowSettings({ actual: { color: '#00ff00', width: 64 } }));
    expect(base.map(shape => shape.brush)).toEqual(['actual', 'next', 'bot', 'stockfish', 'objective']);
    expect(custom.map(shape => shape.brush)).toEqual(['actual', 'next', 'bot', 'stockfish', 'objective']);
    expect(JSON.stringify(base)).not.toBe(JSON.stringify(custom));
    // Back-compat: omitting settings keeps the legacy signature working.
    expect(reviewShapes({ ...moves }, { ...toggles }).map(shape => shape.brush)).toEqual(['actual', 'next', 'bot', 'stockfish', 'objective']);
  });
  it('merges single-source edits, resets, and restores persisted arrows', () => {
    expect(initialState().arrows).toBe(defaultArrowSettings);
    expect(initialState().arrowBasis).toBe('past');
    const based = reducer(initialState(), { type: 'arrow-basis', basis: 'past' });
    expect(based.arrowBasis).toBe('past');
    expect(reducer(based, { type: 'arrow-basis', basis: 'past' })).toBe(based);
    const edited = reducer(initialState(), { type: 'arrow-settings', source: 'bot', style: { color: '#00ff00', width: 64 } });
    expect(edited.arrows.bot).toEqual({ color: '#00ff00', width: 64 });
    expect(edited.arrows.actual).toBe(defaultArrowSettings.actual);
    expect(reducer(edited, { type: 'arrow-settings', source: 'bot', style: { color: '#00ff00', width: 64 } })).toBe(edited);
    expect(reducer(edited, { type: 'arrow-settings', source: 'bot', style: { color: 'junk', width: 99 } }).arrows.bot).toEqual(defaultArrowSettings.bot);
    const reset = reducer(edited, { type: 'arrow-settings-reset' });
    expect(reset.arrows).toBe(defaultArrowSettings);
    expect(reducer(reset, { type: 'arrow-settings-reset' })).toBe(reset);
    localStorage.setItem(KEYS.arrows, JSON.stringify({ objective: { color: '#00ff00', width: 64 } }));
    expect(initialState().arrows.objective).toEqual({ color: '#00ff00', width: 64 });
    localStorage.setItem(KEYS.arrows, JSON.stringify({ stockfish: { color: '#00ff00', width: 32 } }));
    expect(initialState().arrows.objective).toEqual({ color: '#00ff00', width: 32 });
    localStorage.setItem(KEYS.arrows, JSON.stringify('wide'));
    expect(initialState().arrows).toBe(defaultArrowSettings);
  });
});
