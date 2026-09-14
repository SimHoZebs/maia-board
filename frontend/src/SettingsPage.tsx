import { Button } from './components';
import type { Props } from './Controls';
import { defaultStockfishSettings } from './stockfishSettings';
import { QualityBadge, type BadgeLoading } from './ReviewCharts';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './settings.css';
import { useEffect, useState } from 'react';

function NumberSetting({ id, value, min, max, step, onChange, disabled, label }: { id: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; disabled?: boolean; label: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <input id={id} type="number" min={min} max={max} step={step} value={draft} disabled={disabled} aria-label={label}
    onChange={e => {
      setDraft(e.target.value);
      if (e.target.value !== '' && e.target.validity.valid) onChange(e.target.valueAsNumber);
    }} onBlur={() => setDraft(String(value))} />;
}

export function SettingsPage({ state, dispatch }: Props) {
  const settings = state.stockfish;
  const update = (patch: Partial<typeof settings>) => dispatch({ type: 'stockfish-settings', settings: patch });
  // UI-only mode: time-limited (depth 0) vs depth-targeted (depth > 0 with
  // time as a safety cap). The backend still accepts both limits at once;
  // the toggle only makes the depth-0 sentinel explicit.
  const mode = settings.depth === 0 ? 'time' : 'depth';
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
      <span className="field" id="stockfish-limit-label">Search limit</span>
      <div role="radiogroup" aria-labelledby="stockfish-limit-label" className="settings-limit-rows">
        <div className="settings-limit-row">
          <input id="stockfish-limit-time" type="radio" name="stockfish-limit" checked={mode === 'time'} onChange={() => update({ depth: 0 })} aria-label="Stop after time" />
          <span>Stop after</span>
          <NumberSetting id="stockfish-time" label="Seconds per position" min={0.25} max={30} step={0.25} value={settings.time_ms / 1000} onChange={seconds => update({ time_ms: Math.round(seconds * 1000) })} />
          <span>seconds per position</span>
        </div>
        <div className="settings-limit-row">
          <input id="stockfish-limit-depth" type="radio" name="stockfish-limit" checked={mode === 'depth'} onChange={() => update({ depth: settings.depth > 0 ? settings.depth : 18 })} aria-label="Reach depth" />
          <span>Reach</span>
          <NumberSetting id="stockfish-depth" label="Target depth" min={0} max={40} step={1} value={settings.depth} onChange={depth => update({ depth })} />
          <span>depth, max</span>
          <NumberSetting id="stockfish-time-cap" label="Max seconds per position" min={0.25} max={30} step={0.25} value={settings.time_ms / 1000} onChange={seconds => update({ time_ms: Math.round(seconds * 1000) })} />
          <span>seconds per position</span>
        </div>
      </div>
    </div>
    <div className="settings-control">
      <div className="field field--row">
        <span className="field-label" id="stockfish-lines-label">Candidate lines</span>
        <div role="radiogroup" aria-labelledby="stockfish-lines-label" className="segmented">
          {[1, 2, 3, 4, 5].map(n => (
            <label key={n}>
              <input type="radio" name="stockfish-lines" value={n} checked={settings.lines === n} onChange={() => update({ lines: n })} />
              <span>{n}</span>
            </label>
          ))}
        </div>
      </div>
      <p>Compare up to five alternatives. More lines share the available search time.</p>
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
    <div className="settings-control">
      <label className="settings-check" htmlFor="bottom-nav"><input id="bottom-nav" type="checkbox" checked={state.bottomNav} onChange={event => dispatch({ type: 'bottom-nav', enabled: event.target.checked })} /> Bottom navigation</label>
      <p>On phones, pin the move list and navigation to the bottom of the screen with a menu button for the pages on the left, move the board tools above the board, and grow explored branches upward. On by default.</p>
    </div>
  </section>;
}
