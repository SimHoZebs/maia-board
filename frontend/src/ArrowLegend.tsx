import { candidateSan } from './domain';
import type { ArrowSource, ArrowToggles } from './reviewArrows';
export function ArrowLegend({ fen, moves, toggles, onToggle }: { fen: string; moves: Record<ArrowSource, string | null | undefined>; toggles: ArrowToggles; onToggle: (source: ArrowSource) => void }) {
  return <section className="arrow-legend" aria-label="Analysis arrows"><h3>Position arrows</h3>{(['actual', 'maia', 'stockfish'] as const).map(source => <button key={source} aria-pressed={toggles[source]} onClick={() => onToggle(source)} title={`Toggle ${source} arrow`}><i className={`arrow-swatch arrow-${source}`} /><span>{({ actual: 'White · Next played', maia: 'Red · Maia top', stockfish: 'Blue · Stockfish best' })[source]}</span><strong>{moves[source] ? candidateSan(fen, moves[source]!) : '—'}</strong></button>)}<p>Translucent arrows show the next move from this position. White is widest, red medium, blue narrow so agreeing moves remain visible.</p></section>;
}
