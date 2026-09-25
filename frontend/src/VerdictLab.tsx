import { useMemo, useState, type ReactNode } from 'react';
import { START_FEN } from './domain';
import type { MaiaSide } from './material';
import {
  applyPreset,
  buildLabVerdict,
  DEFAULT_STATE,
  PRESETS,
  type LabState,
  type NoteMode,
  type RarityLaneKnob,
  type ScoreKnob,
} from './verdictLabModel';
import './verdict-lab.css';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="vlab-field">
      <span className="vlab-label">{label}</span>
      {children}
    </label>
  );
}

function ScoreKnobs({ title, value, onChange }: { title: string; value: ScoreKnob; onChange: (next: ScoreKnob) => void }) {
  return (
    <fieldset className="vlab-group">
      <legend>{title}</legend>
      <Field label="type">
        <select value={value.kind} onChange={event => onChange({ ...value, kind: event.target.value as ScoreKnob['kind'] })}>
          <option value="none">none</option>
          <option value="cp">cp</option>
          <option value="mate">mate</option>
        </select>
      </Field>
      {value.kind === 'cp' && (
        <Field label="centipawns">
          <input type="number" step={10} value={value.value} onChange={event => onChange({ ...value, value: Number(event.target.value) })} />
        </Field>
      )}
      {value.kind === 'mate' && (
        <>
          <Field label="moves to mate">
            <input type="number" min={0} value={value.value} onChange={event => onChange({ ...value, value: Number(event.target.value) })} />
          </Field>
          <Field label="mating side">
            <select value={value.winningSide} onChange={event => onChange({ ...value, winningSide: event.target.value as 'white' | 'black' })}>
              <option value="white">white</option>
              <option value="black">black</option>
            </select>
          </Field>
        </>
      )}
    </fieldset>
  );
}

function LaneKnobs({ title, value, onChange }: { title: string; value: RarityLaneKnob; onChange: (next: RarityLaneKnob) => void }) {
  return (
    <fieldset className="vlab-group">
      <legend>{title}</legend>
      <Field label="played share">
        <select value={value.mode} onChange={event => onChange({ ...value, mode: event.target.value as RarityLaneKnob['mode'] })}>
          <option value="top">top move</option>
          <option value="listed">listed</option>
          <option value="unlisted">unlisted</option>
          <option value="unknown">unknown (degraded)</option>
        </select>
      </Field>
      <Field label="top share">
        <input
          type="number" min={0.01} max={1} step={0.01} value={value.topProb} disabled={value.mode === 'unknown'}
          onChange={event => onChange({ ...value, topProb: Number(event.target.value) })}
        />
      </Field>
      <Field label="played share">
        <input
          type="number" min={0} max={1} step={0.005} value={value.prob} disabled={value.mode !== 'listed'}
          onChange={event => onChange({ ...value, prob: Number(event.target.value) })}
        />
      </Field>
    </fieldset>
  );
}

function NoteKnobs({ title, mode, manual, auto, onMode, onManual }: {
  title: string; mode: NoteMode; manual: string; auto: string | null;
  onMode: (mode: NoteMode) => void; onManual: (text: string) => void;
}) {
  return (
    <fieldset className="vlab-group">
      <legend>{title}</legend>
      <Field label="source">
        <select value={mode} onChange={event => onMode(event.target.value as NoteMode)}>
          <option value="auto">auto</option>
          <option value="manual">manual</option>
          <option value="off">off</option>
        </select>
      </Field>
      {mode === 'manual' && (
        <Field label="text">
          <input type="text" value={manual} onChange={event => onManual(event.target.value)} placeholder="Manual note…" />
        </Field>
      )}
      <p className="vlab-derived">auto: {auto ?? '—'}</p>
    </fieldset>
  );
}

