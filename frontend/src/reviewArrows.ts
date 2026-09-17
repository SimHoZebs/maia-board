import type { DrawBrushes, DrawShape } from '@lichess-org/chessground/draw';
import type { Key } from '@lichess-org/chessground/types';
import { parseKey } from './domain';
export const reviewBrushes: DrawBrushes = {
  green: { key: 'g', color: '#15781B', opacity: 1, lineWidth: 10 },
  red: { key: 'r', color: '#882020', opacity: 1, lineWidth: 10 },
  blue: { key: 'b', color: '#003088', opacity: 1, lineWidth: 10 },
  yellow: { key: 'y', color: '#e68f00', opacity: 1, lineWidth: 10 },
  actual: { key: 'actual', color: '#ffffff', opacity: .45, lineWidth: 12 },
  maia: { key: 'maia', color: '#ef4444', opacity: .45, lineWidth: 8 },
  stockfish: { key: 'stockfish', color: '#3b82f6', opacity: .45, lineWidth: 4 },
  candidate: { key: 'candidate', color: '#d6b85c', opacity: .65, lineWidth: 2 },
};
export type ArrowSource = 'actual' | 'maia' | 'stockfish';
export type ArrowToggles = Record<ArrowSource, boolean>;
export type SquareBadge = { square: Key; glyph: '💀' | '??' | '?' };
const validMove = (move: unknown): move is string => typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move);
const validSquare = (square: unknown): square is Key => typeof square === 'string' && /^[a-h][1-8]$/.test(square);
// Single owner for preview→candidate synthesis. reviewShapes uses it for the
// analysis overlay; ChessBoard uses it for the standalone preview fallback so
// both agree on validity and brush. Invalid previews yield no shape.
export function candidatePreviewShape(preview: string | null | undefined): DrawShape[] {
  if (!validMove(preview)) return [];
  const orig = parseKey(preview.slice(0, 2));
  const dest = parseKey(preview.slice(2, 4));
  if (orig === undefined || dest === undefined) return [];
  return [{ orig, dest, brush: 'candidate' }];
}
export function reviewShapes(moves: Record<ArrowSource, string | null | undefined>, toggles: ArrowToggles, preview?: string | null, badge?: SquareBadge | null): DrawShape[] {
  const entries: { move: string; brush: string }[] = (['actual', 'maia', 'stockfish'] as const).filter(source => toggles[source] && validMove(moves[source])).map(source => ({ move: moves[source]!, brush: source }));
  if (validMove(preview) && !entries.some(entry => entry.move === preview)) entries.push({ move: preview, brush: 'candidate' });
  // Changing the complete set gives all shapes a fresh hash. Chessground appends
  // new SVG groups; a shared hash suffix preserves widest-first layering after toggles.
  const signature = entries.map(entry => `${entry.brush}:${entry.move}`).join('|');
  const shapes: DrawShape[] = entries.map(({ move, brush }) => {
    const orig = parseKey(move.slice(0, 2));
    const dest = parseKey(move.slice(2, 4));
    if (orig === undefined || dest === undefined) throw new Error(`Invalid review arrow move: ${move}`);
    return { orig, dest, brush, customSvg: { html: `<!--${signature}-->` } };
  });
  if (badge && validSquare(badge.square) && (badge.glyph === '💀' || badge.glyph === '??' || badge.glyph === '?')) {
    shapes.push({ orig: badge.square, label: { text: badge.glyph, fill: badge.glyph === '💀' ? '#7f1d1d' : badge.glyph === '??' ? '#e5484d' : '#f5a524' } });
  }
  return shapes;
}
