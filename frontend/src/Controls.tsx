import { useState, type Dispatch } from 'react';
import { exportExplored, exportLine, newId, sideName } from './domain';
import type { Action, State } from './state';
import { Dialog } from './Dialog';
import { Button } from './components';
import { resolveSide } from './randomSide';
import { SavedGames } from './ReadPanels';
import { ErrorBoundary, PanelError } from './ErrorBoundary';
import { Rating, copyText } from './BoardTools';
import { useFlash } from './useFlash';

export type Props = { state: State; dispatch: Dispatch<Action> };
export function PlayControls({ state, dispatch }: Props) {
  if (!state.setup || state.mode !== 'play') return null;
  const content = <section id="play-controls" className="setup panel">
    <h1>{state.started ? 'Start a new game?' : 'Play Maia'}</h1>
    <Rating value={state.setup.eloMaia} onChange={eloMaia => dispatch({ type: 'setup', draft: { eloMaia } })} />
    <fieldset><legend>Your side</legend><div className="side-options">{(['white', 'black', 'random'] as const).map(color => <label key={color}><input type="radio" name="user-color" checked={state.setup!.userColor === color} onChange={() => dispatch({ type: 'setup', draft: { userColor: color } })} />{color === 'random' ? 'Random' : sideName(color)}</label>)}</div></fieldset>
    <details className="advanced-config"><summary>Advanced</summary>
      <label className="field" htmlFor="maia-temperature">Maia temperature <output>{(state.setup.temperature ?? 0).toFixed(1)}</output>
        <input id="maia-temperature" type="range" min="0" max="2" step="0.1" value={state.setup.temperature ?? 0} onChange={e => dispatch({ type: 'setup', draft: { temperature: e.target.valueAsNumber } })} />
      </label>
      <p>0 always chooses Maia’s highest-probability move. 1 samples its original probabilities; higher values add more variety. Applies to this new game.</p>
    </details>
    <label className="feedback-setup" htmlFor="feedback-enabled"><input id="feedback-enabled" type="checkbox" checked={state.feedback} onChange={event => dispatch({ type: 'feedback', enabled: event.target.checked })} /> Evaluate my moves with Stockfish after I play them</label>
    <p>Retrospective only: your move is evaluated after you commit it, never hinted beforehand.</p>
    <div className="actions"><Button id="start-game" variant="primary" onClick={() => dispatch({ type: 'new', id: newId(), createdAt: new Date().toISOString(), resolvedColor: resolveSide(state.setup!.userColor) })}>{state.started ? 'Start new game' : 'Start game'}</Button>{state.started && <Button onClick={() => dispatch({ type: 'cancel-setup' })}>Cancel</Button>}</div>
  </section>;
  return state.started ? <Dialog title="Start a new game?" onCancel={() => dispatch({ type: 'cancel-setup' })}>{content}</Dialog> : content;
}

function ImportForm({ state, dispatch }: Props) {
  const [source, setSource] = useState<'pgn' | 'fen' | 'history' | 'start'>('pgn');
  return <section id="analysis-controls" aria-label="Analyze game or position">
    <div className="source-options" aria-label="Analysis source">{(['history', 'pgn', 'fen', 'start'] as const).map(value => <button key={value} aria-pressed={source === value} onClick={() => setSource(value)}>{({ history: 'History', pgn: 'PGN', fen: 'FEN', start: 'Starting position' })[value]}</button>)}</div>
    {source === 'history' ? <><Button disabled={!state.started} onClick={() => dispatch({ type: 'review' })}>Analyze current game</Button><ErrorBoundary label="saved games" resetKey={JSON.stringify([state.saved.map(game => game.id), state.saved.length])} renderFallback={(error, retry) => <PanelError title="Saved games failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><SavedGames state={state} dispatch={dispatch} analysisOnly /></ErrorBoundary></> : <>
      {source === 'pgn' && <label className="field">Game PGN<textarea id="analysis-pgn" rows={5} spellCheck={false} value={state.inputs.pgn} onChange={event => dispatch({ type: 'inputs', inputs: { pgn: event.target.value } })} placeholder="1. e4 e5 2. Nf3" /></label>}
      {source === 'fen' && <><label className="field">Starting FEN<input id="analysis-fen" spellCheck={false} value={state.inputs.fen} onChange={event => dispatch({ type: 'inputs', inputs: { fen: event.target.value } })} /></label><label className="field">Moves from this position (optional PGN)<textarea id="analysis-pgn" rows={3} value={state.inputs.pgn} onChange={event => dispatch({ type: 'inputs', inputs: { pgn: event.target.value } })} /></label></>}
      <Button id="load-analysis" variant="primary" onClick={() => {
        if (source === 'start') dispatch({ type: 'inputs', inputs: { fen: '', pgn: '' } });
        if (source === 'pgn') dispatch({ type: 'inputs', inputs: { fen: '' } });
        dispatch({ type: 'load' });
      }}>Load {source === 'pgn' ? 'game' : 'position'}</Button>
    </>}
    {state.error && <p role="alert">{state.error}</p>}
  </section>;
}
export function AnalysisControls(props: Props) {
  if (props.state.mode !== 'analysis' || !props.state.importing) return null;
  return <ImportForm {...props} />;
}
export function AnalysisActions({ state, dispatch }: Props) {
  const [copied, flash] = useFlash<'pgn' | 'explored' | 'link'>();
  const copyPgn = (explored: boolean) =>
    void copyText(explored ? exportExplored(state.analysis) : exportLine(state.analysis)).then(ok => {
      if (ok) flash(explored ? 'explored' : 'pgn');
    });
  const copyLink = () =>
    void copyText(window.location.href).then(ok => {
      if (ok) flash('link');
    });
  return <div className="analysis-actions">
    <Button id="new-analysis" variant="quiet" onClick={() => dispatch({ type: 'unload' })}>New analysis</Button>
    <Button id="copy-pgn" variant="quiet" onClick={() => copyPgn(false)}>{copied === 'pgn' ? 'PGN copied' : 'Copy PGN'}</Button>
    <Button id="copy-analysis-link" variant="quiet" onClick={() => copyLink()}>{copied === 'link' ? 'Link copied' : 'Copy link'}</Button>
    {state.analysis.branchFromPly !== null && <Button id="copy-explored-pgn" variant="quiet" onClick={() => copyPgn(true)}>{copied === 'explored' ? 'Explored PGN copied' : 'Copy explored PGN'}</Button>}
  </div>;
}
