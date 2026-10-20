import type { DomainOutcome } from '../shared/domain';
import type { Evaluation } from './reviewMetrics';
import { evaluationForOutcome } from './reviewMetrics';
import { stockfishPolicy, type StockfishSettings } from '../eval/stockfishSettings';

// Scoring adapter for consumers that still accept the engine evaluation shape.
// Null means non-terminal (nothing to synthesize) — never `undefined`.
export function outcomeEvaluation(
  outcome: DomainOutcome | null,
  settings?: StockfishSettings,
): Evaluation | null {
  return evaluationForOutcome(outcome, stockfishPolicy(settings));
}
