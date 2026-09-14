import type { DomainOutcome } from './domain';
import type { Evaluation } from './reviewMetrics';
import { stockfishPolicy, type StockfishSettings } from './stockfishSettings';

// Scoring adapter for consumers that still accept the engine evaluation shape.
export function outcomeEvaluation(outcome: DomainOutcome | null, settings?: StockfishSettings): Evaluation | undefined {
  if (!outcome) return;
  const winner = outcome.kind === 'checkmate' ? outcome.winner : null;
  return { engine: 'Stockfish 19', search_policy: stockfishPolicy(settings), depth: 0,
    terminal: winner ? `${winner}_win` : 'draw', best_move: null, lines: [],
    score: winner ? { type: 'mate', value: 0, winning_side: winner } : { type: 'cp', value: 0 } };
}
