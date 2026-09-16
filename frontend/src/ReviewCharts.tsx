import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Review } from './useReview';
import { scoreText, whiteWin, type Quality } from './reviewMetrics';
import type { ReviewSide } from './reviewSummary';

export const qualityGlyphs = { Forced: 'F', 'Allowed mate': '💀', Blunder: '??', Mistake: '?', Inaccuracy: '?!', Excellent: '!!', Great: '!', Best: 'B', Good: 'G' } as const;
// Labels double as CSS hooks, so multi-word verdicts slug to a single token:
// "Allowed mate" -> "allowed-mate" (quality-allowed-mate, chart-dot-allowed-mate).
export const qualitySlug = (label: string) => label.toLowerCase().replace(/\s+/g, '-');
// Slot-reel deck: every real verdict, so the loading spinner previews the
// exact glyphs it can settle on. Order matches the lab page row 03.
const loadingFaces: { glyph: string; cls: string }[] = (Object.keys(qualityGlyphs) as (keyof typeof qualityGlyphs)[]).map(label => ({ glyph: qualityGlyphs[label], cls: `quality-${qualitySlug(label)}` }));
const loadingStrip = [...loadingFaces, ...loadingFaces, ...loadingFaces];

// Pending-badge treatment while evaluations settle. Reel is the default;
// shimmer and the original blank placeholder are opt-outs in Settings.
export type BadgeLoading = 'reel' | 'shimmer' | 'placeholder';

