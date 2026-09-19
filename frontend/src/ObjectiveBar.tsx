import { useEffect, useRef, useState } from "react";
import type { DomainOutcome } from "./domain";
import {
  scoreValueText,
  whiteExpected,
  type Score,
} from "./reviewMetrics";
import { sourceLabel } from "./objective";

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

export function ObjectiveBar({
  turn,
  expected,
  wdl,
  mate,
  outcome,
  orientation,
  failed,
}: {
  turn: 'white' | 'black';
  expected?: number | null;
  wdl?: { white: number; draw: number; black: number } | null;
  mate?: Score | null;
  outcome?: DomainOutcome | null;
  orientation: "white" | "black";
  failed?: boolean;
}) {
  // Objective reading: a Stockfish-seen forced mate outranks everything
  // (mate distance survives here and in the verdict), then terminal
  // outcomes, then the objective expectation. The bar never shows
  // centipawns: scores are White winning chances from human-like play.
  // The WDL triple (Maia lane) splits the bar into white/draw/black
  // segments with a percentage per side; without it (Stockfish lane) the
  // bar falls back to white/black only.
  const display = objectiveReading(turn, expected, wdl ?? null, mate ?? null, outcome ?? null);
  // Retain the last settled reading while the next position loads: the bar
  // keeps showing the previous value (dimmed/pulsing via .loading) so the
  // tween runs previous -> current instead of previous -> 50 -> current.
  // Render-phase retention (no effect): the committed value is available to
  // the same commit's tween input, with no one-commit ref lag.
  const [last, setLast] = useState(display);
  const lastWdl = last?.wdl;
  const displayWdl = display?.wdl;
  const wdlChanged = (displayWdl?.white ?? null) !== (lastWdl?.white ?? null)
    || (displayWdl?.draw ?? null) !== (lastWdl?.draw ?? null)
    || (displayWdl?.black ?? null) !== (lastWdl?.black ?? null);
  if (display && (display.percent !== last?.percent || display.score !== last?.score || wdlChanged)) setLast(display);
  const shown = display ?? last;
  const percent = shown ? shown.percent : 50;
  const whitePct = shown?.wdl ? shown.wdl.white : percent;
  const drawPct = shown?.wdl ? shown.wdl.draw : 0;
  const whiteTween = useTweenedPercent(whitePct);
  const drawTween = useTweenedPercent(drawPct);
  const score = shown ? shown.score : "—";
  const pending = !display;
  // A failed fetch is not loading: drop the pulse so the bar never spins
  // forever on the old value. Retry clears the failure upstream and the pulse
  // resumes while the refetch is in flight.
  const loading = pending && !!shown && !failed;
  const statusSuffix = loading ? " · updating" : failed && pending ? " · update failed" : "";
  const description = shown ? shown.description : "No evaluation yet";
  const breakdown = shown?.wdl
    ? `White ${Math.round(shown.wdl.white)}% · Draw ${Math.round(shown.wdl.draw)}% · Black ${Math.round(shown.wdl.black)}%`
    : `White ${Math.round(percent)}% · Black ${Math.round(100 - percent)}%`;
  const accessibleName = !shown
    ? `${description}${failed && pending ? " · update failed" : ""}`
    : `${description} · ${breakdown} · estimated White winning chance ${Math.round(percent)}%${statusSuffix}`;
  const drawStyle = orientation === "white"
    ? { height: `${drawTween}%`, bottom: `${whiteTween}%` }
    : { height: `${drawTween}%`, top: `${whiteTween}%` };
  return (
    <section
      className={`eval-balance orientation-${orientation}${pending ? " pending" : ""}${loading ? " loading" : ""}`}
      aria-label="Position evaluation"
      aria-busy={loading || undefined}
    >
      <div
        className="balance-track"
        role="img"
        aria-label={accessibleName}
        title={`${description} · ${breakdown}`}
      >
        <div className="balance-white" style={{ height: `${whiteTween}%` }} />
        {drawTween > 0.05 && <div className="balance-draw" style={drawStyle} />}
        <strong className="balance-score" aria-hidden="true">
          {score}
        </strong>
      </div>
    </section>
  );
}

function objectiveReading(turn: 'white' | 'black', expected: number | null | undefined, wdl: { white: number; draw: number; black: number } | null, mate: Score | null, outcome: DomainOutcome | null) {
  if (outcome?.kind === "checkmate") {
    const white = outcome.winner === "white";
    const triple = white ? { white: 100, draw: 0, black: 0 } : { white: 0, draw: 0, black: 100 };
    return { percent: white ? 100 : 0, wdl: triple, score: white ? "+M0" : "-M0", description: white ? "White wins" : "Black wins" };
  }
  if (outcome) return { percent: 50, wdl: { white: 0, draw: 100, black: 0 }, score: "Draw", description: "Draw" };
  if (mate) {
    const white = (mate.winning_side ?? (mate.value > 0 ? "white" : "black")) === "white";
    const text = scoreValueText(mate);
    const triple = white ? { white: 100, draw: 0, black: 0 } : { white: 0, draw: 0, black: 100 };
    return { percent: white ? 100 : 0, wdl: triple, score: text, description: `${text} · White perspective` };
  }
  if (expected == null) return undefined;
  if (wdl) {
    const percent = wdl.white + wdl.draw / 2;
    const text = `W ${Math.round(wdl.white)}% · D ${Math.round(wdl.draw)}% · B ${Math.round(wdl.black)}%`;
    return { percent, wdl, score: text, description: `${text} · White perspective · ${sourceLabel()}` };
  }
  const percent = whiteExpected(turn, expected);
  const text = `W ${Math.round(percent)}% · B ${Math.round(100 - percent)}%`;
  return { percent, wdl: null, score: text, description: `${text} · White perspective · ${sourceLabel()}` };
}
