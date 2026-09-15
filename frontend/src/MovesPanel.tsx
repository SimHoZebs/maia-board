import { useLayoutEffect, useRef, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CornerDownRight,
  CornerUpRight,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { IconButton } from "./components";
import { QualityBadge, type BadgeLoading } from "./ReviewCharts";
import type { Quality } from "./reviewMetrics";

export function MoveNavBar({
  ply,
  total,
  onView,
  tools,
  menu,
}: {
  ply: number;
  total: number;
  onView: (ply: number | null) => void;
  tools?: ReactNode;
  menu?: ReactNode;
}) {
  return (
    <div className="move-navigation">
      {tools && <div className="board-actions">{tools}</div>}
      {menu && <div className="menu-slot">{menu}</div>}
      <div className="nav-buttons">
        {[
          { id: "first", label: "First position", Icon: SkipBack, to: 0 },
          {
            id: "prev",
            label: "Previous position",
            Icon: ArrowLeft,
            to: ply - 1,
          },
          {
            id: "next",
            label: "Next position",
            Icon: ArrowRight,
            to: ply + 1,
          },
          {
            id: "last",
            label: "Last position",
            Icon: SkipForward,
            to: total,
          },
        ].map((item) => (
          <IconButton
            key={item.id}
            id={`analysis-${item.id}`}
            label={item.label}
            disabled={item.to < 0 || item.to > total || item.to === ply}
            onClick={() => onView(item.to)}
          >
            <item.Icon size={16} aria-hidden="true" />
          </IconButton>
        ))}
      </div>
    </div>
  );
}

type MovesCore = {
  sans: string[];
  ply: number;
  initialFen: string;
  qualities?: (Quality | undefined)[];
  badgeLoading?: BadgeLoading;
  bookFlags?: boolean[];
};

type MovesNavigation = {
  onView: (ply: number | null) => void;
  onOriginalView?: (ply: number) => void;
  tools?: ReactNode;
  menu?: ReactNode;
  hideNav?: boolean;
};

type MovesBranch = {
  original?: { sans: string[]; fromPly: number };
  branchUp?: boolean;
};

function MovesPanel({
  sans,
  ply,
  onView,
  onOriginalView,
  initialFen,
  qualities,
  analysis = false,
  badgeLoading = 'reel',
  original,
  tools,
  branchUp = false,
  menu,
  hideNav = false,
  bookFlags = undefined,
}: MovesCore & MovesNavigation & MovesBranch & { analysis?: boolean }) {
  const active = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = list.current!;
    const reveal = () => {
      const button = active.current;
      if (button) {
        const bounds = button.getBoundingClientRect(),
          viewport = container.getBoundingClientRect();
        container.scrollLeft +=
          bounds.left -
          viewport.left -
          container.clientWidth / 2 +
          bounds.width / 2;
      } else if (ply === 0) {
        container.scrollLeft = 0;
        container.scrollTop = 0;
      }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(container);
    return () => observer.disconnect();
  }, [ply, sans.length, analysis, original?.fromPly]);
  const parts = initialFen.split(" "),
    first = Number(parts[5]) * 2 + (parts[1] === "b" ? 1 : 0);
  const number = (index: number) => (
    <span>
      {Math.floor((first + index) / 2)}
      {(first + index) % 2 ? "…" : "."}
    </span>
  );
  // Every move reserves its badge box up front through the shared
  // QualityBadge: qualities fill in as evaluations settle, and mounting the
  // badge late would shift the row and push the selected move out of view.
  // An in-book move shows a book chip in that same box instead of a badge:
  // the position is known theory, not an engine evaluation, so no grade is
  // implied. Announced like settled badges; the header carries the name.
  const move = (san: string, index: number) => (
    <button
      ref={ply === index + 1 ? active : undefined}
      className="move-cell"
      aria-current={ply === index + 1 ? "step" : undefined}
      key={index}
      onClick={() => onView(index + 1)}
    >
      {number(index)} {san}{" "}
      {bookFlags?.[index] ? (
        <span className="quality quality-book" title="Book move — known opening, not engine-evaluated" aria-label="Book move">
          <BookOpen size={13} aria-hidden="true" />
        </span>
      ) : (
        qualities && <QualityBadge quality={qualities[index]} reserveSpace loading={badgeLoading} />
      )}
    </button>
  );
  return (
    <section
      className={`notation${analysis ? " analysis-notation" : ""}`}
      aria-label="Move history"
    >
      <div className="move-list" id="move-list" ref={list}>
        {!sans.length && <span className="empty-copy">Moves appear here</span>}
        {original ? (
          <div className="original-line" aria-label="Original line">
            {original.sans
              .slice(0, Math.max(0, original.fromPly - 1))
              .map(move)}
            <div className="branch-point">
              {original.fromPly > 0 &&
                move(original.sans[original.fromPly - 1], original.fromPly - 1)}
              <div className="variation-line" aria-label="Explored variation">
                {branchUp ? (
                  <CornerUpRight
                    className="branch-connector"
                    size={14}
                    aria-hidden="true"
                  />
                ) : (
                  <CornerDownRight
                    className="branch-connector"
                    size={14}
                    aria-hidden="true"
                  />
                )}
                {sans
                  .slice(original.fromPly)
                  .map((san, index) => move(san, original.fromPly + index))}
              </div>
            </div>
            {original.sans.slice(original.fromPly).map((san, offset) => (
              <button
                className="move-cell original-move"
                key={original.fromPly + offset}
                onClick={() =>
                  (onOriginalView ?? onView)(original.fromPly + offset + 1)
                }
              >
                {number(original.fromPly + offset)} {san}
              </button>
            ))}
          </div>
        ) : (
          sans.map(move)
        )}
      </div>
      {!hideNav && (
        <MoveNavBar
          ply={ply}
          total={sans.length}
          onView={onView}
          tools={tools}
          menu={menu}
        />
      )}
      <span id="analysis-index">
        Position {ply + 1} / {sans.length + 1}
      </span>
    </section>
  );
}

export type MovesPanelProps = MovesCore &
  MovesNavigation &
  MovesBranch & {
    analysis?: boolean;
  };

export type MoveNavBarProps = {
  ply: number;
  total: number;
  onView: (ply: number | null) => void;
  tools?: ReactNode;
  menu?: ReactNode;
};

export { MovesPanel };
