import { useEffect, useRef, useState } from 'react';
import type { DomainOutcome } from '../shared/domain';
import { scoreValueText, whiteExpected, whiteWin, type Score } from './reviewMetrics';
import { sourceLabel } from '../objective/index';

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
    // Non-finite targets never tween: interpolating toward NaN would set
    // state every frame without converging, and the render-phase retention
    // below would re-set on every render (NaN !== NaN), tripping React's
    // maximum-update-depth guard. Callers fall back to the last finite
    // reading, so this only skips the animation, never the value.
    if (!Number.isFinite(target)) return;
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      busyRef.current = false;
      displayRef.current = target;
      // Reduced-motion sync: same value bails out, no loop.
      // oxlint-disable-next-line set-state-in-effect
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
  score = null,
  label = 'Position evaluation',
}: {
  turn: 'white' | 'black';
  expected?: number | null;
  wdl?: { white: number; draw: number; black: number } | null;
  mate?: Score | null;
  outcome?: DomainOutcome | null;
  orientation: 'white' | 'black';
  failed?: boolean;
  score?: Score | null;
  label?: string;
}) {
  // Objective reading: a Stockfish-seen forced mate outranks everything
  // (mate distance survives here and in the verdict), then terminal
  // outcomes, then a Stockfish cp score (bar height from White winning
  // chances, tags showing the cp value), then the objective expectation.
  // The WDL triple (bot lane) splits the bar into white/draw/black
  // segments with a percentage per side; without it (Stockfish lane) the
  // bar falls back to white/black only.
  const display = objectiveReading(
    turn,
    expected ?? null,
    wdl ?? null,
    mate ?? null,
    outcome ?? null,
    score ?? null,
  );
  // Retain the last settled reading while the next position loads: the bar
  // keeps showing the previous value (dimmed/pulsing via .loading) so the
  // tween runs previous -> current instead of previous -> 50 -> current.
  // Render-phase retention (no effect): the committed value is available to
  // the same commit's tween input, with no one-commit ref lag.
  // Only finite readings are retained: NaN !== NaN is always true, so
  // retaining a non-finite reading would call setLast on every render and
  // trip React's maximum-update-depth guard (error #185). A non-finite
  // reading renders as pending on the last finite value instead.
  // Null means no reading (never started, or nothing finite yet) — never
  // undefined.
  const valid = display !== null && Number.isFinite(display.percent) ? display : null;
  const [last, setLast] = useState(valid);
  const lastWdl = last === null ? null : last.wdl;
  const displayWdl = valid === null ? null : valid.wdl;
  const lastWhite = lastWdl === null ? null : lastWdl.white;
  const displayWhite = displayWdl === null ? null : displayWdl.white;
  const lastDraw = lastWdl === null ? null : lastWdl.draw;
  const displayDraw = displayWdl === null ? null : displayWdl.draw;
  const lastBlack = lastWdl === null ? null : lastWdl.black;
  const displayBlack = displayWdl === null ? null : displayWdl.black;
  const wdlChanged =
    displayWhite !== lastWhite || displayDraw !== lastDraw || displayBlack !== lastBlack;
  const tagsChanged =
    (valid === null ? null : valid.whiteText) !== (last === null ? null : last.whiteText) ||
    (valid === null ? null : valid.blackText) !== (last === null ? null : last.blackText) ||
    (valid === null ? null : valid.drawText) !== (last === null ? null : last.drawText);
  if (
    valid !== null &&
    (last === null || valid.percent !== last.percent || tagsChanged || wdlChanged)
  )
    setLast(valid);
  const shown = valid !== null ? valid : last;
  const percent = shown !== null ? shown.percent : 50;
  const whitePct = shown !== null && shown.wdl !== null ? shown.wdl.white : percent;
  const drawPct = shown !== null && shown.wdl !== null ? shown.wdl.draw : 0;
  const whiteTween = useTweenedPercent(whitePct);
  const drawTween = useTweenedPercent(drawPct);
  const pending = valid === null;
  // A failed fetch is not loading: drop the pulse so the bar never spins
  // forever on the old value. Retry clears the failure upstream and the pulse
  // resumes while the refetch is in flight.
  const loading = pending && shown !== null && !failed;
  const statusSuffix = loading ? ' · updating' : failed && pending ? ' · update failed' : '';
  const description = shown !== null ? shown.description : 'No evaluation yet';
  const breakdown =
    shown !== null && shown.wdl !== null
      ? `White ${Math.round(shown.wdl.white)}% · Draw ${Math.round(shown.wdl.draw)}% · Black ${Math.round(shown.wdl.black)}%`
      : `White ${Math.round(percent)}% · Black ${Math.round(100 - percent)}%`;
  const accessibleName =
    shown === null
      ? `${description}${failed && pending ? ' · update failed' : ''}`
      : `${description} · ${breakdown} · estimated White winning chance ${Math.round(percent)}%${statusSuffix}`;
  const drawStyle =
    orientation === 'white'
      ? { height: `${drawTween}%`, bottom: `${whiteTween}%` }
      : { height: `${drawTween}%`, top: `${whiteTween}%` };
  // Per-segment tags: draw centered on its segment, White/Black pinned near
  // their own ends. Zero segments show no tag (mate/draw terminals keep
  // their text on the winning side instead of a percentage).
  const whiteTag = shown === null ? null : shown.whiteText;
  const blackTag = shown === null ? null : shown.blackText;
  const drawTag =
    shown !== null && shown.drawText !== null && drawTween > 0.05 ? shown.drawText : null;
  const drawTagStyle =
    orientation === 'white'
      ? { bottom: `${whiteTween + drawTween / 2}%` }
      : { top: `${whiteTween + drawTween / 2}%` };
  return (
    <section
      className={`eval-balance orientation-${orientation}${pending ? ' pending' : ''}${loading ? ' loading' : ''}`}
      aria-label={label}
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
        {!shown ? (
          <strong className="balance-tag balance-pending-tag" aria-hidden="true">
            —
          </strong>
        ) : (
          <>
            {whiteTag != null && (
              <strong className="balance-tag balance-white-tag" aria-hidden="true">
                {whiteTag}
              </strong>
            )}
            {drawTag != null && (
              <strong
                className="balance-tag balance-draw-tag"
                aria-hidden="true"
                style={drawTagStyle}
              >
                {drawTag}
              </strong>
            )}
            {blackTag != null && (
              <strong className="balance-tag balance-black-tag" aria-hidden="true">
                {blackTag}
              </strong>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function objectiveReading(
  turn: 'white' | 'black',
  expected: number | null,
  wdl: { white: number; draw: number; black: number } | null,
  mate: Score | null,
  outcome: DomainOutcome | null,
  score: Score | null,
) {
  if (outcome !== null && outcome.kind === 'checkmate') {
    const white = outcome.winner === 'white';
    const triple = white ? { white: 100, draw: 0, black: 0 } : { white: 0, draw: 0, black: 100 };
    const text = white ? '+M0' : '-M0';
    return {
      percent: white ? 100 : 0,
      wdl: triple,
      whiteText: white ? text : null,
      blackText: white ? null : text,
      drawText: null,
      description: white ? 'White wins' : 'Black wins',
    };
  }
  if (outcome !== null)
    return {
      percent: 50,
      wdl: { white: 0, draw: 100, black: 0 },
      whiteText: null,
      blackText: null,
      drawText: 'Draw',
      description: 'Draw',
    };
  if (mate !== null) {
    const white = (mate.winning_side ?? (mate.value > 0 ? 'white' : 'black')) === 'white';
    const text = scoreValueText(mate);
    const triple = white ? { white: 100, draw: 0, black: 0 } : { white: 0, draw: 0, black: 100 };
    return {
      percent: white ? 100 : 0,
      wdl: triple,
      whiteText: white ? text : null,
      blackText: white ? null : text,
      drawText: null,
      description: `${text} · White perspective`,
    };
  }
  if (score !== null && score.type === 'mate') {
    const white = (score.winning_side ?? (score.value > 0 ? 'white' : 'black')) === 'white';
    const text = scoreValueText(score);
    const triple = white ? { white: 100, draw: 0, black: 0 } : { white: 0, draw: 0, black: 100 };
    return {
      percent: white ? 100 : 0,
      wdl: triple,
      whiteText: white ? text : null,
      blackText: white ? null : text,
      drawText: null,
      description: `${text} · White perspective · Stockfish`,
    };
  }
  if (score !== null && score.type === 'cp') {
    const percent = whiteWin(score);
    const text = scoreValueText(score);
    const white = score.value >= 0;
    return {
      percent,
      wdl: null,
      whiteText: white ? text : null,
      blackText: white ? null : text,
      drawText: null,
      description: `${text} · White perspective · Stockfish`,
    };
  }
  if (expected === null) return null;
  if (wdl !== null) {
    const percent = wdl.white + wdl.draw / 2;
    const text = `W ${Math.round(wdl.white)}% · D ${Math.round(wdl.draw)}% · B ${Math.round(wdl.black)}%`;
    return {
      percent,
      wdl,
      whiteText: wdl.white > 0.05 ? `${Math.round(wdl.white)}%` : null,
      blackText: wdl.black > 0.05 ? `${Math.round(wdl.black)}%` : null,
      drawText: wdl.draw > 0.05 ? `${Math.round(wdl.draw)}%` : null,
      description: `${text} · White perspective · ${sourceLabel()}`,
    };
  }
  const percent = whiteExpected(turn, expected);
  const text = `W ${Math.round(percent)}% · B ${Math.round(100 - percent)}%`;
  return {
    percent,
    wdl: null,
    whiteText: percent > 0.05 ? `${Math.round(percent)}%` : null,
    blackText: 100 - percent > 0.05 ? `${Math.round(100 - percent)}%` : null,
    drawText: null,
    description: `${text} · White perspective · ${sourceLabel()}`,
  };
}
