import { QualityBadge } from './ReviewCharts';
import { scoreValueText } from './reviewMetrics';
import type { PlayFeedback as Feedback } from './usePlayFeedback';

export function PlayFeedback({ feedback, enabled, onToggle }: { feedback: Feedback; enabled: boolean; onToggle: (enabled: boolean) => void }) {
  return <section className="panel play-feedback" aria-label="Last move feedback">
    <div className="feedback-head">
      <h2>Last move</h2>
      <label className="feedback-toggle" htmlFor="feedback-toggle">
        <input id="feedback-toggle" type="checkbox" checked={enabled} onChange={event => onToggle(event.target.checked)} />
        Evaluate my moves
      </label>
    </div>
    {!enabled && <p className="empty-copy">Turn on to have Stockfish evaluate each of your moves after you play it.</p>}
    {enabled && feedback.status === 'empty' && <p className="empty-copy">Your moves will be evaluated here after you play them.</p>}
    {enabled && feedback.status === 'pending' && <p role="status">Evaluating {feedback.playedSan || 'your last move'}…</p>}
    {enabled && feedback.status === 'error' && <p role="alert">{feedback.error ?? 'Stockfish evaluation failed.'} <button type="button" onClick={feedback.retry}>Retry</button></p>}
    {enabled && feedback.status === 'ready' && feedback.quality && feedback.before && feedback.after && <div className="feedback-result">
      <p><strong>{feedback.playedSan}</strong> {feedback.quality.label !== 'Unreviewed' && <QualityBadge quality={feedback.quality} />} <span>{feedback.quality.label}</span></p>
      <p className="feedback-eval">{scoreValueText(feedback.before.score)} → {scoreValueText(feedback.after.score)}
        {feedback.quality.accuracy !== null && <span> · {feedback.quality.accuracy.toFixed(1)}% accuracy</span>}</p>
    </div>}
  </section>;
}