export function QualityBadge({ quality, reserveSpace, loading = 'reel' }: { quality?: Quality; reserveSpace?: boolean; loading?: BadgeLoading }) {
  if (!quality) {
    // Genuinely not loading (opponent moves, unevaluated lines): invisible
    // reserve box, so rows keep their shape without implying work is coming.
    if (!reserveSpace) return null;
    return <span className="quality quality-placeholder" aria-hidden="true">??</span>;
  }
  if (quality.label === 'Unreviewed') {
    // Genuinely pending: producers emit Unreviewed only while the
    // coordinator's pending set says a verdict may still arrive. Same box
    // as a settled badge either way, so rows never shift. Decorative
    // (aria-hidden): the move text already carries meaning, and announcing
    // per-move spinners would be noise.
    if (!reserveSpace) return null;
    if (loading === 'placeholder') return <span className="quality quality-placeholder" aria-hidden="true">??</span>;
    if (loading === 'shimmer') return <span className="quality quality-shimmer" aria-hidden="true" title="Evaluating…"><span className="quality-shimmer-bar" /></span>;
    return <span className="quality quality-slot" aria-hidden="true" title="Evaluating…"><span className="quality-slot-window"><span className="quality-slot-strip">{loadingStrip.map((face, index) => <span key={index} className={`quality-slot-cell ${face.cls}`}>{face.glyph}</span>)}</span></span></span>;
  }
  const label = quality.label;
  return <span className={`quality quality-${qualitySlug(label)}`} title={`${label}${quality.accuracy == null ? '' : ` · ${quality.accuracy.toFixed(1)}% move accuracy`}`} aria-label={label}>{qualityGlyphs[label]}</span>;
}
export function ReviewCharts({ review, ply, sans, onView, side }: { review: Review; ply: number; sans: string[]; onView: (ply: number) => void; side?: ReviewSide }) {
  const [tab, setTab] = useState<'evaluation' | 'accuracy'>('accuracy');
  const id = useId();
  const tabs = [{ id: 'accuracy', label: 'Move accuracy' }, { id: 'evaluation', label: 'Evaluation' }] as const;
  const selected = useRef<HTMLButtonElement>(null);
  const chart = useRef<HTMLDivElement>(null);
  // Hovered graphs claim the wheel for horizontal panning: a vertical wheel
  // gesture scrolls the track sideways instead of the page. At either edge
  // the gesture falls through so the outer panel can still scroll vertically.
  // Trackpads already emit deltaX, so only dominant-vertical wheels convert.
  // Mount-once: the handler reads only the stable chart node, never tab state.
  useEffect(() => {
    const el = chart.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      const canLeft = el.scrollLeft > 0;
      const canRight = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      if ((event.deltaY > 0 && !canRight) || (event.deltaY < 0 && !canLeft)) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  // Accuracy points sit on the after-move position (point i reviews the move
  // leading into it); point 0 is the start with no move, so nothing selects.
  const selectedPly = tab === "accuracy" && ply === 0 ? -1 : ply;
  useLayoutEffect(() => {
    if (selected.current && chart.current) chart.current.scrollLeft = selected.current.offsetLeft - chart.current.clientWidth / 2 + 22;
  }, [ply, tab]);
  const points = review.nodes.map((node, index) => {
    const evaluation = review.evaluations[index];
    const quality = index ? review.qualities[index - 1] : undefined;
    const beforeNode = index ? review.nodes[index - 1] : null;
    const beforeFen = beforeNode?.fen.split(' ') ?? null;
    const mover = beforeNode ? beforeNode.turn : null;
    const outOfScope = !!side && mover !== side;
    const value = outOfScope ? null : tab === 'evaluation' ? evaluation ? whiteWin(evaluation.score) : null : quality?.accuracy ?? null;
    const moveNumber = beforeFen ? `${beforeFen[5]}${beforeFen[1] === 'w' ? '.' : '…'}` : '0';
    const description = [
      index === 0 ? 'Starting position' : `${moveNumber} ${sans[index - 1]} · ${mover === 'white' ? 'White' : 'Black'}`,
      value === null ? null : `${value.toFixed(1)}% ${tab === 'evaluation' ? 'White winning chance' : 'move accuracy'}`,
      tab === 'evaluation' && evaluation ? `${scoreText(evaluation)} · ${evaluation.terminal ? 'terminal result' : `depth ${evaluation.depth}`}` : null,
      quality && quality.label !== 'Unreviewed' ? quality.label : null,
    ].filter(Boolean).join(' · ');
    return { node, value, description, evaluation, quality, moveNumber, mover };
  });
  const yFor = (percent: number) => 110 - percent;
  const ticks = [100, 75, 50, 25, 0];
  // With a known identity the graph carries only your moves: opponent
  // positions leave the track entirely so your points sit adjacently and the
  // line connects them. Without one (pasted lines) every ply stays.
  const kept = points.flatMap((point, index) => {
    if (side !== undefined && point.mover !== side) return [];
    return [{ ...point, origIndex: index }];
  });
  const selectedPos = kept.findIndex(point => point.origIndex === selectedPly);
  const trackWidth = Math.max(264, kept.length * 44);
  return <section className="review-charts" aria-label="Game review">
    <div className="chart-tabs" role="tablist" aria-label="Review chart">
      {tabs.map((item, index) => <button key={item.id} type="button" role="tab" id={`${id}-${item.id}`} aria-controls={`${id}-panel`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => setTab(item.id)} onKeyDown={event => {
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
        if (next === null) return;
        event.preventDefault(); event.stopPropagation(); setTab(tabs[next].id);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus();
      }}>{item.label}</button>)}
    </div>
    <div className="review-chart" id={`${id}-panel`} role="tabpanel" aria-label={tab === 'evaluation' ? 'Evaluation graph' : 'Move accuracy graph'} tabIndex={0}>
      <div className="chart-yaxis" aria-hidden="true">{ticks.map(tick => <span key={tick} style={{ top: yFor(tick) }}>{tick}%</span>)}</div>
      <div className="chart-scroll" ref={chart}>
      <div className="chart-track" style={{ width: trackWidth }}>
        <svg aria-hidden="true" width="100%" height="120" viewBox={`0 0 ${trackWidth} 120`} preserveAspectRatio="none">
          {ticks.map(tick => <line key={tick} x1="0" x2={trackWidth} y1={yFor(tick)} y2={yFor(tick)} className={tick === 50 ? 'chart-midline' : 'chart-gridline'} />)}
          {kept.map((point, pos) => pos > 0 && point.value !== null && kept[pos - 1].value !== null ? <line key={point.origIndex} x1={(pos - 1) * 44 + 22} y1={110 - kept[pos - 1].value!} x2={pos * 44 + 22} y2={110 - point.value} className="chart-line" /> : null)}
        </svg>
        {kept.map((point, pos) => {
          return <button key={point.origIndex} type="button" ref={pos === selectedPos ? selected : undefined} className="chart-point" disabled={tab === 'accuracy' && point.origIndex === 0} aria-label={point.description} aria-current={pos === selectedPos ? 'step' : undefined} title={point.description} onClick={() => onView(point.origIndex)} style={{ left: pos * 44 }}>{point.value !== null && <i className={tab === 'accuracy' && point.quality ? `chart-dot-${qualitySlug(point.quality.label)}` : undefined} style={{ top: 110 - point.value }} />}<span>{point.moveNumber}</span></button>;
        })}
      </div>
      </div>
    </div>
  </section>;
}
