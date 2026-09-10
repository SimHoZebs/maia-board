import { useLayoutEffect, useReducer, useRef } from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Color, Key } from '@lichess-org/chessground/types';
import { legalDests, type Position } from './domain';
import { toGroundColor } from './board-colors';
import type { DrawShape } from '@lichess-org/chessground/draw';
import { reviewBrushes } from './reviewArrows';

type Props = { position: Position; orientation: Color; enabled: boolean; thinking: boolean; interactionVersion: number; preview?: string | null; shapes?: DrawShape[]; onMove: (from: Square, to: Square) => void };

export function ChessBoard({ position, orientation, enabled, thinking, interactionVersion, preview, shapes, onMove }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const callback = useRef(onMove);
  const generation = useRef(0);
  const [gesture, resync] = useReducer(n => n + 1, 0);
  useLayoutEffect(() => { callback.current = onMove; });
  useLayoutEffect(() => {
    const ground = Chessground(container.current!, {
      viewOnly: false, coordinates: true, animation: { enabled: true, duration: 220 },
      premovable: { enabled: false },
      movable: { free: false, rookCastle: false },
      drawable: { brushes: reviewBrushes },
    });
    api.current = ground;
    return () => { ground.destroy(); api.current = null; container.current?.replaceChildren(); };
  }, []);
  const lastMove = position.lastMove?.join(',');
  useLayoutEffect(() => {
    const ground = api.current!;
    const version = ++generation.current;
    const game = new Chess(position.fen);
    ground.cancelMove();
    ground.set({ fen: position.fen, orientation, turnColor: toGroundColor(game.turn()),
      lastMove: lastMove ? lastMove.split(',') as Key[] : undefined,
      movable: { free: false, color: enabled ? toGroundColor(game.turn()) : undefined, dests: enabled ? legalDests(game) : new Map(), showDests: true,
        events: { after(from, to) {
          // Chessground queues user callbacks. A context change can retire a gesture
          // before its callback runs, including switching games at the same FEN.
          if (api.current !== ground || generation.current !== version) return;
          callback.current(from as Square, to as Square);
          // Also reconcile unchanged positions after rejection or promotion selection.
          // React batches this with the parent's authoritative move action.
          resync();
        } },
      },
    });
  }, [position.fen, orientation, enabled, lastMove, gesture, interactionVersion]);
  useLayoutEffect(() => {
    api.current?.setAutoShapes(shapes ?? (preview ? [{ orig: preview.slice(0, 2) as Key, dest: preview.slice(2, 4) as Key, brush: 'candidate' }] : []));
  }, [position.fen, preview, shapes, interactionVersion, orientation]);
  // React owns this element; Chessground owns all its descendants and CSS classes.
  return <div className={`board${thinking ? ' is-thinking' : ''}`} id="board" aria-label="Chess board"><div ref={container} /></div>;
}
