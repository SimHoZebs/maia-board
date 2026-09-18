import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ARROW_WIDTH_MAX, ARROW_WIDTH_MIN, buildReviewBrushes, defaultArrowSettings, normalizeArrowSettings, sameArrowSettings } from './arrowSettings';
import { reviewBrushes, reviewShapes } from './reviewArrows';
import { initialState, reducer } from './state/index';
import { KEYS } from './storage';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
});

describe('arrow settings', () => {
  it('keeps defaults aligned with the legacy brushes and e2e expectations', () => {
    expect(defaultArrowSettings).toEqual({
      actual: { color: '#ffffff', width: 12 },
      maia: { color: '#ef4444', width: 8 },
      stockfish: { color: '#3b82f6', width: 4 },
      candidate: { color: '#d6b85c', width: 2 },
    });
    expect(ARROW_WIDTH_MIN).toBe(1);
    expect(ARROW_WIDTH_MAX).toBe(64);
    expect(reviewBrushes.actual).toMatchObject({ color: '#ffffff', opacity: 0.45, lineWidth: 12 });
    expect(reviewBrushes.maia).toMatchObject({ color: '#ef4444', opacity: 0.45, lineWidth: 8 });
    expect(reviewBrushes.stockfish).toMatchObject({ color: '#3b82f6', opacity: 0.45, lineWidth: 4 });
    expect(reviewBrushes.candidate).toMatchObject({ color: '#d6b85c', opacity: 0.65, lineWidth: 2 });
  });
  it('normalizes junk storage to defaults', () => {
    expect(normalizeArrowSettings(null)).toBe(defaultArrowSettings);
    expect(normalizeArrowSettings('wide')).toBe(defaultArrowSettings);
    expect(normalizeArrowSettings({})).toBe(defaultArrowSettings);
    expect(normalizeArrowSettings({ actual: { color: 'red', width: 999 } })).toBe(defaultArrowSettings);
    expect(normalizeArrowSettings({ maia: { color: '#abc', width: 8 } }).maia).toBe(defaultArrowSettings.maia);
    expect(normalizeArrowSettings({ stockfish: { color: '#3b82f6', width: 12.5 } }).stockfish).toBe(defaultArrowSettings.stockfish);
    expect(normalizeArrowSettings({ candidate: { color: 'junk', width: 0 } }).candidate).toBe(defaultArrowSettings.candidate);
  });
  it('accepts the full cell-width ceiling and canonicalizes hex case', () => {
    const settings = normalizeArrowSettings({ actual: { color: '#FFFFFF', width: 64 }, maia: { color: '#ef4444', width: 1 } });
    expect(settings.actual).toEqual({ color: '#ffffff', width: 64 });
    expect(settings.maia).toEqual({ color: '#ef4444', width: 1 });
    expect(settings.stockfish).toBe(defaultArrowSettings.stockfish);
    expect(sameArrowSettings(settings, defaultArrowSettings)).toBe(false);
    expect(sameArrowSettings(defaultArrowSettings, normalizeArrowSettings(undefined))).toBe(true);
  });
  it('builds brushes from settings with fixed opacities', () => {
    const brushes = buildReviewBrushes(normalizeArrowSettings({ actual: { color: '#00ff00', width: 64 } }));
    expect(brushes.actual).toMatchObject({ key: 'actual', color: '#00ff00', opacity: 0.45, lineWidth: 64 });
    expect(brushes.candidate.opacity).toBe(0.65);
    expect(brushes.green.lineWidth).toBe(10);
  });
  it('embeds the arrow style in the shape hash so live edits repaint', () => {
    const moves = { actual: 'e2e4', maia: 'e2e4', stockfish: 'e2e4' } as const;
    const toggles = { actual: true, maia: true, stockfish: true } as const;
    const base = reviewShapes({ ...moves }, { ...toggles }, null, null, defaultArrowSettings);
    const custom = reviewShapes({ ...moves }, { ...toggles }, null, null, normalizeArrowSettings({ actual: { color: '#00ff00', width: 64 } }));
    expect(base.map(shape => shape.brush)).toEqual(['actual', 'maia', 'stockfish']);
    expect(custom.map(shape => shape.brush)).toEqual(['actual', 'maia', 'stockfish']);
    expect(JSON.stringify(base)).not.toBe(JSON.stringify(custom));
    // Back-compat: omitting settings keeps the legacy signature working.
    expect(reviewShapes({ ...moves }, { ...toggles }).map(shape => shape.brush)).toEqual(['actual', 'maia', 'stockfish']);
  });
  it('merges single-source edits, resets, and restores persisted arrows', () => {
    expect(initialState().arrows).toBe(defaultArrowSettings);
    const edited = reducer(initialState(), { type: 'arrow-settings', source: 'maia', style: { color: '#00ff00', width: 64 } });
    expect(edited.arrows.maia).toEqual({ color: '#00ff00', width: 64 });
    expect(edited.arrows.actual).toBe(defaultArrowSettings.actual);
    expect(reducer(edited, { type: 'arrow-settings', source: 'maia', style: { color: '#00ff00', width: 64 } })).toBe(edited);
    expect(reducer(edited, { type: 'arrow-settings', source: 'maia', style: { color: 'junk', width: 99 } }).arrows.maia).toEqual(defaultArrowSettings.maia);
    const reset = reducer(edited, { type: 'arrow-settings-reset' });
    expect(reset.arrows).toBe(defaultArrowSettings);
    expect(reducer(reset, { type: 'arrow-settings-reset' })).toBe(reset);
    localStorage.setItem(KEYS.arrows, JSON.stringify({ stockfish: { color: '#00ff00', width: 64 } }));
    expect(initialState().arrows.stockfish).toEqual({ color: '#00ff00', width: 64 });
    localStorage.setItem(KEYS.arrows, JSON.stringify('wide'));
    expect(initialState().arrows).toBe(defaultArrowSettings);
  });
});
