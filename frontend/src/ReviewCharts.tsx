import { useLayoutEffect, useRef, useState } from 'react';
import type { Review } from './useReview';
import { scoreText, whiteWin, type Quality } from './reviewMetrics';

export function QualityBadge({ quality }: { quality?: Quality }) {
  if (!quality || quality.label === 'Unreviewed') return null;
  const label = quality.label;
  return <span className={`quality quality-${label.toLowerCase()}`} title={`${label}${quality.accuracy == null ? '' : ` · ${quality.accuracy.toFixed(1)}% move accuracy`}`} aria-label={label}>{({ Forced: 'F', Blunder: '??', Mistake: '?', Inaccuracy: '?!', Great: '!', Best: 'B', Good: 'G' })[label]}</span>;
}
export function ReviewCharts({ review, ply, sans, onView }: { review: Review; ply: number; sans: string[]; onView: (ply: number) => void }) {
  const [tab, setTab] = useState<'evaluation' | 'accuracy'>('evaluation');
  const selected = useRef<HTMLButtonElement>(null);
  const chart = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (selected.current && chart.current) chart.current.scrollLeft = selected.current.offsetLeft - chart.current.clientWidth / 2 + 22;
  }, [ply, tab]);
  const points = review.nodes.map((node, index) => {
    const evaluation = review.evaluations[index];
    const quality = index ? review.qualities[index - 1] : undefined;
    const value = tab === 'evaluation' ? evaluation ? whiteWin(evaluation.score) : null : quality?.accuracy ?? null;
    const description = [
      index === 0 ? 'Starting position' : `${index}. ${sans[index - 1]}`,
      value === null ? null : `${value.toFixed(1)}% ${tab === 'evaluation' ? 'White winning chance' : 'move accuracy'}`,
      evaluation ? `${scoreText(evaluation)} · ${evaluation.terminal ? 'terminal result' : `depth ${evaluation.depth}`}` : null,
      quality && quality.label !== 'Unreviewed' ? quality.label : null,
    ].filter(Boolean).join(' · ');
    return { node, value, description, evaluation, quality };
  });
  const trackWidth = Math.max(264, points.length * 44);
  const yFor = (percent: number) => 110 - percent;
  const ticks = [100, 75, 50, 25, 0];
  return <section className="review-charts" aria-label="Game review">
    <h2>Game review</h2>
    <div className="chart-tabs" role="tablist" aria-label="Review chart"><button role="tab" aria-selected={tab === 'evaluation'} onClick={() => setTab('evaluation')}>Evaluation</button><button role="tab" aria-selected={tab === 'accuracy'} onClick={() => setTab('accuracy')}>Move accuracy</button></div>
    <div className="review-chart" role="tabpanel" aria-label={tab === 'evaluation' ? 'Evaluation graph' : 'Move accuracy graph'}>
      <div className="chart-yaxis" aria-hidden="true">{ticks.map(tick => <span key={tick} style={{ top: yFor(tick) }}>{tick}%</span>)}</div>
      <div className="chart-scroll" ref={chart}>
      <div className="chart-track" style={{ width: trackWidth }}>
        <svg aria-hidden="true" width="100%" height="120" viewBox={`0 0 ${trackWidth} 120`} preserveAspectRatio="none">
          {ticks.map(tick => <line key={tick} x1="0" x2={trackWidth} y1={yFor(tick)} y2={yFor(tick)} className={tick === 50 ? 'chart-midline' : 'chart-gridline'} />)}
          {points.map((point, index) => index > 0 && point.value !== null && points[index - 1].value !== null ? <line key={index} x1={(index - 1) * 44 + 22} y1={110 - points[index - 1].value!} x2={index * 44 + 22} y2={110 - point.value} className="chart-line" /> : null)}
        </svg>
        {points.map((point, index) => <button key={index} ref={index === ply ? selected : undefined} className="chart-point" aria-label={point.description} aria-current={index === ply ? 'step' : undefined} title={point.description} onClick={() => onView(index)} style={{ left: index * 44 }}>{point.value !== null && <i style={{ top: 110 - point.value }} />}<span>{index}</span></button>)}
      </div>
      </div>
    </div>
  </section>;
}
