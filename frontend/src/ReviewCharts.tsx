import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { Review } from './useReview';
import { scoreText, whiteWin, type Quality } from './reviewMetrics';
import type { ReviewSide } from './reviewSummary';

export function QualityBadge({ quality, reserveSpace }: { quality?: Quality; reserveSpace?: boolean }) {
  if (!quality || quality.label === 'Unreviewed') {
    // Invisible stand-in using the widest badge text, so the box (width and
    // baseline) matches a real badge exactly and rows don't shift when
    // evaluations land. Same component, same classes: one source of truth.
    if (!reserveSpace) return null;
    return <span className="quality quality-placeholder" aria-hidden="true">??</span>;
  }
  const label = quality.label;
  return <span className={`quality quality-${label.toLowerCase()}`} title={`${label}${quality.accuracy == null ? '' : ` · ${quality.accuracy.toFixed(1)}% move accuracy`}`} aria-label={label}>{({ Forced: 'F', Blunder: '??', Mistake: '?', Inaccuracy: '?!', Great: '!', Best: 'B', Good: 'G' })[label]}</span>;
}
export function ReviewCharts({ review, ply, sans, onView, side }: { review: Review; ply: number; sans: string[]; onView: (ply: number) => void; side?: ReviewSide }) {
  const [tab, setTab] = useState<'evaluation' | 'accuracy'>('accuracy');
  const id = useId();
  const tabs = [{ id: 'accuracy', label: 'Move accuracy' }, { id: 'evaluation', label: 'Evaluation' }] as const;
  const selected = useRef<HTMLButtonElement>(null);
  const chart = useRef<HTMLDivElement>(null);
  const selectedPly = tab === 'accuracy' ? Math.min(ply + 1, review.nodes.length - 1) : ply;
  useLayoutEffect(() => {
    if (selected.current && chart.current) chart.current.scrollLeft = selected.current.offsetLeft - chart.current.clientWidth / 2 + 22;
  }, [ply, tab]);
  const points = review.nodes.map((node, index) => {
    const evaluation = review.evaluations[index];
    const quality = index ? review.qualities[index - 1] : undefined;
    const before = index ? review.nodes[index - 1].fen.split(' ') : null;
    const mover = before ? (before[1] === 'w' ? 'white' : 'black') : null;
    const turn = node.fen.split(' ')[1] === 'w' ? 'white' : 'black';
    const outOfScope = !!side && (tab === 'evaluation' ? turn !== side : mover !== side);
    const value = outOfScope ? null : tab === 'evaluation' ? evaluation ? whiteWin(evaluation.score) : null : quality?.accuracy ?? null;
    const moveNumber = before ? `${before[5]}${before[1] === 'w' ? '.' : '…'}` : '0';
    const description = [
      index === 0 ? 'Starting position' : `${moveNumber} ${sans[index - 1]} · ${before![1] === 'w' ? 'White' : 'Black'}`,
      value === null ? null : `${value.toFixed(1)}% ${tab === 'evaluation' ? 'White winning chance' : 'move accuracy'}`,
      tab === 'evaluation' && evaluation ? `${scoreText(evaluation)} · ${evaluation.terminal ? 'terminal result' : `depth ${evaluation.depth}`}` : null,
      quality && quality.label !== 'Unreviewed' ? quality.label : null,
    ].filter(Boolean).join(' · ');
    return { node, value, description, evaluation, quality, moveNumber, mover, turn };
  });
  const trackWidth = Math.max(264, points.length * 44);
  const yFor = (percent: number) => 110 - percent;
  const ticks = [100, 75, 50, 25, 0];
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
          {points.map((point, index) => index > 0 && point.value !== null && points[index - 1].value !== null ? <line key={index} x1={(index - 1) * 44 + 22} y1={110 - points[index - 1].value!} x2={index * 44 + 22} y2={110 - point.value} className="chart-line" /> : null)}
        </svg>
        {points.map((point, index) => {
          const scopedOut = !!side && (tab === 'evaluation' ? point.turn !== side : point.mover !== side);
          return <button key={index} type="button" ref={index === selectedPly ? selected : undefined} className="chart-point" disabled={(tab === 'accuracy' && index === 0) || scopedOut} aria-label={point.description} aria-current={index === selectedPly ? 'step' : undefined} title={point.description} onClick={() => onView(tab === 'accuracy' ? index - 1 : index)} style={{ left: index * 44 }}>{point.value !== null && <i className={tab === 'accuracy' && point.quality ? `chart-dot-${point.quality.label.toLowerCase()}` : undefined} style={{ top: 110 - point.value }} />}<span>{point.moveNumber}</span></button>;
        })}
      </div>
      </div>
    </div>
  </section>;
}
