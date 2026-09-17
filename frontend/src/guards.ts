// Shared runtime type guards: the honest alternative to `as` casts at
// unknown boundaries (wire JSON, storage, worker output). Narrow with these
// instead of asserting — a cast claims a type, a guard proves it.
import type { StockfishSettings } from './stockfishSettings';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string');
}

// Stockfish search provenance: integer fields only. Range/equality against
// the request stays in actualPolicy so present-but-wrong settings still throw
// 'incompatible' exactly as before instead of silently falling back.
export function isStockfishSettings(value: unknown): value is StockfishSettings {
  return isRecord(value) && Number.isInteger(value.time_ms) && Number.isInteger(value.lines) && Number.isInteger(value.depth);
}

// Single quarantined Object.keys assertion: lib types return string[], but a
// fixed object literal's keys are exactly keyof T. Centralize here so call
// sites (ReviewCharts loading deck) never assert.
export function objectKeys<T extends object>(obj: T): (keyof T)[] {
  return Object.keys(obj) as (keyof T)[];
}
