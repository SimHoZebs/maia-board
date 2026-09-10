import type { Dispatch } from 'react';
import { candidateSan, sideName } from './domain';
import type { Action, State } from './state';

export function InsightPanel({ state }: { state: State }) {
  const { insight, request, settings } = state;
  const response = insight?.response;
  return <section className="panel insight-panel" aria-labelledby="insight-title">
    <div className="panel-heading insight-heading"><div><p className="eyebrow" id="insight-eyebrow">Maia's read</p><h2 id="insight-title">{insight ? insight.mode === 'play' ? `Played ${candidateSan(insight.fen, insight.response.move)}` : 'Top human moves' : request ? 'Reading the position' : 'Waiting for a position'}</h2></div><span className="model-badge" id="model-badge">{response ? `${response.model_used}${response.degraded ? ' / fallback' : ''}` : request ? settings.model : '--'}</span></div>
    <div id="insight-content" className="insight-content">{response && insight ? <>
      <div className="read-label">Policy candidates</div><ol className="candidate-list">{response.top_moves.slice(0, 5).map((candidate, index) => <li key={`${index}-${candidate.move}`}><span className="rank">{String(index + 1).padStart(2, '0')}</span><span className="candidate-move">{candidateSan(insight.fen, candidate.move)}<small>{candidate.move}</small></span><span className="candidate-prob">{Math.round(candidate.prob * 100)}%</span></li>)}{!response.top_moves.length && <li className="empty-copy">No alternatives returned.</li>}</ol>
      <div className="read-divider" /><div className="read-label">After Maia's first choice <span>W / D / L</span></div><div className="wdl-list">{['loss', 'draw', 'win'].map((label, index) => {
        const percent = Math.round(Math.max(0, Math.min(1, response.wdl[index])) * 100);
        return <div className="wdl-row" key={label}><span>{label}</span><div className="wdl-track"><span className={`wdl-fill wdl-${label}`} style={{ width: `${percent}%` }} /></div><strong>{percent}%</strong></div>;
      })}</div>{response.degraded && <p className="degraded-note">79M was unavailable. This answer came from the 5M fallback.</p>}
    </> : <p className="empty-copy">{request ? "The response will include Maia's top five and its win/draw/loss read." : "Make a move or load a position. Maia's top five and its win/draw/loss read will land here."}</p>}</div>
  </section>;
}

export function MovesPanel({ sans, activeIndex }: { sans: string[]; activeIndex: number }) {
  return <section className="panel moves-panel" aria-labelledby="moves-title"><div className="panel-heading compact-heading"><h2 id="moves-title">Moves</h2><span className="move-count" id="move-count">{sans.length} {sans.length === 1 ? 'ply' : 'plies'}</span></div><div className="move-list" id="move-list" aria-live="polite">
    {!sans.length && <p className="empty-copy">The line is empty.</p>}
    {sans.filter((_, index) => index % 2 === 0).map((_, row) => <div className="move-row" key={row}><span className="move-number">{row + 1}.</span>{[row * 2, row * 2 + 1].map(index => <span key={index} className={`move-cell${activeIndex === index ? ' is-current' : ''}${sans[index] ? '' : ' empty-cell'}`}>{sans[index] ?? '-'}</span>)}</div>)}
  </div></section>;
}

export function SavedGames({ state, dispatch }: { state: State; dispatch: Dispatch<Action> }) {
  return <section className="panel saved-panel" aria-labelledby="saved-title"><div className="panel-heading compact-heading"><h2 id="saved-title">Saved locally</h2><span className="quiet">this device</span></div><div id="saved-games" className="saved-games">
    {!state.saved.length && <p className="empty-copy">Finished or in-progress games appear here.</p>}
    {state.saved.map(game => <button className="saved-game" type="button" data-game-id={game.id} key={game.id} onClick={() => dispatch({ type: 'saved', id: game.id })}><span><strong>{sideName(game.settings.userColor)} - {game.settings.model}</strong><small>{new Date(game.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - {game.moves.length} plies</small></span><span aria-hidden="true">&gt;</span></button>)}
  </div></section>;
}
