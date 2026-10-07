import { useState, type Dispatch } from 'react';
import { ChessKing, Dices } from 'lucide-react';
import { exportExplored, exportLine, newId, sideName } from './domain';
import type { Action, State } from './state/index';
import { Dialog } from './Dialog';
import { Button } from './components';
import { resolveSide } from './randomSide';
import { SavedGames } from './ReadPanels';
import { ErrorBoundary, PanelError } from './ErrorBoundary';
import { Rating, copyText } from './BoardTools';
import { computeUserElo, loadUserEloAnchor } from './userElo';
import { useFlash } from './useFlash';

export type Props = { state: State; dispatch: Dispatch<Action> };

function strengthLabel(elo: number): string {
  if (elo < 1100) return 'Learning';
  if (elo < 1500) return 'Casual';
  if (elo < 1800) return 'Club';
  if (elo < 2100) return 'Strong';
  return 'Elite';
}

function temperatureLabel(temperature: number): string {
  if (temperature <= 0) return 'Deterministic';
  if (temperature <= 0.7) return 'Focused';
  if (temperature <= 1.2) return 'Balanced';
  if (temperature <= 1.7) return 'Creative';
  return 'Wild';
}

export function PlayControls({ state, dispatch }: Props) {
  if (!state.setup || state.mode !== 'play') return null;
  const setup = state.setup;
  const temperature = setup.temperature ?? 0;
  const userElo = computeUserElo(loadUserEloAnchor(), state.saved);
  const content = <section id="play-controls" className="setup panel play-setup" aria-label="Game setup">
    {state.started && <h1>Start a new game?</h1>}
    <section className="setup-section" aria-labelledby="opponent-heading">
      <div className="section-head">
        <h2 id="opponent-heading">Bot</h2>
        <span className="section-desc">Plays like a {strengthLabel(setup.botElo).toLowerCase()} human</span>
      </div>
      <div className="bot-row">
        <Rating value={setup.botElo} label="Elo" onChange={botElo => dispatch({ type: 'setup', draft: { botElo } })} />
        <div className="temp-block">
          <h3 className="temp-subhead">Temperature <span className="temp-pill">{temperatureLabel(temperature)} · {temperature.toFixed(1)}</span> <span className="temp-desc">Higher adds variety</span></h3>
          <label className="field temp-field" htmlFor="bot-temperature"><span className="visually-hidden">Bot temperature</span>
            <input id="bot-temperature" type="range" min="0" max="2" step="0.1" value={temperature} onChange={e => dispatch({ type: 'setup', draft: { temperature: e.target.valueAsNumber } })} />
            <span className="temp-scale" aria-hidden="true"><span>Deterministic</span><span>Balanced</span><span>Creative</span></span>
          </label>
        </div>
      </div>
    </section>
    <section className="setup-section" aria-labelledby="side-heading">
      <h2 id="side-heading">Your side</h2>
      <div className="side-options side-segmented" role="radiogroup" aria-labelledby="side-heading">{(['white', 'black', 'random'] as const).map(color => <label key={color} data-active={setup.userColor === color}><input type="radio" name="user-color" checked={setup.userColor === color} onChange={() => dispatch({ type: 'setup', draft: { userColor: color } })} />{color === 'random' ? <Dices size={18} aria-hidden="true" className="side-icon" /> : <ChessKing size={18} aria-hidden="true" className={`side-icon side-icon-${color}`} />}<span>{color === 'random' ? 'Random' : sideName(color)}</span></label>)}</div>
      {setup.userColor === 'random' && <p className="hint">A coin flip decides your color when the game starts.</p>}
    </section>
    <section className="setup-section" aria-labelledby="coaching-heading">
      <h2 id="coaching-heading">Coaching</h2>
      <label className="toggle-card" htmlFor="feedback-enabled"><input id="feedback-enabled" type="checkbox" checked={state.feedback} onChange={event => dispatch({ type: 'feedback', enabled: event.target.checked })} /><span><strong>Evaluate my moves</strong><em>Grades each move after you commit it from Stockfish evals plus Bot's expectations — never hinted beforehand.</em></span></label>
      <label className="toggle-card" htmlFor="verdict-enabled"><input id="verdict-enabled" type="checkbox" checked={state.playVerdict} onChange={event => dispatch({ type: 'play-verdict', enabled: event.target.checked })} /><span><strong>Show move verdict</strong><em>One-line verdict under the move list once graded. Needs evaluation above.</em></span></label>
    </section>
    <div className="actions setup-actions"><Button id="start-game" variant="primary" onClick={() => dispatch({ type: 'new', id: newId(), createdAt: new Date().toISOString(), resolvedColor: resolveSide(setup.userColor), userElo: userElo.rating })}>{state.started ? 'Start new game' : 'Start game'}</Button>{state.started && <Button onClick={() => dispatch({ type: 'cancel-setup' })}>Cancel</Button>}</div>
    <p className="hint">Your rating: {userElo.rating}{userElo.counted ? ` · ${userElo.counted} rated game${userElo.counted === 1 ? '' : 's'} since baseline` : ' · unrated baseline'}.</p>
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
