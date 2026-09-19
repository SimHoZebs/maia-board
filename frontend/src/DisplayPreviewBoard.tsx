import { useLayoutEffect, useRef } from 'react';
import { Chessground } from '@lichess-org/chessground';
import type { Color, Key } from '@lichess-org/chessground/types';
import { buildReviewBrushes, type ArrowBasis, type ArrowSettings } from './arrowSettings';
import { parseKey, type BoardOrientationSetting } from './domain';
import { reviewShapes } from './reviewArrows';

// Read-only mirror of the display settings. Props are plain values — no
// dispatch, no state access — so data flows one way: settings controls write,
// this board only reflects. It never modifies anything.
export type DisplayPreview = {
  orientation: BoardOrientationSetting;
  coordinatesOnSquares: boolean;
  basis: ArrowBasis;
  arrows: ArrowSettings;
};

// Demo line mirroring workspaces.tsx arrow semantics. Next basis views the
// before-position (pawn still e2, no highlight) with the outgoing options;
// past basis views the after-position (pawn e4, e2-e4 highlighted) with the
// incoming move's options drawn on that resulting board — exactly as review
// draws nodes[ply+1].uci on nodes[ply].fen vs nodes[ply].uci on nodes[ply].fen.
export const DEMO_BEFORE_FEN = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
export const DEMO_AFTER_FEN = '4k3/8/8/8/4P3/8/8/4K3 b - - 0 1';
const DEMO_LASTMOVE: Key[] = [parseKey('e2'), parseKey('e4')].filter((key): key is Key => key !== undefined);

function PreviewBoard({ orientation, coordinatesOnSquares, arrows, fen, turnColor, lastMove }: {
  orientation: Color; coordinatesOnSquares: boolean; arrows: ArrowSettings; fen: string; turnColor: Color; lastMove?: Key[];
}) {
  const container = useRef<HTMLDivElement>(null);
  // Mount-once per settings snapshot: the parent remounts via key, so the
  // constructor always sees fresh brushes/shapes (arrowheads are append-only
  // defs that a live update would not repaint).
  useLayoutEffect(() => {
    const board = Chessground(container.current!, {
      fen: fen,
      orientation,
      turnColor: turnColor,
      viewOnly: true,
      coordinates: true,
      coordinatesOnSquares,
      animation: { enabled: false },
      movable: { free: false },
      draggable: { enabled: false },
      selectable: { enabled: false },
      premovable: { enabled: false },
      lastMove: lastMove,
      drawable: {
        enabled: true,
        visible: true,
        brushes: buildReviewBrushes(arrows),
        autoShapes: reviewShapes(
          { actual: 'e2e4', maia: 'e2e4', objective: 'e2e3' },
          { actual: true, maia: true, objective: true },
          'e1f1',
          null,
          arrows,
        ),
      },
    });
    return () => { board.destroy(); container.current?.replaceChildren(); };
  }, []);
  return <div className="display-preview-board"><div ref={container} /></div>;
}

// Sliced view: Chessground always renders the full 8x8 (no crop option), so
// the preview window clips a 4x4 action region out of a 2x board. Offsets are
// percentages of the window (one display square = 25%), never pixels, so they
// survive square-size changes. The window tracks the demo action per
// orientation: files d-g x ranks 1-4 White-side, files c-f x ranks 1-4 Black-side.
function SlicedBoard({ orientation, coordinatesOnSquares, arrows, basis }: {
  orientation: Color; coordinatesOnSquares: boolean; arrows: ArrowSettings; basis: ArrowBasis;
}) {
  const past = basis === 'past';
  const snapshot = JSON.stringify([orientation, coordinatesOnSquares, arrows, basis]);
  return <div className="display-slice-window" aria-hidden="true">
    <div className={`display-slice-inner slice-${orientation}`}>
      <PreviewBoard key={snapshot} orientation={orientation} coordinatesOnSquares={coordinatesOnSquares} arrows={arrows}
        fen={past ? DEMO_AFTER_FEN : DEMO_BEFORE_FEN} turnColor={past ? 'black' : 'white'} lastMove={past ? DEMO_LASTMOVE : undefined} />
    </div>
  </div>;
}

export function DisplayBoardPreview({ orientation, coordinatesOnSquares, basis, arrows }: DisplayPreview) {
  // Auto has no game to follow here, so the preview pins White-side.
  const boardOrientation: Color = orientation === 'black' ? 'black' : 'white';
  return <div className="setting-preview display-preview" aria-hidden="true">
    <SlicedBoard orientation={boardOrientation} coordinatesOnSquares={coordinatesOnSquares} arrows={arrows} basis={basis} />
  </div>;
}
