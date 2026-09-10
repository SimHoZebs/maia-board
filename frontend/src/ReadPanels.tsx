import { useLayoutEffect, useRef, useState, type Dispatch } from 'react';
import { absoluteWdl, candidateSan, exportLine, gameResult, loadLine, replay, sideName } from './domain';
import type { Action, State } from './state';
import { downloadPgn, Rating } from './BoardTools';
import { Dialog } from './Dialog';

export function InsightPanel({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  const { insight, request, analysisSettings } = state;
  const response = insight?.response;
  return <aside className="panel insight-panel" aria-labelledby="insight-title">
    <h2 id="insight-title">Human moves · {analysisSettings.eloMaia} rating</h2>
    <details><summary>Analysis settings</summary><Rating id="analysis-rating" label="Analyzed-player rating" value={analysisSettings.eloMaia} onChange={eloMaia => dispatch({ type: 'analysis-settings', settings: { eloMaia } })} /><label className="field">Model<select id="analysis-model" value={analysisSettings.model} onChange={event => dispatch({ type: 'analysis-settings', settings: { model: event.target.value as '5m' | '79m' } })}><option value="79m">79M</option><option value="5m">5M</option></select></label></details>
    <p className="model-context">Maia {response?.model_used.toUpperCase() ?? analysisSettings.model.toUpperCase()}{response?.degraded ? ' · fallback model' : ''}</p>
    <button className="primary" id="analyze-position" disabled={!!request} onClick={() => dispatch({ type: 'analyze' })}>{request ? 'Analyzing…' : 'Analyze position'}</button>
    {response && insight ? <div id="insight-content">
      <h3>Human move probability</h3>
      <ol className="candidate-list">{response.top_moves.slice(0, 5).map((candidate, index) => {
        const san = candidateSan(insight.fen, candidate.move);
        return <li key={candidate.move}><span className="rank">{index + 1}</span><button className="candidate-preview" aria-label={`Preview ${san}`} aria-pressed={state.preview === candidate.move} onMouseEnter={() => dispatch({ type: 'preview', uci: candidate.move })} onFocus={() => dispatch({ type: 'preview', uci: candidate.move })} onClick={() => dispatch({ type: 'preview', uci: candidate.move })}><strong>{san}</strong><span>{Math.round(candidate.prob * 100)}%</span></button><button aria-label={`Try ${san}`} onClick={() => dispatch({ type: 'try', uci: candidate.move })}>Try move</button></li>;
      })}</ol>
      {!!response.top_moves.length && <section className="estimate"><h3>Maia estimate after {candidateSan(insight.fen, response.top_moves[0].move)}</h3>{absoluteWdl(insight.fen, response.wdl).map((value, index) => <div className="wdl-row" key={index}><span>{['White win', 'Draw', 'Black win'][index]}</span><meter min={0} max={1} value={value} /><strong>{Math.round(value * 100)}%</strong></div>)}</section>}
    </div> : <p className="empty-copy">{request ? 'Reading this position…' : 'Choose a position, then Analyze. Move pieces to explore a temporary line.'}</p>}
  </aside>;
}

export function MovesPanel({ sans, ply, onView, initialFen, historical }: { sans: string[]; ply: number; onView: (ply: number | null) => void; initialFen: string; historical: boolean }) {
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
    <div className="move-list" id="move-list" ref={list}>{!sans.length && <span className="empty-copy">Moves appear here</span>}{sans.map((san, index) => <button ref={ply === index + 1 ? active : undefined} className="move-cell" aria-current={ply === index + 1 ? 'step' : undefined} key={index} onClick={() => onView(index + 1)}><span>{Math.floor((first + index) / 2)}{(first + index) % 2 ? '…' : '.'}</span> {san}</button>)}</div>
    <div className="move-navigation"><div className="nav-buttons">{[{ id: 'first', label: 'First position', text: '↤', to: 0 }, { id: 'prev', label: 'Previous position', text: '←', to: ply - 1 }, { id: 'next', label: 'Next position', text: '→', to: ply + 1 }, { id: 'last', label: 'Last position', text: '↦', to: sans.length }].map(item => <button key={item.id} id={`analysis-${item.id}`} aria-label={item.label} disabled={item.to < 0 || item.to > sans.length || item.to === ply} onClick={() => onView(item.to)}>{item.text}</button>)}</div><span id="analysis-index">Position {ply + 1} / {sans.length + 1}</span></div>
    {historical && <button className="return-game" onClick={() => onView(null)}>Return to game</button>}
  </section>;
}

export function SavedGames({ state, dispatch, analysisOnly = false }: { state: State; dispatch: Dispatch<Action>; analysisOnly?: boolean }) {
  const [deleting, setDeleting] = useState<string | null>(null);
  return <section className="saved-panel" aria-label="Saved games">
    {!analysisOnly && <><h1>History</h1><p>Games are saved on this device. Export a PGN to keep a copy elsewhere.</p></>}
    {!state.saved.length && <p className="empty-copy">Your games will appear here.</p>}
    <div id="saved-games">{state.saved.map(game => {
      const result = gameResult(replay(game.moves));
      return <article className="saved-game" key={game.id}><div><time dateTime={game.createdAt}>{new Date(game.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time><h2>{sideName(game.settings.userColor)} · Maia {game.settings.eloMaia}</h2><p>{result}</p></div><div className="actions">{!analysisOnly && result === 'Unfinished' && <button data-game-id={game.id} onClick={() => dispatch({ type: 'saved', id: game.id })}>Resume</button>}<button onClick={() => dispatch({ type: 'review', id: game.id })}>Analyze</button>{!analysisOnly && <><button onClick={() => downloadPgn(exportLine(loadLine('', game.moves.join(' '))), 'maia-game.pgn')}>Export</button><button onClick={() => setDeleting(game.id)}>Delete</button></>}</div></article>;
    })}</div>
    {deleting && <Dialog title="Delete saved game?" onCancel={() => setDeleting(null)}><h2>Delete saved game?</h2><p>This removes the game from this device.</p><div className="actions"><button onClick={() => { dispatch({ type: 'delete', id: deleting }); setDeleting(null); }}>Delete game</button><button onClick={() => setDeleting(null)}>Cancel</button></div></Dialog>}
  </section>;
}
