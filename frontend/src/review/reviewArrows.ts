import type { DrawShape } from '@lichess-org/chessground/draw';
import type { Key } from '@lichess-org/chessground/types';
import { parseKey } from '../shared/domain';
import { buildReviewBrushes, defaultArrowSettings, type ArrowSettings } from '../settings/arrowSettings';
export const reviewBrushes = buildReviewBrushes(defaultArrowSettings);
export type ArrowSource = 'actual' | 'bot' | 'objective' | 'stockfish' | 'next';
export type ArrowToggles = Record<ArrowSource, boolean>;
export type SquareBadge = { square: Key; glyph: '💀' | '??' | '?' | '⚑' };
const validMove = (move: unknown): move is string => typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move);
const validSquare = (square: unknown): square is Key => typeof square === 'string' && /^[a-h][1-8]$/.test(square);
export function reviewShapes(moves: Record<ArrowSource, string | null | undefined>, toggles: ArrowToggles, badge?: SquareBadge | SquareBadge[] | null, arrows?: ArrowSettings): DrawShape[] {
  // Lane arrows draw widest-first (actual 12, next 10, bot 8, stockfish 6,
  // objective 4) so coincident arrows layer with the thinnest on top. The
  // forward next-best arrow is skipped when it coincides with the Stockfish
  // arrow (same source and position in next basis): a duplicate shaft.
  const entries: { move: string; brush: string }[] = (['actual', 'next', 'bot', 'stockfish', 'objective'] as const).filter(source => toggles[source] && validMove(moves[source])).map(source => ({ move: moves[source]!, brush: source }));
  const ranked = entries.filter(entry => entry.brush !== 'next' || !entries.some(other => other.brush === 'stockfish' && other.move === entry.move));
  // Changing the complete set gives all shapes a fresh hash. Chessground appends
  // new SVG groups; a shared hash suffix preserves widest-first layering after toggles.
  // The arrow style signature forces the same fresh hash when colors/widths
  // change, so a live brushes update repaints instead of hitting the
  // prevSvgHash early-return (brush color/width are not part of the hash).
  const style = arrows ? (['actual', 'next', 'bot', 'stockfish', 'objective'] as const).map(key => `${key}=${arrows[key].color},${arrows[key].width}`).join('|') : '';
  const signature = `${ranked.map(entry => `${entry.brush}:${entry.move}`).join('|')}#${style}`;
  const shapes: DrawShape[] = ranked.map(({ move, brush }) => {
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
