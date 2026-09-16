import { useEffect, useMemo, useState } from 'react';
import { lineKeyFor } from './domain';

export type Opening = { eco: string; name: string; matchedPly: number; isExact: boolean };
export type OpeningMatch = { ply: number; eco: string; name: string };
type LineOpenings = { matches: OpeningMatch[]; bookFlags: boolean[] };

// One fetch per line, shared by every workspace and panel mounted on it.
// Entries graduate from in-flight promises to settled results; failures
// evict so a later mount retries instead of caching the outage.
const lineCache = new Map<string, LineOpenings | Promise<LineOpenings>>();

/** Test seam: drop all cached lines. */
export function clearLineOpeningsCache(): void {
  lineCache.clear();
}

function isMatch(value: unknown): value is OpeningMatch {
  if (typeof value !== 'object' || value === null) return false;
  const match = value as Record<string, unknown>;
  return Number.isInteger(match.ply) && typeof match.eco === 'string' && typeof match.name === 'string';
}

export async function fetchLineOpenings(
  moves: string[],
  initialFen: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<LineOpenings> {
  const response = await fetcher('/openings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ moves, initial_fen: initialFen }),
    signal,
  });
  if (!response.ok) throw new Error(`Opening lookup failed (${response.status}).`);
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null) throw new Error('Opening lookup returned an unexpected response.');
  const { matches, book_flags } = body as Record<string, unknown>;
  if (!Array.isArray(matches) || !matches.every(isMatch)) throw new Error('Opening lookup returned an unexpected response.');
  if (!Array.isArray(book_flags) || book_flags.length !== moves.length || !book_flags.every((flag): flag is boolean => typeof flag === 'boolean')) {
    throw new Error('Opening lookup returned an unexpected response.');
  }
  return { matches, bookFlags: book_flags };
}

/** Deepest named ancestor at or before atPly. Empty lines name nothing. */
export function openingAt(matches: OpeningMatch[], atPly: number): Opening | null {
  if (atPly <= 0) return null;
  let deepest: OpeningMatch | null = null;
  for (const match of matches) if (match.ply <= atPly && match.ply > 0) deepest = match;
  return deepest
    ? { eco: deepest.eco, name: deepest.name, matchedPly: deepest.ply, isExact: deepest.ply === atPly }
    : null;
}

export function useLineOpenings(
  moves: string[],
  initialFen: string,
  atPly: number,
): { opening: Opening | null; bookFlags: boolean[] } {
  const lineKey = useMemo(() => lineKeyFor(initialFen, moves), [initialFen, moves]);
  const [line, setLine] = useState<LineOpenings | null>(() => {
    const entry = lineCache.get(lineKey);
    return entry && !(entry instanceof Promise) ? entry : null;
  });
  useEffect(() => {
    // A line change or unmount abandons this fetch: the lineKey guard drops
    // late arrivals so a new line never inherits another line's book.
    let cancelled = false;
    const entry = lineCache.get(lineKey);
    if (entry && !(entry instanceof Promise)) {
      setLine(entry);
      return;
    }
    const controller = new AbortController();
    const pending = entry instanceof Promise ? entry : fetchLineOpenings(moves, initialFen, controller.signal);
    lineCache.set(lineKey, pending);
    void pending.then(
      (result) => {
        if (lineCache.get(lineKey) === pending) lineCache.set(lineKey, result);
        if (!cancelled) setLine(result);
      },
      () => {
        if (lineCache.get(lineKey) === pending) lineCache.delete(lineKey);
        if (!cancelled) setLine(null);
      },
    );
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [lineKey]);
  return useMemo(() => {
    if (!line) return { opening: null, bookFlags: moves.map(() => false) };
    return { opening: openingAt(line.matches, atPly), bookFlags: line.bookFlags };
  }, [line, moves, atPly]);
}
