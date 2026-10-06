import { SEARCH_POLICY } from './reviewMetrics';

export type StockfishSettings = { time_ms: number; lines: number; depth: number };
export const STOCKFISH_STORAGE_KEY = 'maia.stockfish.v1';
// lines stays in the type + policy string for wire/cache compat, but is
// hardcoded to 1 (mate + rank-1 PV only). Old stored values with lines 2-5
// normalize down, so no storage migration is needed. The backend still
// accepts 1-5 so old mpv2+ cached rows keep serving via superset slicing.
export const defaultStockfishSettings: StockfishSettings = { time_ms: 750, lines: 1, depth: 0 };
export function normalizeStockfishSettings(value?: Partial<StockfishSettings> | null): StockfishSettings {
  const integer = (n: unknown, min: number, max: number, fallback: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
  return { time_ms: integer(value?.time_ms, 250, 30000, 750), lines: 1, depth: integer(value?.depth, 0, 40, 0) };
}
export function stockfishPolicy(settings?: StockfishSettings): string {
  return settings ? `sf19-ms${settings.time_ms}-mpv${settings.lines}-d${settings.depth}-t4-h128-v3` : SEARCH_POLICY;
}
