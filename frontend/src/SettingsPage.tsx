import { Button } from './components';
import type { Props } from './Controls';
import { defaultStockfishSettings } from './stockfishSettings';
import './settings.css';
import { useEffect, useState } from 'react';

function NumberSetting({ id, value, min, max, step, onChange }: { id: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <input id={id} type="number" min={min} max={max} step={step} value={draft}
    onChange={e => {
      setDraft(e.target.value);
      if (e.target.value !== '' && e.target.validity.valid) onChange(e.target.valueAsNumber);
    }} onBlur={() => setDraft(String(value))} />;
}

export function SettingsPage({ state, dispatch }: Props) {
  const settings = state.stockfish;
  const update = (patch: Partial<typeof settings>) => dispatch({ type: 'stockfish-settings', settings: patch });
  return <section className="engine-settings panel" aria-labelledby="settings-title">
    <p className="settings-eyebrow">ANALYSIS ENGINE</p>
    <h1 id="settings-title">Stockfish</h1>
    <div className="settings-control">
      <label className="field" htmlFor="stockfish-time">Search time <span>Seconds per position</span>
        <NumberSetting id="stockfish-time" min={0.25} max={30} step={0.25} value={settings.time_ms / 1000} onChange={seconds => update({ time_ms: Math.round(seconds * 1000) })} />
      </label>
      <p>Longer searches can find stronger continuations. Reviewing an entire game applies this budget to every position.</p>
    </div>
    <div className="settings-control">
      <label className="field" htmlFor="stockfish-lines">Candidate lines <output>{settings.lines}</output>
        <input id="stockfish-lines" type="range" min="1" max="5" step="1" value={settings.lines} onChange={e => update({ lines: e.target.valueAsNumber })} />
      </label>
      <p>Compare up to five alternatives. More lines share the available search time.</p>
    </div>
    <div className="settings-control">
      <label className="field" htmlFor="stockfish-depth">Target depth
        <NumberSetting id="stockfish-depth" min={0} max={40} step={1} value={settings.depth} onChange={depth => update({ depth })} />
      </label>
      <p>Depth counts individual moves by either side. Set 0 for no depth target. Search stops at the time limit even if the target has not been reached.</p>
    </div>
    <footer className="settings-footer"><span>Saved automatically in this browser</span><Button onClick={() => update(defaultStockfishSettings)}>Reset defaults</Button></footer>
  </section>;
}
