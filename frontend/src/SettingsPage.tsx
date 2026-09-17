import { Button } from './components';
import type { Props } from './Controls';
import { defaultStockfishSettings } from './stockfishSettings';
import { ARROW_WIDTH_MAX, ARROW_WIDTH_MIN, type ArrowSettingsKey } from './arrowSettings';
import { QualityBadge, type BadgeLoading } from './ReviewCharts';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import './settings.css';
import { useState } from 'react';

function NumberSetting({ id, value, min, max, step, onChange, disabled, label }: { id: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; disabled?: boolean; label: string }) {
  // Uncommitted text lives in draft; null means "show the committed value".
  // No sync effect: while editing, parent updates from our own keystrokes
  // must not overwrite the text (effect versions fight typing); when idle,
  // draft is null so external changes (reset defaults, reload) display
  // directly. Blur discards the draft. Intended: an external change that
  // lands mid-edit (e.g. Reset defaults while focused) appears on blur —
  // editing wins until then.
  const [draft, setDraft] = useState<string | null>(null);
  return <input id={id} type="number" min={min} max={max} step={step} value={draft ?? String(value)} disabled={disabled} aria-label={label}
    onChange={e => {
      setDraft(e.target.value);
      if (e.target.value !== '' && e.target.validity.valid) onChange(e.target.valueAsNumber);
    }} onBlur={() => setDraft(null)} />;
}

export function SettingsPage({ state, dispatch }: Props) {
  const settings = state.stockfish;
  const update = (patch: Partial<typeof settings>) => dispatch({ type: 'stockfish-settings', settings: patch });
  // UI-only mode: time-limited (depth 0) vs depth-targeted (depth > 0 with
  // time as a safety cap). The backend still accepts both limits at once;
  // the toggle only makes the depth-0 sentinel explicit.
  const mode = settings.depth === 0 ? 'time' : 'depth';
  const badgeOptions: { value: BadgeLoading; label: string; hint: string }[] = [
    { value: 'reel', label: 'Slot reel', hint: 'Spins through every verdict' },
    { value: 'shimmer', label: 'Shimmer', hint: 'Calm neutral pulse' },
    { value: 'placeholder', label: 'Original blank', hint: 'Invisible until the verdict lands' },
  ];
  const badgeIndex = Math.max(0, badgeOptions.findIndex(option => option.value === state.badgeLoading));
  const orientationOptions = [
    { value: 'auto' as const, label: 'Auto' },
    { value: 'white' as const, label: 'White' },
    { value: 'black' as const, label: 'Black' },
  ];
  const arrowRows: { key: ArrowSettingsKey; label: string; hint: string }[] = [
    { key: 'actual', label: 'Played move', hint: 'White arrow tracing the game continuation' },
    { key: 'maia', label: 'Maia suggestion', hint: "Maia's top choice from this position" },
    { key: 'stockfish', label: 'Stockfish best', hint: "Stockfish's top choice from this position" },
    { key: 'candidate', label: 'Preview', hint: 'Hover or keyboard preview before exploring' },
  ];
  return <section className="engine-settings panel" aria-labelledby="settings-title">
    <p className="settings-eyebrow">BOARD</p>
    <h2 className="settings-subhead">Display</h2>
    <div className="settings-control">
      <div className="field field--row">
        <span className="field-label" id="board-orientation-label">Board orientation</span>
        <div role="radiogroup" aria-labelledby="board-orientation-label" className="segmented">
          {orientationOptions.map(option => (
            <label key={option.value}>
              <input type="radio" name="board-orientation" value={option.value} checked={state.boardOrientation === option.value} onChange={() => dispatch({ type: 'board-orientation', orientation: option.value })} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </div>
      <p>Auto puts your side at the bottom in play, and the reviewed side (or starting side) at the bottom in analysis. White or Black fixes that side to the bottom.</p>
    </div>
    <div className="settings-control">
      <div className="field field--row">
        <span className="field-label" id="coordinates-style-label">Coordinates</span>
        <div role="radiogroup" aria-labelledby="coordinates-style-label" className="segmented">
          <label>
            <input type="radio" name="coordinates-style" value="squares" checked={state.coordinatesOnSquares} onChange={() => dispatch({ type: 'coordinates-on-squares', enabled: true })} />
            <span>Inside</span>
          </label>
          <label>
            <input type="radio" name="coordinates-style" value="outside" checked={!state.coordinatesOnSquares} onChange={() => dispatch({ type: 'coordinates-on-squares', enabled: false })} />
            <span>Outside</span>
          </label>
        </div>
      </div>
      <p>Inside squares stay aligned at any board size. Outside matches the classic look.</p>
    </div>
    <div className="settings-control">
      <div className="field field--row">
        <span className="field-label" id="arrows-label">Review arrows</span>
        <Button onClick={() => dispatch({ type: 'arrow-settings-reset' })}>Reset arrow defaults</Button>
      </div>
      <p>Color and thickness per arrow. Thickness {ARROW_WIDTH_MIN}–{ARROW_WIDTH_MAX}; {ARROW_WIDTH_MAX} fills a full square.</p>
      {arrowRows.map(row => {
        const style = state.arrows[row.key];
        return <div className="field arrow-row" key={row.key}>
          <span className="field-label" id={`arrow-${row.key}-label`}>{row.label} <span>{row.hint}</span></span>
          <div className="arrow-inputs" role="group" aria-labelledby={`arrow-${row.key}-label`}>
            <input id={`arrow-${row.key}-color`} type="color" value={style.color} onChange={e => dispatch({ type: 'arrow-settings', source: row.key, style: { color: e.target.value } })} aria-label={`${row.label} color`} />
            <input id={`arrow-${row.key}-width`} type="range" min={ARROW_WIDTH_MIN} max={ARROW_WIDTH_MAX} step={1} value={style.width} onChange={e => dispatch({ type: 'arrow-settings', source: row.key, style: { width: e.target.valueAsNumber } })} aria-label={`${row.label} thickness`} />
            <NumberSetting id={`arrow-${row.key}-width-number`} label={`${row.label} thickness value`} min={ARROW_WIDTH_MIN} max={ARROW_WIDTH_MAX} step={1} value={style.width} onChange={width => dispatch({ type: 'arrow-settings', source: row.key, style: { width } })} />
            <output aria-label={`${row.label} thickness as share of a square`}>{Math.round(style.width / ARROW_WIDTH_MAX * 100)}% of a square</output>
          </div>
        </div>;
      })}
    </div>
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
    <div className="settings-control">
      <div className="field field--row">
        <span className="field-label" id="best-line-window-label">Best-line window</span>
        <NumberSetting id="best-line-window" label="Best-line window plies" min={1} max={5} step={1} value={state.bestLineWindow} onChange={window => dispatch({ type: 'best-line-window', window })} />
        <span>plies of the top line</span>
      </div>
      <p>How far down the best line the verdict reads for material and tactics. Longer windows catch slower wins; the line stays clickable.</p>
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
