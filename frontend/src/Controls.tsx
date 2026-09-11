import { useEffect, useRef, useState, type Dispatch } from 'react';
import { exportExplored, exportLine, newId, sideName } from './domain';
import type { Action, State } from './state';
import { Dialog } from './Dialog';
import { Button } from './components';
import { resolveSide } from './randomSide';
import { SavedGames } from './ReadPanels';
import { Rating, downloadPgn } from './BoardTools';

export type Props = { state: State; dispatch: Dispatch<Action> };
export function PlayControls({ state, dispatch }: Props) {
  if (!state.setup || state.mode !== 'play') return null;
  const content = <section id="play-controls" className="setup panel">
    <h1>{state.started ? 'Start a new game?' : 'Play Maia'}</h1>
    <Rating value={state.setup.eloMaia} onChange={eloMaia => dispatch({ type: 'setup', draft: { eloMaia } })} />
    <fieldset><legend>Your side</legend><div className="side-options">{(['white', 'black', 'random'] as const).map(color => <label key={color}><input type="radio" name="user-color" checked={state.setup!.userColor === color} onChange={() => dispatch({ type: 'setup', draft: { userColor: color } })} />{color === 'random' ? 'Random' : sideName(color)}</label>)}</div></fieldset>
    <div className="actions"><Button id="start-game" variant="primary" onClick={() => dispatch({ type: 'new', id: newId(), createdAt: new Date().toISOString(), resolvedColor: resolveSide(state.setup!.userColor) })}>{state.started ? 'Start new game' : 'Start game'}</Button>{state.started && <Button onClick={() => dispatch({ type: 'cancel-setup' })}>Cancel</Button>}</div>
  </section>;
  return state.started ? <Dialog title="Start a new game?" onCancel={() => dispatch({ type: 'cancel-setup' })}>{content}</Dialog> : content;
}

function ImportForm({ state, dispatch }: Props) {
  const [source, setSource] = useState<'pgn' | 'fen' | 'history' | 'start'>('pgn');
  return <section className="panel import-panel" id="analysis-controls">
    <h1>Analyze a game or position</h1>
    <div className="source-options" aria-label="Analysis source">{(['history', 'pgn', 'fen', 'start'] as const).map(value => <button key={value} aria-pressed={source === value} onClick={() => setSource(value)}>{({ history: 'History', pgn: 'PGN', fen: 'FEN', start: 'Starting position' })[value]}</button>)}</div>
    {source === 'history' ? <><Button disabled={!state.started} onClick={() => dispatch({ type: 'review' })}>Analyze current game</Button><SavedGames state={state} dispatch={dispatch} analysisOnly /></> : <>
      {source === 'pgn' && <label className="field">Game PGN<textarea id="analysis-pgn" rows={5} spellCheck={false} value={state.inputs.pgn} onChange={event => dispatch({ type: 'inputs', inputs: { pgn: event.target.value } })} placeholder="1. e4 e5 2. Nf3" /></label>}
      {source === 'fen' && <><label className="field">Starting FEN<input id="analysis-fen" spellCheck={false} value={state.inputs.fen} onChange={event => dispatch({ type: 'inputs', inputs: { fen: event.target.value } })} /></label><label className="field">Moves from this position (optional PGN)<textarea id="analysis-pgn" rows={3} value={state.inputs.pgn} onChange={event => dispatch({ type: 'inputs', inputs: { pgn: event.target.value } })} /></label></>}
      <Button id="load-analysis" variant="primary" onClick={() => {
        if (source === 'start') dispatch({ type: 'inputs', inputs: { fen: '', pgn: '' } });
        if (source === 'pgn') dispatch({ type: 'inputs', inputs: { fen: '' } });
        dispatch({ type: 'load' });
      }}>Load {source === 'pgn' ? 'game' : 'position'}</Button>
    </>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.analysisLoaded && <Button onClick={() => dispatch({ type: 'import', open: false })}>Cancel</Button>}
  </section>;
}
export function AnalysisControls(props: Props) {
  if (props.state.mode !== 'analysis' || !props.state.importing) return null;
  return props.state.analysisLoaded ? <Dialog title="Change game" onCancel={() => props.dispatch({ type: 'import', open: false })}><ImportForm {...props} /></Dialog> : <ImportForm {...props} />;
}
export function AnalysisActions({ state, dispatch }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
    } catch {
      // execCommand is deprecated but remains the fallback for insecure LAN
      // origins where the async clipboard is unavailable.
      const field = document.createElement('textarea');
      try {
        field.value = window.location.href;
        document.body.appendChild(field);
        field.select();
        document.execCommand('copy');
      } finally {
        field.remove();
      }
    }
    setCopied(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };
  return <div className="analysis-actions">
    <Button id="export-pgn" variant="quiet" onClick={() => downloadPgn(exportLine(state.analysis), 'maia-analysis.pgn')}>Export original PGN</Button>
    <Button id="copy-analysis-link" variant="quiet" onClick={() => void copyLink()}>{copied ? 'Link copied' : 'Copy link'}</Button>
    {state.analysis.branchFromPly !== null && <Button id="export-explored" variant="quiet" onClick={() => downloadPgn(exportExplored(state.analysis), 'maia-explored.pgn')}>Export explored PGN</Button>}
  </div>;
}
