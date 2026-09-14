import type { DomainOutcome } from './domain';
import type { Evaluation } from './reviewMetrics';
import { evaluationForOutcome } from './reviewMetrics';
import { stockfishPolicy, type StockfishSettings } from './stockfishSettings';

// Scoring adapter for consumers that still accept the engine evaluation shape.
export function outcomeEvaluation(outcome: DomainOutcome | null, settings?: StockfishSettings): Evaluation | undefined {
  return evaluationForOutcome(outcome, stockfishPolicy(settings));
}
