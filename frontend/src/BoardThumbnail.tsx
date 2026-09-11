import { useLayoutEffect, useRef } from 'react';
import { Chessground } from '@lichess-org/chessground';
import type { Color } from '@lichess-org/chessground/types';

export function BoardThumbnail({ fen, orientation }: { fen: string; orientation: Color }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = container.current!;
    const board = Chessground(element, {
      fen, orientation, viewOnly: true, coordinates: false,
      animation: { enabled: false }, drawable: { enabled: false, visible: false },
    });
    return () => { board.destroy(); element.replaceChildren(); };
  }, [fen, orientation]);
  return <div className="board-thumbnail" role="img" aria-label={`Saved board position, ${orientation} at bottom`}><div ref={container} /></div>;
}
