import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch } from 'react';
import { absoluteWdl, candidateSan, exportLine, gameResult, loadLine, replay, sideName, START_FEN } from './domain';
import type { Action, State } from './state';
import { downloadPgn, Rating } from './BoardTools';
import { Dialog } from './Dialog';
import { ArrowLeft, ArrowRight, SkipBack, SkipForward } from 'lucide-react';
import type { Review } from './useReview';
import { QualityBadge, ReviewCharts } from './ReviewCharts';
import { getAnalysisRecords, isFreshRecord, lineHash } from './analysisRecords';
import { scoreValueText, whiteWin, type Evaluation, type Quality } from './reviewMetrics';

function recordDate(completedAt: string): string {
  return new Date(completedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ReviewLaunch({ state, review }: { state: State; review: Review }) {
  const branch = state.analysis.branchFromPly !== null;
  if (branch) {
    if (review.progress?.running) return null;
    return <button className="primary" disabled={review.tooLong} onClick={review.start}>Analyze explored line</button>;
  }
  const progress = review.progress;
  const complete = !!progress && !progress.running && !progress.canceled && progress.done === progress.total && !progress.failed;
  if (progress?.running) return null;
  const record = review.recordStatus.state === 'fresh' ? review.recordStatus.record :
    review.recordStatus.state === 'stale' ? review.recordStatus.record : undefined;
  if (complete || (review.coverage && review.coverage.covered === review.coverage.total)) {
    return <div className="analysis-record"><p role="status">Analyzed{record ? ` · ${recordDate(record.completed_at)}` : ''}</p><button className="quiet" onClick={review.start}>Re-analyze</button></div>;
  }
  if (progress && (progress.canceled || progress.failed > 0)) {
    return <div className="analysis-record"><button className="primary" disabled={review.tooLong} onClick={review.start}>Analyze entire game</button></div>;
  }
  if (review.coverage && record) {
    return <div className="analysis-record"><p role="status">Analyzed · {recordDate(record.completed_at)} · {review.coverage.covered} of {review.coverage.total} positions cached</p><button className="primary" onClick={review.start}>Restore remaining</button></div>;
  }
  if (review.recordStatus.state === 'fresh') return <button className="primary" disabled>Loading analysis…</button>;
  if (review.recordStatus.state === 'checking') return <button className="primary" disabled>Checking analysis…</button>;
  return <div className="analysis-record">{review.recordStatus.state === 'stale' && record &&
    <p>Last analyzed {recordDate(record.completed_at)} · Maia {record.settings.elo_maia} · {record.settings.model}</p>}
    <button className="primary" disabled={review.tooLong} onClick={review.start}>Analyze entire game</button></div>;
}

export function InsightPanel({ state, dispatch, review }: { state: State; dispatch: Dispatch<Action>; review: Review }) {
  const { analysisSettings } = state;
  const response = review.maia;
  const node = review.nodes[state.analysis.index];
  const insight = response ? { fen: node.fen } : undefined;
  const played = review.nodes[state.analysis.index + 1]?.moves[state.analysis.index];
  const evaluation = review.current;
  return <aside className="panel insight-panel" aria-labelledby="insight-title">
    {review.tooLong && <p role="status">Review supports up to 256 moves (plies).</p>}
    {(review.error || !!review.progress?.failed) && <p role="alert">{review.error || `${review.progress!.failed} analysis jobs failed.`} <button onClick={review.retry}>Retry failed</button></p>}
    <ReviewLaunch state={state} review={review} />
    {review.progress && <div role="status">{review.progress.done} / {review.progress.total} analysis jobs {review.progress.failed ? `· ${review.progress.failed} failed` : ''} {review.progress.canceled ? '· canceled' : ''}{review.progress.running && <button onClick={review.cancel}>Cancel analysis</button>}</div>}
    <ReviewCharts review={review} ply={state.analysis.index} sans={review.nodes.at(-1)!.moves.map((_, index) => candidateSan(review.nodes[index].fen, review.nodes[index + 1].moves[index]))} onView={ply => dispatch({ type: 'view', ply })} side={state.analysis.perspective} yours={state.analysis.ownGame} />
    <div className="engine-duo">
    <section aria-label="Maia analysis">
      <h2 id="insight-title"><span className="source-dot source-maia" aria-hidden="true" /> Human moves · {analysisSettings.eloMaia} rating</h2>
      <details><summary>Analysis settings</summary><Rating id="analysis-rating" label="Analyzed-player rating" value={analysisSettings.eloMaia} onChange={eloMaia => dispatch({ type: 'analysis-settings', settings: { eloMaia } })} /><label className="field">Model<select id="analysis-model" value={analysisSettings.model} onChange={event => dispatch({ type: 'analysis-settings', settings: { model: event.target.value as '5m' | '79m' } })}><option value="79m">79M</option><option value="5m">5M</option></select></label></details>
      <p className="model-context">Maia {response?.model_used.toUpperCase() ?? analysisSettings.model.toUpperCase()}{response?.degraded ? ' · fallback model' : ''}</p>
      {response && insight ? <div id="insight-content">
        <section className="estimate" aria-label="Maia win estimate"><div className="win-hero"><strong>{Math.round(absoluteWdl(insight.fen, response.wdl)[0] * 100)}%</strong><span>White win · after {candidateSan(insight.fen, response.top_moves[0].move)}</span></div></section>
        <h3>Maia {analysisSettings.eloMaia} moves</h3>
        <ol className="candidate-list">{response.top_moves.slice(0, 5).map((candidate, index) => {
          const san = candidateSan(insight.fen, candidate.move);
          return <li key={candidate.move}><span className="rank">{index + 1}</span>{candidate.move === played && <span className="played-tag">Played</span>}<button className="candidate-preview" aria-label={`Preview ${san}`} aria-pressed={state.preview === candidate.move} onMouseEnter={() => dispatch({ type: 'preview', uci: candidate.move })} onFocus={() => dispatch({ type: 'preview', uci: candidate.move })} onClick={() => dispatch({ type: 'preview', uci: candidate.move })}><strong>{san}</strong><span className="metric">{Math.round(candidate.prob * 100)}%</span></button></li>;
        })}</ol>
        {played && !response.top_moves.slice(0, 5).some(candidate => candidate.move === played) && <p>Played {candidateSan(insight.fen, played)}</p>}
      </div> : <p className="empty-copy">No analysis yet.</p>}
    </section>
    <section aria-label="Stockfish evaluation">
      <h2><span className="source-dot source-stockfish" aria-hidden="true" /> Stockfish</h2>
      {evaluation ? <StockfishBody fen={node.fen} evaluation={evaluation} played={played} /> : <p className="empty-copy">No analysis yet.</p>}
    </section>
    </div>
  </aside>;
}

function StockfishBody({ fen, evaluation, played }: { fen: string; evaluation: Evaluation; played?: string }) {
  if (evaluation.terminal) return <div>
    <section className="estimate" aria-label="Stockfish win estimate"><div className="win-hero"><strong>{Math.round(whiteWin(evaluation.score))}%</strong><span>White win · final</span></div></section>
    <p>{evaluation.terminal === 'draw' ? 'Draw' : evaluation.terminal === 'white_win' ? 'White wins' : 'Black wins'}</p>
  </div>;
  return <div>
    <p className="model-context">Stockfish 19 · depth {evaluation.depth}</p>
    <section className="estimate" aria-label="Stockfish win estimate"><div className="win-hero"><strong>{Math.round(whiteWin(evaluation.score))}%</strong><span>White win · this position</span></div></section>
    <h3>Engine moves</h3>
    <ol className="candidate-list">{evaluation.lines.map((line, index) => {
      const san = candidateSan(fen, line.move);
      return <li key={line.move}><span className="rank">{index + 1}</span>{line.move === played && <span className="played-tag">Played</span>}<span className="line-reading"><strong>{san}</strong><span className="metric">{scoreValueText(line.score)}</span></span></li>;
    })}</ol>
    {played && !evaluation.lines.some(line => line.move === played) && <p>Played {candidateSan(fen, played)}</p>}
  </div>;
}

export function MovesPanel({ sans, ply, onView, initialFen, historical, qualities }: { sans: string[]; ply: number; onView: (ply: number | null) => void; initialFen: string; historical: boolean; qualities?: Quality[] }) {
  const active = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = list.current!;
    const reveal = () => {
      const button = active.current;
      if (button) container.scrollLeft = button.offsetLeft - container.clientWidth / 2 + button.clientWidth / 2;
      else if (ply === 0) container.scrollLeft = 0;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(container);
    return () => observer.disconnect();
  }, [ply, sans.length]);
  const parts = initialFen.split(' '), first = Number(parts[5]) * 2 + (parts[1] === 'b' ? 1 : 0);
  return <section className="notation" aria-label="Move history">
    <div className="move-list" id="move-list" ref={list}>{!sans.length && <span className="empty-copy">Moves appear here</span>}{sans.map((san, index) => <button ref={ply === index + 1 ? active : undefined} className="move-cell" aria-current={ply === index + 1 ? 'step' : undefined} key={index} onClick={() => onView(index + 1)}><span>{Math.floor((first + index) / 2)}{(first + index) % 2 ? '…' : '.'}</span> {san} {qualities && <QualityBadge quality={qualities[index]} />}</button>)}</div>
    <div className="move-navigation"><div className="nav-buttons">{[{ id: 'first', label: 'First position', Icon: SkipBack, to: 0 }, { id: 'prev', label: 'Previous position', Icon: ArrowLeft, to: ply - 1 }, { id: 'next', label: 'Next position', Icon: ArrowRight, to: ply + 1 }, { id: 'last', label: 'Last position', Icon: SkipForward, to: sans.length }].map(item => <button key={item.id} id={`analysis-${item.id}`} aria-label={item.label} title={item.label} disabled={item.to < 0 || item.to > sans.length || item.to === ply} onClick={() => onView(item.to)}><item.Icon size={18} aria-hidden="true" /></button>)}</div><span id="analysis-index">Position {ply + 1} / {sans.length + 1}</span></div>
    {historical && <button className="return-game" onClick={() => onView(null)}>Return to game</button>}
  </section>;
}

export function SavedGames({ state, dispatch, analysisOnly = false }: { state: State; dispatch: Dispatch<Action>; analysisOnly?: boolean }) {
  const [deleting, setDeleting] = useState<string | null>(null);
  // Line-level analyzed lookup, memoized on the saved list plus the current
  // analysis settings: the badge must agree with the detail view, which
  // compares records against global analysisSettings (History→Analyze keeps
  // them). Chunked client-side past the 200-hash server cap.
  const badgeKey = `${state.saved.map(game => `${game.id}:${game.moves.join(',')}`).join('|')}|${state.analysisSettings.eloMaia}|${state.analysisSettings.model}`;
  const [analyzedLines, setAnalyzedLines] = useState<Set<string>>(new Set());
  useEffect(() => {
    const settings = { eloMaia: state.analysisSettings.eloMaia, eloUser: state.analysisSettings.eloMaia, model: state.analysisSettings.model };
    const hashes = state.saved.map(game => lineHash(START_FEN, game.moves));
    let cancelled = false;
    getAnalysisRecords(hashes).then(
      records => { if (!cancelled) setAnalyzedLines(new Set(records.filter(record => isFreshRecord(record, settings)).map(record => record.line_hash))); },
      () => { if (!cancelled) setAnalyzedLines(new Set()); },
    );
    return () => { cancelled = true; };
  }, [badgeKey]);
  const badgeHashes = useMemo(() => state.saved.map(game => lineHash(START_FEN, game.moves)), [badgeKey]);
  return <section className="saved-panel" aria-label="Saved games">
    {!analysisOnly && <div className="saved-heading"><h1>History</h1>
      {state.syncPending > 0 && <span role="status">Syncing…</span>}
      {state.historyTotal !== null && state.historyTotal > state.saved.length && <span>Showing {state.saved.length} of {state.historyTotal}</span>}
    </div>}
    {!state.saved.length && <p className="empty-copy">Your games will appear here.</p>}
    <div id="saved-games">{state.saved.map((game, index) => {
      const result = gameResult(replay(game.moves));
      return <article className="saved-game" key={game.id}><div><time dateTime={game.createdAt}>{new Date(game.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time><h2>{sideName(game.settings.userColor)} · Maia {game.settings.eloMaia}</h2><p>{result}{analyzedLines.has(badgeHashes[index]) && ' · Analyzed'}</p></div><div className="actions">{!analysisOnly && result === 'Unfinished' && <button data-game-id={game.id} onClick={() => dispatch({ type: 'saved', id: game.id })}>Resume</button>}<button onClick={() => dispatch({ type: 'review', id: game.id })}>Analyze</button>{!analysisOnly && <><button onClick={() => downloadPgn(exportLine(loadLine('', game.moves.join(' '))), 'maia-game.pgn')}>Export</button><button onClick={() => setDeleting(game.id)}>Delete</button></>}</div></article>;
    })}</div>
    {deleting && <Dialog title="Delete saved game?" onCancel={() => setDeleting(null)}><h2>Delete saved game?</h2><p>This removes the game from this device.</p><div className="actions"><button onClick={() => { dispatch({ type: 'delete', id: deleting }); setDeleting(null); }}>Delete game</button><button onClick={() => setDeleting(null)}>Cancel</button></div></Dialog>}
  </section>;
}
