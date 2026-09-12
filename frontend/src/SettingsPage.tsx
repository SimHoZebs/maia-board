import { Button } from './components';
import type { Props } from './Controls';
import { defaultStockfishSettings } from './stockfishSettings';
import { QualityBadge, type BadgeLoading } from './ReviewCharts';
import { ChevronLeft, ChevronRight } from 'lucide-react';
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
  const badgeOptions = [
    { value: 'reel', label: 'Slot reel', hint: 'Spins through every verdict' },
    { value: 'shimmer', label: 'Shimmer', hint: 'Calm neutral pulse' },
    { value: 'placeholder', label: 'Original blank', hint: 'Invisible until the verdict lands' },
  ] as { value: BadgeLoading; label: string; hint: string }[];
  const badgeIndex = Math.max(0, badgeOptions.findIndex(option => option.value === state.badgeLoading));
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
    <p className="settings-eyebrow">EXPERIMENTAL</p>
    <h2 className="settings-subhead">Interface experiments</h2>
    <div className="settings-control">
      <span className="field" id="badge-loading-label">Pending evaluation badges <span>How move badges look while Stockfish is thinking</span></span>
      <div className="badge-carousel" role="group" aria-labelledby="badge-loading-label">
        <button type="button" className="badge-nav" disabled={badgeIndex === 0} onClick={() => dispatch({ type: 'badge-loading', loading: badgeOptions[badgeIndex - 1].value })} aria-label={`Show ${badgeOptions[Math.max(0, badgeIndex - 1)].label}`}><ChevronLeft size={18} aria-hidden="true" /></button>
        <div className="badge-viewport">
          <div className="badge-track" style={{ transform: `translateX(-${badgeIndex * 100}%)` }}>
            {badgeOptions.map((option, index) => (
              <div key={option.value} className="badge-slide" aria-hidden={index !== badgeIndex}>
                <span className="move-cell"><span>1.</span> e4 <QualityBadge quality={{ label: 'Unreviewed', accuracy: null, loss: null }} reserveSpace loading={option.value} /></span>
                <strong>{option.label}</strong>
                <span>{option.hint}</span>
              </div>
            ))}
          </div>
        </div>
        <button type="button" className="badge-nav" disabled={badgeIndex === badgeOptions.length - 1} onClick={() => dispatch({ type: 'badge-loading', loading: badgeOptions[badgeIndex + 1].value })} aria-label={`Show ${badgeOptions[Math.min(badgeOptions.length - 1, badgeIndex + 1)].label}`}><ChevronRight size={18} aria-hidden="true" /></button>
      </div>
      <div className="badge-dots">
        {badgeOptions.map((option, index) => (
          <button key={option.value} type="button" onClick={() => dispatch({ type: 'badge-loading', loading: option.value })} aria-label={`Choose ${option.label}`} aria-current={index === badgeIndex ? 'true' : undefined}><i aria-hidden="true" /></button>
        ))}
      </div>
    </div>
  </section>;
}
