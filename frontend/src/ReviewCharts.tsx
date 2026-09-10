import { useLayoutEffect, useRef, useState } from 'react';
import type { Review } from './useReview';
import { scoreText, whiteWin, type Quality } from './reviewMetrics';
import { sideName } from './domain';
import type { MaiaColor } from './api';

export function QualityBadge({ quality }: { quality?: Quality }) {
  const label = quality?.label ?? 'Unreviewed';
  return <span className={`quality quality-${label.toLowerCase()}`} title={`${label}${quality?.accuracy == null ? '' : ` · ${quality.accuracy.toFixed(1)}% move accuracy`}`} aria-label={label}>{({ Forced: 'F', Blunder: '??', Mistake: '?', Inaccuracy: '?!', Great: '!', Best: 'B', Good: 'G', Unreviewed: '–' })[label]}</span>;
}
export function ReviewCharts({ review, ply, sans, onView, side, yours }: { review: Review; ply: number; sans: string[]; onView: (ply: number) => void; side: MaiaColor; yours: boolean }) {
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
    const description = `${index === 0 ? 'Starting position' : `${index}. ${sans[index - 1]}`} · ${value === null ? 'Unreviewed' : `${value.toFixed(1)}% ${tab === 'evaluation' ? 'White winning chance' : 'move accuracy'}`} · ${evaluation ? `${scoreText(evaluation)} · ${evaluation.terminal ? 'terminal result' : `depth ${evaluation.depth}`}` : 'evaluation missing'}${quality ? ` · ${quality.label}` : ''}`;
    return { node, value, description, evaluation, quality };
  });
  const firstWhite = review.nodes[0].fen.split(' ')[1] === 'w';
  const sideMoves = review.qualities.filter((_, index) => (index % 2 === 0) === ((side === 'white') === firstWhite));
  const sideReviewed = sideMoves.filter(move => move.accuracy !== null);
  const sideMean = sideReviewed.length ? sideReviewed.reduce((sum, move) => sum + move.accuracy!, 0) / sideReviewed.length : null;
  const sideCounts = [...new Set(sideReviewed.map(move => move.label))].map(label => `${sideReviewed.filter(move => move.label === label).length} ${label}`).join(' · ');
  return <section className="review-charts" aria-label="Game review">
    <h2>Game review</h2>
    <div className="chart-tabs" role="tablist" aria-label="Review chart"><button role="tab" aria-selected={tab === 'evaluation'} onClick={() => setTab('evaluation')}>Evaluation</button><button role="tab" aria-selected={tab === 'accuracy'} onClick={() => setTab('accuracy')}>Move accuracy</button></div>
    <p className="chart-caption">{tab === 'evaluation' ? 'White winning chance · 0–100%' : 'Move accuracy · 0–100%'}</p>
    <div className="review-chart" ref={chart} role="tabpanel" aria-label={tab === 'evaluation' ? 'Evaluation graph' : 'Move accuracy graph'}>
      <div className="chart-track" style={{ width: Math.max(264, points.length * 44) }}>
        <svg aria-hidden="true" width="100%" height="120" viewBox={`0 0 ${Math.max(264, points.length * 44)} 120`} preserveAspectRatio="none">
          <line x1="0" x2="100%" y1="60" y2="60" className="chart-midline" />
          {points.map((point, index) => index > 0 && point.value !== null && points[index - 1].value !== null ? <line key={index} x1={(index - 1) * 44 + 22} y1={110 - points[index - 1].value!} x2={index * 44 + 22} y2={110 - point.value} className="chart-line" /> : null)}
        </svg>
        {points.map((point, index) => <button key={index} ref={index === ply ? selected : undefined} className="chart-point" aria-label={point.description} aria-current={index === ply ? 'step' : undefined} title={point.description} onClick={() => onView(index)} style={{ left: index * 44 }}>{point.value !== null && <i style={{ top: 110 - point.value }} />}<span>{index}</span></button>)}
      </div>
    </div>
    <p className="selected-evaluation" aria-live="polite">{points[ply].description}</p>
    {ply > 0 && <p className="selected-quality"><QualityBadge quality={review.qualities[ply - 1]} /> {sans[ply - 1]} · {review.qualities[ply - 1].label}</p>}
    <div className="accuracy-summary single"><div>
      <strong>{sideName(side)}{yours ? ' · you' : ''}</strong>
      <b>{sideMean === null ? '—' : `${sideMean.toFixed(1)}%`}</b>
      <span>Mean move accuracy</span>
      <small>{sideReviewed.length} / {sideMoves.length} reviewed</small>
      <small>{sideCounts || 'No reviewed moves'}</small>
    </div></div>
  </section>;
}
