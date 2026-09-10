import type { Dispatch } from 'react';
import { exportLine, newId, oppositeColor, sideName, type Settings } from './domain';
import type { Action, State } from './state';

type Props = { state: State; dispatch: Dispatch<Action> };
const ratings = [800, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2400];

export function PlayControls({ state, dispatch }: Props) {
  const { settings } = state;
  const update = (settings: Partial<Settings>) => dispatch({ type: 'settings', settings, id: newId(), createdAt: new Date().toISOString() });
  return <section className="panel play-controls" id="play-controls" aria-labelledby="play-settings-title" hidden={state.mode !== 'play'}>
    <div className="panel-heading"><div><p className="eyebrow">Your table</p><h2 id="play-settings-title">Game settings</h2></div><span className="saved-mark" title="Settings are saved on this device" aria-label="Settings saved">local</span></div>
    <fieldset className="field-group"><legend>I play</legend><div className="segmented two-up">
      {(['white', 'black'] as const).map(color => <label className="segment-option" key={color}><input type="radio" name="user-color" value={color} checked={settings.userColor === color} onChange={() => update({ userColor: color })} /><span>{sideName(color)}</span></label>)}
    </div><p className="field-note">Maia plays <strong id="maia-color-label">{sideName(oppositeColor(settings.userColor))}</strong>.</p></fieldset>
    <div className="field-grid">{(['eloMaia', 'eloUser'] as const).map(key => <label className="field-group" key={key}>
      <span className="field-label">{key === 'eloMaia' ? 'Maia Elo' : 'Your Elo'}</span>
      <select id={key === 'eloMaia' ? 'elo-maia' : 'elo-user'} aria-label={key === 'eloMaia' ? 'Maia Elo' : 'Your Elo'} value={settings[key]} onChange={event => update({ [key]: Number(event.target.value) })}>
        {[...new Set([...ratings, settings[key]])].sort((a, b) => a - b).map(elo => <option key={elo} value={elo}>{elo}</option>)}
      </select>
    </label>)}</div>
    <fieldset className="field-group"><legend>Model</legend><div className="model-options">
      {(['79m', '5m'] as const).map(model => <label className="model-option" key={model}><input type="radio" name="model" value={model} checked={settings.model === model} onChange={() => update({ model })} /><span className="model-copy"><strong>{model.toUpperCase()}</strong><small>{model === '79m' ? 'full human prior' : 'quick response'}</small></span></label>)}
    </div></fieldset>
    <div className="action-row"><button className="button button-primary" id="new-game" onClick={() => dispatch({ type: 'new', id: newId(), createdAt: new Date().toISOString() })}>New game</button><button className="button button-secondary" id="takeback" disabled={!state.play.moves.length} onClick={() => dispatch({ type: 'takeback' })}>Takeback</button></div>
  </section>;
}

export function AnalysisControls({ state, dispatch }: Props) {
  const { analysis, inputs } = state;
  const download = () => {
    const url = URL.createObjectURL(new Blob([exportLine(analysis)], { type: 'application/x-chess-pgn' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'maia-analysis.pgn';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <section className="panel analysis-controls" id="analysis-controls" aria-labelledby="analysis-settings-title" hidden={state.mode !== 'analysis'}>
    <div className="panel-heading"><div><p className="eyebrow">Position lab</p><h2 id="analysis-settings-title">Load a line</h2></div><span className="saved-mark">local</span></div>
    <label className="field-group"><span className="field-label">FEN <span className="quiet">(optional = start)</span></span><input className="text-input mono" id="analysis-fen" type="text" spellCheck={false} autoComplete="off" placeholder="Starting position" value={inputs.fen} onChange={event => dispatch({ type: 'inputs', inputs: { fen: event.target.value } })} /></label>
    <label className="field-group"><span className="field-label">PGN <span className="quiet">(optional)</span></span><textarea className="text-input pgn-input mono" id="analysis-pgn" rows={5} spellCheck={false} placeholder="1. e4 e5 2. Nf3 ..." value={inputs.pgn} onChange={event => dispatch({ type: 'inputs', inputs: { pgn: event.target.value } })} /></label>
    <button className="button button-primary wide-button" id="load-analysis" onClick={() => dispatch({ type: 'load' })}>Load position</button>
    <button className="button button-accent wide-button" id="analyze-position" disabled={!!state.request} onClick={() => dispatch({ type: 'analyze' })}>Ask Maia about this position</button>
    <div className="analysis-nav"><button className="icon-button" id="analysis-prev" aria-label="Previous position" disabled={analysis.index === 0} onClick={() => dispatch({ type: 'step', delta: -1 })}>&lt;</button><span id="analysis-index">Position {analysis.index + 1} / {analysis.timeline.length}</span><button className="icon-button" id="analysis-next" aria-label="Next position" disabled={analysis.index === analysis.timeline.length - 1} onClick={() => dispatch({ type: 'step', delta: 1 })}>&gt;</button></div>
    <button className="button button-secondary wide-button" id="export-pgn" disabled={!analysis.moves.length} onClick={download}>Export PGN</button>
  </section>;
}
