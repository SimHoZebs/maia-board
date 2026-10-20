// Explicit-state helpers: `undefined` is always a failure, never a state.
// Normal states use discriminated unions or `null` with a single documented
// meaning. Reach for these instead of `?.` / `?? default` chains that merge
// missing, corrupt, loading, and inactive into one silent fallback.
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`maia-board invariant: ${message}`);
}

export function expectDefined<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(`maia-board invariant: ${message}`);
  return value;
}

export function expectNonNull<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(`maia-board invariant: ${message}`);
  return value;
}

// Per-ply read from a node-aligned array. Out-of-range and holes are
// failures (throw); `null` is the explicit no-value-at-this-ply state that
// producers write and consumers branch on. Never return `undefined` here.
export function plyAt<T>(values: readonly T[], ply: number, what: string): T {
  if (!Number.isInteger(ply) || ply < 0 || ply >= values.length)
    throw new Error(`maia-board invariant: ${what} ply ${ply} out of range (len ${values.length})`);
  const value: unknown = values[ply];
  if (value === undefined) throw new Error(`maia-board invariant: ${what} ply ${ply} is undefined`);
  return value as T;
}

// Lenient per-ply read for render sites where the array may legitimately be
// shorter than the move list (e.g. an inactive room with an empty quality
// array). Out-of-range reads as null (no value); holes still throw.
export function plyOrNull<T>(values: readonly (T | null)[], ply: number, what: string): T | null {
  if (!Number.isInteger(ply) || ply < 0 || ply >= values.length) return null;
  const value: unknown = values[ply];
  if (value === undefined) throw new Error(`maia-board invariant: ${what} ply ${ply} is undefined`);
  return value as T | null;
}
