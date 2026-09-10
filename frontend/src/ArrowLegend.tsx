import type { ArrowSource, ArrowToggles } from './reviewArrows';
const names = { actual: 'played-move', maia: 'Maia', stockfish: 'Stockfish' } as const;
export function ArrowLegend({ toggles, onToggle }: { toggles: ArrowToggles; onToggle: (source: ArrowSource) => void }) {
  return <div className="arrow-toggles" role="group" aria-label="Analysis arrows">{(['actual', 'maia', 'stockfish'] as const).map(source => <button key={source} aria-pressed={toggles[source]} aria-label={`Toggle ${names[source]} arrow`} title={`Toggle ${names[source]} arrow`} onClick={() => onToggle(source)}><i className={`arrow-swatch arrow-${source}`} aria-hidden="true" /></button>)}</div>;
}
