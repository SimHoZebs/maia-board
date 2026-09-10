import { useLayoutEffect, useRef, useState } from 'react';
import type { Review } from './useReview';
import { scoreText, whiteWin, type Quality } from './reviewMetrics';

export function QualityBadge({ quality }: { quality?: Quality }) {
  const label = quality?.label ?? 'Unreviewed';
  return <span className={`quality quality-${label.toLowerCase()}`} title={`${label}${quality?.accuracy == null ? '' : ` · ${quality.accuracy.toFixed(1)}% move accuracy`}`} aria-label={label}>{({ Forced: 'F', Blunder: '??', Mistake: '?', Inaccuracy: '?!', Great: '!', Best: 'B', Good: 'G', Unreviewed: '–' })[label]}</span>;
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
    const description = `${index === 0 ? 'Starting position' : `${index}. ${sans[index - 1]}`} · ${value === null ? 'Unreviewed' : `${value.toFixed(1)}% ${tab === 'evaluation' ? 'White winning chance' : 'move accuracy'}`} · ${evaluation ? `${scoreText(evaluation)} · ${evaluation.terminal ? 'terminal result' : `depth ${evaluation.depth}`}` : 'evaluation missing'}${quality ? ` · ${quality.label}` : ''}`;
    return { node, value, description, evaluation, quality };
  });
  const firstWhite = review.nodes[0].fen.split(' ')[1] === 'w';
  return <section className="review-charts" aria-label="Game review">
    <h2>Game review</h2>
    <div className="accuracy-summary">{(['White', 'Black'] as const).map((side, sideIndex) => {
      const moves = review.qualities.filter((_, index) => (index % 2 === 0) === (sideIndex === 0 ? firstWhite : !firstWhite));
      const reviewed = moves.filter(move => move.accuracy !== null);
      const mean = reviewed.length ? reviewed.reduce((sum, move) => sum + move.accuracy!, 0) / reviewed.length : null;
      const counts = [...new Set(reviewed.map(move => move.label))].map(label => `${reviewed.filter(move => move.label === label).length} ${label}`).join(' · ');
      return <div key={side}><strong>{side}</strong><b>{mean === null ? '—' : `${mean.toFixed(1)}%`}</b><span>Mean move accuracy</span><small>{reviewed.length} / {moves.length} reviewed</small><small>{counts || 'No reviewed moves'}</small></div>;
    })}</div>
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
    <details><summary>Review method and chart data</summary>
      <p>Stockfish 19 estimates at the reported depth; grades are approximate. Evaluation favors White when positive. Mate scores preserve the winner; mate distance does not affect accuracy.</p>
      <p>Loss is the drop in the mover’s winning chance: 5 percentage points = Inaccuracy, 10 = Mistake, 20 = Blunder. Best follows Stockfish’s top move; other low-loss moves are Good. Great means the top move loses at most 1 point and beats the second evaluated centipawn alternative by at least 10 points. This is a strong-alternative heuristic, not brilliant-move detection.</p>
      <p>Forced means only one legal move and counts as 100%. Mean move accuracy is the arithmetic average by side, including Forced. Missing or failed pairs are Unreviewed and excluded. <a href="https://lichess.org/page/accuracy" target="_blank" rel="noreferrer">Lichess winning-chance and move-accuracy formulas</a>; game averages use our own method, maia-board-review-v1.</p>
      <div className="chart-table"><table><caption>Position estimates and played-move quality</caption><thead><tr><th>Position</th><th>Evaluation / depth</th><th>Move accuracy</th></tr></thead><tbody>{points.map((point, index) => <tr key={index}><td><button onClick={() => onView(index)}>{index}: {sans[index - 1] ?? 'Start'}</button></td><td>{point.evaluation ? `${scoreText(point.evaluation)} / ${point.evaluation.depth}` : 'Missing'}</td><td>{point.quality?.accuracy == null ? 'Unreviewed' : `${point.quality.accuracy.toFixed(1)}% · ${point.quality.label}`}</td></tr>)}</tbody></table></div>
    </details>
  </section>;
}
