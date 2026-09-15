import { Chess } from 'chess.js';
import { applyUci } from './domain';

export type CapturedPiece = 'p' | 'n' | 'b' | 'r' | 'q';
export type MaiaSide = 'white' | 'black';

export const PIECE_VALUES: Record<CapturedPiece, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

// Display order: most valuable first, bishops before knights on the 3-point tie.
const SORT_ORDER: Record<CapturedPiece, number> = { q: 0, r: 1, b: 2, n: 3, p: 4 };

const isCapturedPiece = (piece: string): piece is CapturedPiece =>
  piece === 'p' || piece === 'n' || piece === 'b' || piece === 'r' || piece === 'q';

export const sortCaptured = (pieces: CapturedPiece[]): CapturedPiece[] =>
  [...pieces].sort((a, b) => SORT_ORDER[a] - SORT_ORDER[b]);

// Material from the current board only, so custom starts and promotions are
// exact. Kings are worthless for the lead. Diff is White-relative.
export function materialFromFen(fen: string): { white: number; black: number; diff: number } {
  const board = new Chess(fen).board();
  let white = 0, black = 0;
  for (const row of board) for (const square of row) {
    if (!square || square.type === 'k') continue;
    if (!isCapturedPiece(square.type)) continue;
    if (square.color === 'w') white += PIECE_VALUES[square.type];
    else black += PIECE_VALUES[square.type];
  }
  return { white, black, diff: white - black };
}

export function materialLeadFor(diff: number, color: MaiaSide): number {
  return color === 'white' ? diff : -diff;
}

// Captures made during this line, up to (not including) uptoPly. Walking the
// moves keeps custom starts exact: pieces already missing from the initial
// FEN are never reported as captures. Promotions only affect the FEN-derived
// material score, never this list.
export function capturesFromLine(
  initialFen: string,
  moves: string[],
  uptoPly: number = moves.length,
): { white: CapturedPiece[]; black: CapturedPiece[] } {
  const white: CapturedPiece[] = [];
  const black: CapturedPiece[] = [];
  const game = new Chess(initialFen);
  const clamped = Math.max(0, Math.min(uptoPly, moves.length));
  for (let index = 0; index < clamped; index++) {
    const turn = game.turn();
    const applied = applyUci(game, moves[index]);
    const captured = applied.captured?.toLowerCase();
    if (captured && isCapturedPiece(captured)) {
      if (turn === 'w') white.push(captured);
      else black.push(captured);
    }
  }
  return { white: sortCaptured(white), black: sortCaptured(black) };
}

const GLYPHS: Record<MaiaSide, Record<CapturedPiece, string>> = {
  // Captured pieces keep their own color: white's strip shows black pieces.
  white: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' },
  black: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕' },
};

// Glyph for a piece captured BY side (i.e. drawn in the victim's color).
export const capturedGlyph = (by: MaiaSide, piece: CapturedPiece): string => GLYPHS[by === 'white' ? 'white' : 'black'][piece];

const PIECE_NAMES: Record<CapturedPiece, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };

export function capturedLabel(by: MaiaSide, pieces: readonly CapturedPiece[], lead: number): string {
  const side = by === 'white' ? 'White' : 'Black';
  if (!pieces.length && lead <= 0) return `${side} has captured nothing`;
  const counts = new Map<CapturedPiece, number>();
  for (const piece of pieces) counts.set(piece, (counts.get(piece) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => SORT_ORDER[a[0]] - SORT_ORDER[b[0]])
    .map(([piece, count]) => `${count} ${PIECE_NAMES[piece]}${count === 1 ? '' : 's'}`);
  const taken = parts.length ? `captured ${parts.join(', ')}` : 'captured nothing';
  return lead > 0 ? `${side} ${taken}, up ${lead} pawn${lead === 1 ? '' : 's'}` : `${side} ${taken}`;
}
