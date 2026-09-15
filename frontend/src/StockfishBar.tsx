import { useEffect, useRef, useState } from "react";
import { candidateSan } from "./domain";
import { CandidateList, CandidateRow } from "./components";
import {
  scoreValueText,
  whiteWin,
  type Evaluation,
} from "./reviewMetrics";

export function SkeletonList({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="skeleton-list" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index} aria-hidden="true">
          <span className="skeleton-rank" />
          <span className="skeleton-bar skeleton-san" />
          <span className="skeleton-bar skeleton-metric" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonText({ label }: { label: string }) {
  return (
    <p className="skeleton-verdict" role="status" aria-label={label}>
      <span className="skeleton-bar" aria-hidden="true" />
    </p>
  );
}

// -|_ tween: hold the old value briefly (-), snap through the middle (|),
// settle into the new value (_). Hold is skipped when retargeting mid-flight
// so fast scrubbing follows without stacking delays.
const BAR_HOLD_MS = 110;
const BAR_SNAP_MS = 260;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function useTweenedPercent(target: number): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  // True while a hold is pending or a snap is running. A retarget that
  // interrupts either skips its own hold so bursts follow without stacking
  // delays; only a change from rest holds first.
  const busyRef = useRef(false);
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      busyRef.current = false;
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    if (target === displayRef.current) {
      // Back at rest (e.g. returned to origin before the hold fired): no
      // tween is running after cleanup, so clear the flag. Otherwise one
      // skipped hold would leak into the next navigation.
      busyRef.current = false;
      return;
    }
    const from = displayRef.current;
    const hold = busyRef.current ? 0 : BAR_HOLD_MS;
    busyRef.current = true;
    let raf = 0;
    const holdId = window.setTimeout(() => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / BAR_SNAP_MS);
        const value = from + (target - from) * easeInOutCubic(t);
        displayRef.current = value;
        setDisplay(value);
        if (t < 1) {
          raf = requestAnimationFrame(tick);
        } else {
          busyRef.current = false;
        }
      };
      raf = requestAnimationFrame(tick);
    }, hold);
    return () => {
      window.clearTimeout(holdId);
      cancelAnimationFrame(raf);
    };
  }, [target]);
  return display;
}

export function StockfishBar({
  evaluation,
  orientation,
  failed,
}: {
  evaluation?: Evaluation;
  orientation: "white" | "black";
  failed?: boolean;
}) {
  // Retain the last settled evaluation while the next position loads: the bar
  // keeps showing the previous value (dimmed/pulsing via .loading) so the
  // tween runs previous -> current instead of previous -> 50 -> current.
  // Render-phase retention (no effect): the committed value is available to
  // the same commit's tween input, with no one-commit ref lag. Evaluation
  // objects are cache-stable identities, so this settles after one commit.
  const [last, setLast] = useState<Evaluation | undefined>(evaluation);
  if (evaluation && evaluation !== last) setLast(evaluation);
  const display = evaluation ?? last;
  const percent = display ? whiteWin(display.score) : 50;
  const shown = useTweenedPercent(percent);
  const score = display ? scoreValueText(display.score) : "—";
  const pending = !evaluation;
  // A failed fetch is not loading: drop the pulse so the bar never spins
  // forever on the old value. Retry clears the failure upstream and the pulse
  // resumes while the refetch is in flight.
  const loading = pending && !!display && !failed;
  const statusSuffix = loading ? " · updating" : failed && pending ? " · update failed" : "";
  const description = !display
    ? "No evaluation yet"
    : display.terminal === "draw"
      ? "Draw"
      : display.terminal === "white_win"
        ? "White wins"
        : display.terminal === "black_win"
          ? "Black wins"
          : `${score} · White perspective`;
  const accessibleName = !display
    ? `${description}${failed && pending ? " · update failed" : ""}`
    : `${description} · estimated White winning chance ${Math.round(percent)}%${statusSuffix}`;
  return (
    <section
      className={`stockfish-balance orientation-${orientation}${pending ? " pending" : ""}${loading ? " loading" : ""}`}
      aria-label="Stockfish position evaluation"
      aria-busy={loading || undefined}
    >
      <div
        className="balance-track"
        role="img"
        aria-label={accessibleName}
        title={description}
      >
        <div className="balance-white" style={{ height: `${shown}%` }} />
        <strong className="balance-score" aria-hidden="true">
          {score}
        </strong>
      </div>
    </section>
  );
}

export function StockfishBody({
  fen,
  evaluation,
  played,
  previewUci,
  onPreview,
  onExplore,
  retrospective = false,
}: {
  fen: string;
  evaluation: Evaluation;
  played?: string;
  previewUci: string | null;
  onPreview: (uci: string | null) => void;
  onExplore: (uci: string) => void;
  retrospective?: boolean;
}) {
  if (evaluation.terminal)
    return (
      <div>
        <p>
          {evaluation.terminal === "draw"
            ? "Draw"
            : evaluation.terminal === "white_win"
              ? "White wins"
              : "Black wins"}
        </p>
      </div>
    );
  return (
    <div>
      <CandidateList>
        {evaluation.lines.map((line, index) => {
          const san = candidateSan(fen, line.move);
          const isPlayed = line.move === played;
          return (
            <CandidateRow
              key={`${line.move}:${index}`}
              index={index}
              san={san}
              metric={scoreValueText(line.score)}
              isPlayed={isPlayed}
              preview={{
                label: `Explore ${san}${isPlayed ? " (played)" : ""}${retrospective ? " from before this move" : ""}`,
                active: previewUci === line.move,
                onPreview: () => onPreview(line.move),
                onClear: () => onPreview(null),
                onSelect: () => onExplore(line.move),
              }}
            />
          );
        })}
      </CandidateList>
    </div>
  );
}
