import type { DrawShape } from '@lichess-org/chessground/draw';
import type { Key } from '@lichess-org/chessground/types';
import { parseKey } from './domain';
import { buildReviewBrushes, defaultArrowSettings, type ArrowSettings } from './arrowSettings';
export const reviewBrushes = buildReviewBrushes(defaultArrowSettings);
export type ArrowSource = 'actual' | 'maia' | 'stockfish';
export type ArrowToggles = Record<ArrowSource, boolean>;
export type SquareBadge = { square: Key; glyph: '💀' | '??' | '?' | '⚑' };
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
export function reviewShapes(moves: Record<ArrowSource, string | null | undefined>, toggles: ArrowToggles, preview?: string | null, badge?: SquareBadge | SquareBadge[] | null, arrows?: ArrowSettings): DrawShape[] {
  const entries: { move: string; brush: string }[] = (['actual', 'maia', 'stockfish'] as const).filter(source => toggles[source] && validMove(moves[source])).map(source => ({ move: moves[source]!, brush: source }));
  if (validMove(preview) && !entries.some(entry => entry.move === preview)) entries.push({ move: preview, brush: 'candidate' });
  // Changing the complete set gives all shapes a fresh hash. Chessground appends
  // new SVG groups; a shared hash suffix preserves widest-first layering after toggles.
  // The arrow style signature forces the same fresh hash when colors/widths
  // change, so a live brushes update repaints instead of hitting the
  // prevSvgHash early-return (brush color/width are not part of the hash).
  const style = arrows ? (['actual', 'maia', 'stockfish', 'candidate'] as const).map(key => `${key}=${arrows[key].color},${arrows[key].width}`).join('|') : '';
  const signature = `${entries.map(entry => `${entry.brush}:${entry.move}`).join('|')}#${style}`;
  const shapes: DrawShape[] = entries.map(({ move, brush }) => {
    const orig = parseKey(move.slice(0, 2));
    const dest = parseKey(move.slice(2, 4));
    if (orig === undefined || dest === undefined) throw new Error(`Invalid review arrow move: ${move}`);
    return { orig, dest, brush, customSvg: { html: `<!--${signature}-->` } };
  });
  const badges = badge === null || badge === undefined ? [] : Array.isArray(badge) ? badge : [badge];
  const seen = new Set<string>();
  for (const item of badges) {
    if (!item || !validSquare(item.square)) continue;
    if (item.glyph !== '💀' && item.glyph !== '??' && item.glyph !== '?' && item.glyph !== '⚑') continue;
    // One label per square: callers order flags before quality badges, so a
    // flag on the mated king outranks a quality badge on the same square.
    if (seen.has(item.square)) continue;
    seen.add(item.square);
    shapes.push({ orig: item.square, label: { text: item.glyph, fill: badgeFill(item.glyph) } });
  }
  return shapes;
}

function badgeFill(glyph: SquareBadge['glyph']): string {
  if (glyph === '💀') return '#7f1d1d';
  if (glyph === '??') return '#e5484d';
  if (glyph === '?') return '#f5a524';
  return '#111827';
}
