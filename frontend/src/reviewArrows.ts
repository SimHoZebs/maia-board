import type { DrawBrushes, DrawShape } from '@lichess-org/chessground/draw';
import type { Key } from '@lichess-org/chessground/types';
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
const validMove = (move: unknown): move is string => typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move);
export function reviewShapes(moves: Record<ArrowSource, string | null | undefined>, toggles: ArrowToggles, preview?: string | null): DrawShape[] {
  const entries = (['actual', 'maia', 'stockfish'] as const).filter(source => toggles[source] && validMove(moves[source])).map(source => ({ move: moves[source]!, brush: source as string }));
  if (validMove(preview) && !entries.some(entry => entry.move === preview)) entries.push({ move: preview, brush: 'candidate' });
  // Changing the complete set gives all shapes a fresh hash. Chessground appends
  // new SVG groups; a shared hash suffix preserves widest-first layering after toggles.
  const signature = entries.map(entry => `${entry.brush}:${entry.move}`).join('|');
  return entries.map(({ move, brush }) => ({ orig: move.slice(0, 2) as Key, dest: move.slice(2, 4) as Key, brush, customSvg: { html: `<!--${signature}-->` } }));
}
