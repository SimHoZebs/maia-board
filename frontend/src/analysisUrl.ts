import { Chess } from 'chess.js';
import { START_FEN, loadLine, type Analysis } from './domain';

export type UrlLine = { initialFen: string; moves: string[] };

// Canonical shareable identity of an analysis: normalized initial FEN (omitted
// for the standard start) plus comma-separated UCI moves. Commas stay raw for
// readable links; only the FEN needs encoding. Empty startpos is the bare
// `/analyze` URL.
export function analysisSearch(analysis: Pick<Analysis, 'initialFen' | 'moves'>): string {
  const parts: string[] = [];
  if (analysis.moves.length) parts.push(`moves=${analysis.moves.join(',')}`);
  if (new Chess(analysis.initialFen).fen() !== START_FEN) parts.push(`fen=${encodeURIComponent(new Chess(analysis.initialFen).fen())}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export function analysisPath(analysis: Pick<Analysis, 'initialFen' | 'moves'>): string {
  return `/analyze${analysisSearch(analysis)}`;
}

// Bare `/analyze` (no params) yields undefined: keep current/snapshot state.
// Present-but-empty (`?moves=`) is a real empty line. Anything invalid also
// yields undefined so a tampered link falls back to the snapshot or import
// dialog instead of failing.
export function parseAnalysisSearch(search: string): UrlLine | undefined {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!params.has('fen') && !params.has('moves')) return undefined;
  try {
    const fenRaw = (params.get('fen') ?? '').trim();
    const initialFen = fenRaw ? new Chess(fenRaw).fen() : START_FEN;
    const moves = (params.get('moves') ?? '').split(/[,\s]+/).map(move => move.trim()).filter(Boolean);
    const line = loadLine(initialFen, moves.join(' '));
    return { initialFen: line.initialFen, moves: line.moves };
  } catch { return undefined; }
}

export function sameLine(
  a: Pick<Analysis, 'initialFen' | 'moves'> | UrlLine,
  b: Pick<Analysis, 'initialFen' | 'moves'> | UrlLine,
): boolean {
  try {
    return new Chess(a.initialFen).fen() === new Chess(b.initialFen).fen() && a.moves.join(',') === b.moves.join(',');
  } catch { return false; }
}
