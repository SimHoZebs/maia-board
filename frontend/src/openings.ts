import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Chess } from 'chess.js';
import { START_FEN, buildTimeline } from './domain';

export type OpeningTable = Record<string, readonly [eco: string, name: string]>;
export type Opening = { eco: string; name: string; matchedPly: number; isExact: boolean };

// EPD key: FEN without move counters, en-passant square only when a capture is
// actually legal. Must stay identical to epdKey() in scripts/build-openings.mjs.
export function epdKey(fen: string): string {
  const normalized = new Chess(fen).fen().split(' ');
  let ep = normalized[3];
  if (ep !== '-') {
    const probe = new Chess(fen);
    if (!probe.moves({ verbose: true }).some((move) => move.isEnPassant())) ep = '-';
  }
  return `${normalized[0]} ${normalized[1]} ${normalized[2]} ${ep}`;
}

function isStandardStart(initialFen: string): boolean {
  try {
    return new Chess(initialFen).fen() === START_FEN;
  } catch {
    return false;
  }
}

export function exactOpeningAt(table: OpeningTable, fen: string): { eco: string; name: string } | null {
  let key: string;
  try {
    key = epdKey(fen);
  } catch {
    return null;
  }
  const entry = table[key];
  return entry ? { eco: entry[0], name: entry[1] } : null;
}

// Deepest named ancestor at or before atPly. The book is defined from the
// standard start only; custom-start lines return null.
export function openingForLine(table: OpeningTable, moves: string[], initialFen = START_FEN, atPly = moves.length): Opening | null {
  if (!isStandardStart(initialFen)) return null;
  const timeline = buildTimeline(initialFen, moves);
  const clamped = Math.max(0, Math.min(atPly, moves.length));
  let found: { eco: string; name: string; matchedPly: number } | null = null;
  for (let ply = 0; ply <= clamped; ply++) {
    const hit = exactOpeningAt(table, timeline.rows[ply].fen);
    if (hit) found = { ...hit, matchedPly: ply };
  }
  return found ? { ...found, isExact: found.matchedPly === clamped } : null;
}

// Exact-hit flags per move for book icons: flags[i] names the position after
// moves[i]. Aligned with the resolved line passed in (branch-aware callers pass
// their resolved moves).
export function bookFlagsForLine(table: OpeningTable, moves: string[], initialFen = START_FEN): boolean[] {
  if (!isStandardStart(initialFen)) return moves.map(() => false);
  const timeline = buildTimeline(initialFen, moves);
  return moves.map((_, index) => exactOpeningAt(table, timeline.rows[index + 1].fen) !== null);
}

// Lazy book chunk: the generated map (~470 KiB source) stays out of the main
// bundle and parses on first Play/Analyze mount. Unloaded lookups render
// nothing; the subscription re-renders once the chunk lands.
let table: OpeningTable | null = null;
let tableVersion = 0;
const tableListeners = new Set<() => void>();
let tablePending: Promise<OpeningTable> | null = null;

export function loadOpenings(): Promise<OpeningTable> {
  if (table) return Promise.resolve(table);
  if (!tablePending) {
    tablePending = import('./openings.generated').then((mod) => {
      table = mod.OPENINGS as OpeningTable;
      tableVersion++;
      tableListeners.forEach((listener) => listener());
      return table;
    }).catch((error) => {
      tablePending = null;
      throw error;
    });
  }
  return tablePending;
}

function subscribeOpenings(listener: () => void): () => void {
  tableListeners.add(listener);
  return () => {
    tableListeners.delete(listener);
  };
}

export function useLineOpenings(
  moves: string[],
  initialFen: string,
  atPly: number,
): { opening: Opening | null; bookFlags: boolean[] } {
  useEffect(() => {
    void loadOpenings().catch(() => {
      // Offline or chunk failure: the header stays hidden, never an error.
    });
  }, []);
  const version = useSyncExternalStore(subscribeOpenings, () => tableVersion);
  return useMemo(() => {
    const current = table;
    if (!current) return { opening: null, bookFlags: moves.map(() => false) };
    return {
      opening: openingForLine(current, moves, initialFen, atPly),
      bookFlags: bookFlagsForLine(current, moves, initialFen),
    };
  }, [moves, initialFen, atPly, version]);
}
