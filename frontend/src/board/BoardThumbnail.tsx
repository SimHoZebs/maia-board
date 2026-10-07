import { useLayoutEffect, useRef } from 'react';
import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Color } from '@lichess-org/chessground/types';
import { toGroundColor } from './board-colors';

export function BoardThumbnail({ fen, orientation }: { fen: string; orientation: Color }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = container.current!;
    let check: Color | false = false;
    try {
      const game = new Chess(fen);
      if (game.inCheck()) check = toGroundColor(game.turn());
    } catch {
      check = false;
    }
    const board = Chessground(element, {
      fen, orientation, viewOnly: true, coordinates: false, check,
      animation: { enabled: false }, drawable: { enabled: false, visible: false },
    });
    return () => { board.destroy(); element.replaceChildren(); };
  }, [fen, orientation]);
  return <div className="board-thumbnail" role="img" aria-label={`Saved board position, ${orientation} at bottom`}><div ref={container} /></div>;
}
