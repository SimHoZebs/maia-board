import type { DrawBrushes } from '@lichess-org/chessground/draw';

export type ArrowSettingsKey = 'actual' | 'maia' | 'stockfish' | 'candidate';
export type ArrowStyle = { color: string; width: number };
export type ArrowSettings = Record<ArrowSettingsKey, ArrowStyle>;

// Chessground renders arrow thickness as brush.lineWidth / 64 SVG units on a
// board that spans 8 units, so one square is exactly 1 unit wide. A width of
// 64 fills a square; no DOM measuring is needed to enforce the ceiling.
// Pin: @lichess-org/chessground ^10.1.1, svg.js lineWidth() = lineWidth / 64.
export const ARROW_WIDTH_MIN = 1;
export const ARROW_WIDTH_MAX = 64;

export const defaultArrowSettings: ArrowSettings = {
  actual: { color: '#ffffff', width: 12 },
  maia: { color: '#ef4444', width: 8 },
  stockfish: { color: '#3b82f6', width: 4 },
  candidate: { color: '#d6b85c', width: 2 },
};

const HEX_6 = /^#[0-9a-fA-F]{6}$/;
const normalizeStyle = (value: unknown, fallback: ArrowStyle): ArrowStyle => {
  if (typeof value !== 'object' || value === null) return fallback;
  const record = value as Record<string, unknown>;
  const color = typeof record.color === 'string' && HEX_6.test(record.color) ? record.color.toLowerCase() : fallback.color;
  const width = typeof record.width === 'number' && Number.isInteger(record.width) && record.width >= ARROW_WIDTH_MIN && record.width <= ARROW_WIDTH_MAX
    ? record.width : fallback.width;
  return color === fallback.color && width === fallback.width ? fallback : { color, width };
};

export function normalizeArrowSettings(value: unknown): ArrowSettings {
  if (typeof value !== 'object' || value === null) return defaultArrowSettings;
  const record = value as Record<string, unknown>;
  const next: ArrowSettings = {
    actual: normalizeStyle(record.actual, defaultArrowSettings.actual),
    maia: normalizeStyle(record.maia, defaultArrowSettings.maia),
    stockfish: normalizeStyle(record.stockfish, defaultArrowSettings.stockfish),
    candidate: normalizeStyle(record.candidate, defaultArrowSettings.candidate),
  };
  return next.actual === defaultArrowSettings.actual && next.maia === defaultArrowSettings.maia
    && next.stockfish === defaultArrowSettings.stockfish && next.candidate === defaultArrowSettings.candidate
    ? defaultArrowSettings : next;
}

export function sameArrowSettings(a: ArrowSettings, b: ArrowSettings): boolean {
  return (['actual', 'maia', 'stockfish', 'candidate'] as const).every(key =>
    a[key].color === b[key].color && a[key].width === b[key].width);
}

// Opacities stay fixed (the request covers color + size only): actual, maia
// and stockfish share .45 so coincident arrows layer by width; the preview
// candidate stays slightly stronger at .65.
export function buildReviewBrushes(settings: ArrowSettings): DrawBrushes {
  return {
    green: { key: 'g', color: '#15781B', opacity: 1, lineWidth: 10 },
    red: { key: 'r', color: '#882020', opacity: 1, lineWidth: 10 },
    blue: { key: 'b', color: '#003088', opacity: 1, lineWidth: 10 },
    yellow: { key: 'y', color: '#e68f00', opacity: 1, lineWidth: 10 },
    actual: { key: 'actual', color: settings.actual.color, opacity: 0.45, lineWidth: settings.actual.width },
    maia: { key: 'maia', color: settings.maia.color, opacity: 0.45, lineWidth: settings.maia.width },
    stockfish: { key: 'stockfish', color: settings.stockfish.color, opacity: 0.45, lineWidth: settings.stockfish.width },
    candidate: { key: 'candidate', color: settings.candidate.color, opacity: 0.65, lineWidth: settings.candidate.width },
  };
}
