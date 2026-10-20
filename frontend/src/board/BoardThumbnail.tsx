import { useLayoutEffect, useRef } from 'react';
import { Chess } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Color } from '@lichess-org/chessground/types';
import { turnFromFen } from '../shared/domain';

const THUMB_CHECK_LIMIT = 256;
const thumbCheckCache = new Map<string, Color | false>();
function thumbCheckForFen(fen: string): Color | false {
  const cached = thumbCheckCache.get(fen);
  if (cached !== undefined) return cached;
  let result: Color | false = false;
  try {
    result = new Chess(fen).inCheck() ? ((turnFromFen(fen) ?? 'white') as Color) : false;
  } catch {
    result = false;
  }
  thumbCheckCache.set(fen, result);
  if (thumbCheckCache.size > THUMB_CHECK_LIMIT)
    thumbCheckCache.delete(thumbCheckCache.keys().next().value!);
  return result;
}

export function BoardThumbnail({ fen, orientation }: { fen: string; orientation: Color }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = container.current!;
    const board = Chessground(element, {
      fen,
      orientation,
      viewOnly: true,
      coordinates: false,
      check: thumbCheckForFen(fen),
      animation: { enabled: false },
      drawable: { enabled: false, visible: false },
    });
    return () => {
      board.destroy();
      element.replaceChildren();
    };
  }, [fen, orientation]);
  return (
    <div
      className="board-thumbnail"
      role="img"
      aria-label={`Saved board position, ${orientation} at bottom`}
    >
      <div ref={container} />
    </div>
  );
}