export function VerdictLab() {
  const [state, setState] = useState<LabState>(DEFAULT_STATE);
  const set = (patch: Partial<LabState>) => setState(prev => ({ ...prev, ...patch, preset: 'custom' }));
  const result = useMemo(() => buildLabVerdict(state), [state]);
  const { facts, verdict, rules, trace } = result;
  const presetKnown = PRESETS.some(preset => preset.id === state.preset);
  const blurb = PRESETS.find(preset => preset.id === state.preset)?.blurb;

  return (
    <div className="app-shell lab-page vlab">
      <header className="site-header">
        <span className="brand">maia board</span>
        <span className="lab-crumb">dev · verdict lab</span>
      </header>
      <main>
        <h1>Move verdict lab</h1>
        <p className="lab-intro">
          Raw engine numbers in, verdict out — through the real functions, never around them:
          Maia shares → <code>maiaRarity</code>, cp scores + best flag + line gap →{' '}
          <code>reviewMove</code> → <code>effectiveQuality</code> → <code>alienUpgrade</code>,
          then <code>verdictInputsForPly</code> → <code>describeMove</code>. Start positions
          use <code>{START_FEN}</code> unless a preset sets real FENs.
        </p>
        <Field label="preset">
          <select value={presetKnown ? state.preset : 'custom'} onChange={event => setState(applyPreset(state, event.target.value))}>
            {!presetKnown && <option value="custom">Custom (edited)</option>}
            {PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
          </select>
        </Field>
        {blurb && <p className="lab-intro">{blurb}</p>}
        <div className="vlab-grid">
          <div className="vlab-knobs">
            <section className="lab-row" aria-label="Position">
              <h2>Position</h2>
              <div className="vlab-fields">
                <Field label="SAN"><input type="text" value={state.san} onChange={event => set({ san: event.target.value })} /></Field>
                <Field label="played UCI"><input type="text" value={state.playedUci} onChange={event => set({ playedUci: event.target.value })} /></Field>
                <Field label="ply"><input type="number" min={0} value={state.ply} onChange={event => set({ ply: Number(event.target.value) })} /></Field>
                <Field label="mover">
                  <select value={state.mover} onChange={event => set({ mover: event.target.value as MaiaSide })}>
                    <option value="white">white</option>
                    <option value="black">black</option>
                  </select>
                </Field>
                <Field label="best UCI (pawn-note + best rarity)"><input type="text" value={state.bestUci} onChange={event => set({ bestUci: event.target.value })} placeholder="empty = played" /></Field>
                <Field label="after outcome">
                  <select value={state.afterOutcome} onChange={event => set({ afterOutcome: event.target.value as LabState['afterOutcome'] })}>
                    <option value="none">none</option>
                    <option value="checkmate">checkmate</option>
                    <option value="draw">draw</option>
                  </select>
                </Field>
                {state.afterOutcome === 'checkmate' && (
                  <Field label="winner">
                    <select value={state.mateWinner} onChange={event => set({ mateWinner: event.target.value as 'white' | 'black' })}>
                      <option value="white">white</option>
                      <option value="black">black</option>
                    </select>
                  </Field>
                )}
              </div>
              <Field label="before FEN"><input type="text" value={state.beforeFen} onChange={event => set({ beforeFen: event.target.value })} /></Field>
              <Field label="after FEN"><input type="text" value={state.afterFen} onChange={event => set({ afterFen: event.target.value })} /></Field>
              <div className="vlab-fields">
                <ScoreKnobs title="Before score" value={state.beforeScore} onChange={beforeScore => set({ beforeScore })} />
                <ScoreKnobs title="After score" value={state.afterScore} onChange={afterScore => set({ afterScore })} />
              </div>
            </section>

            <section className="lab-row" aria-label="Stockfish grade">
              <h2>Stockfish → grade (real reviewMove)</h2>
              <div className="vlab-fields">
                <label className="vlab-check">
                  <input type="checkbox" checked={state.playedIsBest} onChange={event => set({ playedIsBest: event.target.checked })} />
                  played is engine best
                </label>
                <Field label="rank-1 line cp"><input type="number" step={10} value={state.line1Cp} onChange={event => set({ line1Cp: Number(event.target.value) })} /></Field>
                <Field label="rank-2 line cp">
                  <input type="number" step={10} value={state.line2Cp} disabled={state.singleLine} onChange={event => set({ line2Cp: Number(event.target.value) })} />
                </Field>
                <label className="vlab-check">
                  <input type="checkbox" checked={state.singleLine} onChange={event => set({ singleLine: event.target.checked })} />
                  single line (gap unknown)
                </label>
              </div>
              <p className="vlab-derived">
                grade {trace.engineGrade.label} · loss {trace.engineGrade.loss ?? '—'}
                {' '}· accuracy {trace.engineGrade.accuracy ?? '—'} · legal {trace.legalMoves ?? 'bad FEN'}
                {' '}· gap {trace.sfGap === null ? 'unknown' : trace.sfGap.toFixed(1)}
              </p>
            </section>

            <section className="lab-row" aria-label="Maia rarity">
              <h2>Maia → rarity (real maiaRarity)</h2>
              <div className="vlab-fields">
                <LaneKnobs title="Own Elo lane" value={state.ownLane} onChange={ownLane => set({ ownLane })} />
                <LaneKnobs title="2400 lane" value={state.lane2400} onChange={lane2400 => set({ lane2400 })} />
                <Field label="best reply">
                  <select value={state.bestKind} onChange={event => set({ bestKind: event.target.value as LabState['bestKind'] })}>
                    <option value="same">same as played</option>
                    <option value="tiny">listed at 3% (rare + tiny)</option>
                    <option value="unlisted">unlisted</option>
                  </select>
                </Field>
              </div>
              <p className="vlab-derived">
                own {trace.rarity.label}{trace.rarity.r === null ? '' : ` (r=${trace.rarity.r.toFixed(2)})`}
                {' '}· 2400 {trace.rarity2400.label}{trace.rarity2400.r === null ? '' : ` (r=${trace.rarity2400.r.toFixed(2)})`}
                {' '}· best {trace.bestRarity.label}
                {' '}· tiny {String(trace.tinyOwn)} / {String(trace.tiny2400)}
              </p>
            </section>

            <section className="lab-row" aria-label="Sociology">
              <h2>Book &amp; novelty</h2>
              <div className="vlab-fields">
                <label className="vlab-check">
                  <input type="checkbox" checked={state.inBook} onChange={event => set({ inBook: event.target.checked })} />
                  exact book hit
                </label>
                <Field label="ECO"><input type="text" value={state.bookEco} onChange={event => set({ bookEco: event.target.value })} /></Field>
                <Field label="opening name"><input type="text" value={state.bookName} onChange={event => set({ bookName: event.target.value })} /></Field>
                <label className="vlab-check">
                  <input type="checkbox" checked={state.noveltyOn} onChange={event => set({ noveltyOn: event.target.checked })} />
                  leaves book this ply
                </label>
                <Field label="prior ECO"><input type="text" value={state.noveltyEco} onChange={event => set({ noveltyEco: event.target.value })} /></Field>
                <Field label="prior name"><input type="text" value={state.noveltyName} onChange={event => set({ noveltyName: event.target.value })} /></Field>
              </div>
            </section>

            <section className="lab-row" aria-label="Notes">
              <h2>Notes</h2>
              <Field label="material note (Mistake/Blunder only, empty = off)">
                <input type="text" value={state.materialNote} onChange={event => set({ materialNote: event.target.value })} placeholder="This line wins…" />
              </Field>
              <div className="vlab-fields">
                <NoteKnobs title="Pawn note" mode={state.pawnMode} manual={state.pawnManual} auto={trace.autoPawn}
                  onMode={pawnMode => set({ pawnMode })} onManual={pawnManual => set({ pawnManual })} />
                <NoteKnobs title="Positive why" mode={state.positiveMode} manual={state.positiveManual} auto={trace.autoPositive}
                  onMode={positiveMode => set({ positiveMode })} onManual={positiveManual => set({ positiveManual })} />
                <NoteKnobs title="Pin claim" mode={state.pinMode} manual={state.pinManual} auto={trace.autoPin}
                  onMode={pinMode => set({ pinMode })} onManual={pinManual => set({ pinManual })} />
              </div>
            </section>
          </div>

          <div className="vlab-output">
            <section className="lab-row vlab-sticky" aria-label="Verdict" aria-live="polite">
              <h2>Verdict</h2>
              {verdict
                ? <p className="move-verdict" role="status">{verdict}</p>
                : <p className="vlab-null" role="status">No verdict — badges and charts already carry the grades.</p>}
              <dl className="vlab-trace">
                <div><dt>standalone rule</dt><dd>{rules.standalone ?? '—'}</dd></div>
                <div><dt>note rule</dt><dd>{rules.note ?? '—'}</dd></div>
                <div><dt>engine → display</dt><dd>{trace.engineGrade.label} → {trace.finalQuality?.label ?? '—'}{trace.alienApplied ? ' (alien upgrade)' : ''}</dd></div>
                <div><dt>second pool</dt><dd>{trace.secondPool ?? '—'}</dd></div>
                <div><dt>terminal</dt><dd>{facts.terminal ?? '—'}</dd></div>
                <div><dt>mate pattern</dt><dd>{facts.matePatternName ?? '—'}</dd></div>
                <div><dt>dead draw</dt><dd>{String(facts.deadDraw)}</dd></div>
                <div><dt>underpromotion</dt><dd>{String(facts.underpromotionAvoids)}</dd></div>
                <div><dt>novelty</dt><dd>{facts.novelty ? `Leaves ${facts.novelty.priorName} (${facts.novelty.priorEco}) book` : '—'}</dd></div>
                <div><dt>pawn note</dt><dd>{facts.pawnNote ?? '—'}</dd></div>
                <div><dt>positive note</dt><dd>{facts.positiveNote ?? '—'}</dd></div>
                <div><dt>pin claim</dt><dd>{facts.pinClaim ?? '—'}</dd></div>
              </dl>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
