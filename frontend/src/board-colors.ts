import type { Color } from '@lichess-org/chessground/types';

export type ChessColor = 'w' | 'b';

export function toGroundColor(color: ChessColor): Color {
  return color === 'w' ? 'white' : 'black';
}
