import { useLayoutEffect, useReducer, useRef } from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Color, Key } from '@lichess-org/chessground/types';
import { legalDests, parseKey, parseSquare } from './domain';
import { toGroundColor } from './board-colors';
import type { DrawBrushes, DrawShape } from '@lichess-org/chessground/draw';
import { candidatePreviewShape, reviewBrushes } from './reviewArrows';

export type BoardPosition = { fen: string; lastMove?: readonly string[] | null };
export type BoardTransition = { line: string; ply: number };
type Props = { position: BoardPosition; transition: BoardTransition; orientation: Color; enabled: boolean; thinking: boolean; interactionVersion: number; coordinatesOnSquares: boolean; preview?: string | null; shapes?: DrawShape[]; brushes?: DrawBrushes; onMove: (from: Square, to: Square) => void };

export function ChessBoard({ position, transition, orientation, enabled, thinking, interactionVersion, coordinatesOnSquares, preview, shapes, brushes = reviewBrushes, onMove }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const api = useRef<Api | null>(null);
  const callback = useRef(onMove);
  const generation = useRef(0);
  const [gesture, resync] = useReducer(n => n + 1, 0);
  // First-render identity: the constructor below mounts once, so it must open
  // on the loaded line's final position instead of the default startpos.
  const initial = useRef<{ fen: string; orientation: Color } | null>(null);
  if (initial.current === null) initial.current = { fen: position.fen, orientation };
  // The workspace supplies line identity and cursor: adjacent plies animate
  // in either direction, while a different loaded line snaps.
  const previous = useRef<BoardTransition>(transition);
  useLayoutEffect(() => { callback.current = onMove; });
  useLayoutEffect(() => {
    const ground = Chessground(container.current!, {
      fen: initial.current!.fen,
      orientation: initial.current!.orientation,
      addDimensionsCssVarsTo: container.current!.closest<HTMLElement>('.board-frame') ?? undefined,
      viewOnly: false, coordinates: true, coordinatesOnSquares, animation: { enabled: true, duration: 220 },
      // Hold-and-drag (press, hold, move, release) shares the board with
      // tap-tap: draggable stays enabled for the press path while selectable
      // keeps the tap path. blockTouchScroll keeps a touch drag on the piece
      // instead of scrolling the page.
      blockTouchScroll: true,
      draggable: { enabled: true, distance: 4, autoDistance: true, showGhost: true },
      selectable: { enabled: true },
      premovable: { enabled: false },
      movable: { free: false, rookCastle: false },
      drawable: { brushes },
    });
    api.current = ground;
    // Chessground memoizes its bounding rect until scroll/resize. Any layout
    // shift (setup opening, banners, fonts) would otherwise offset every click,
    // so refresh the memo whenever the board resizes.
    const observer = new ResizeObserver(() => api.current?.state.dom.bounds.clear());
    if (container.current) observer.observe(container.current);
    // Chessground builds the coords DOM once at construction; the caller
    // forces a fresh mount (via key) when the style switches.
    return () => { observer.disconnect(); ground.destroy(); api.current = null; container.current?.replaceChildren(); };
  }, []);
  const lastMove = position.lastMove?.join(',');
  // lastMove is built from [Key, Key] above, so parsing always succeeds;
  // an unparsable entry yields no highlight rather than a wrong one.
  const parseKeyList = (text: string): Key[] | undefined => {
    const keys: Key[] = [];
    for (const part of text.split(',')) {
      const key = parseKey(part);
      if (key === undefined) return undefined;
      keys.push(key);
    }
    return keys;
  };
  useLayoutEffect(() => {
    const ground = api.current!;
    // The board may have moved since the last measurement (layout shifts from
    // setup, banners, or panels). Re-measure so gestures map to live squares.
    ground.state.dom.bounds.clear();
    const version = ++generation.current;
    const game = new Chess(position.fen);
    ground.cancelMove();
    // Adjacent plies slide; game loads jump many pieces at once and must snap
    // instead of animating every piece from the previous line's tip.
    const singleStep = previous.current.line === transition.line && Math.abs(previous.current.ply - transition.ply) <= 1;
    previous.current = transition;
    ground.set({ fen: position.fen, orientation, turnColor: toGroundColor(game.turn()), animation: { enabled: singleStep },
      lastMove: lastMove ? parseKeyList(lastMove) : undefined,
      movable: { free: false, color: enabled ? toGroundColor(game.turn()) : undefined, dests: enabled ? legalDests(game) : new Map(), showDests: true,
        events: { after(from, to) {
          // Chessground queues user callbacks. A context change can retire a gesture
          // before its callback runs, including switching games at the same FEN.
          if (api.current !== ground || generation.current !== version) return;
          const fromSquare = parseSquare(from);
          const toSquare = parseSquare(to);
          if (fromSquare === undefined || toSquare === undefined) throw new Error(`Invalid board squares: ${from}${to}`);
          callback.current(fromSquare, toSquare);
          // Also reconcile unchanged positions after rejection or promotion selection.
          // React batches this with the parent's authoritative move action.
          resync();
        } },
      },
    });
    // The instant set above persists `enabled: false`; restore sliding for
    // subsequent single-ply navigation. No fen means the render path, no anim.
    if (!singleStep) ground.set({ animation: { enabled: true } });
  }, [position.fen, transition.line, transition.ply, orientation, enabled, lastMove, gesture, interactionVersion]);
  useLayoutEffect(() => {
    api.current?.setAutoShapes(shapes ?? candidatePreviewShape(preview));
  }, [position.fen, preview, shapes, interactionVersion, orientation]);
  // Shafts repaint through the shapes hash (reviewShapes embeds the arrow
  // style signature); arrowhead markers are append-only defs keyed by brush
  // name, so callers remount via key on brushes change for fresh heads. This
  // live set still updates shafts if a caller ever edits brushes in place.
  useLayoutEffect(() => {
    api.current?.set({ drawable: { brushes } });
  }, [brushes]);
  // React owns this element; Chessground owns all its descendants and CSS classes.
  return <div className={`board${thinking ? ' is-thinking' : ''}`} id="board" aria-label="Chess board"><div ref={container} /></div>;
}
