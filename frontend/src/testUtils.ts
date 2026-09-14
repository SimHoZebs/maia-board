import { buildTimeline } from './domain';
import { reviewNodes } from './evaluationStore';

// Test-only timeline helper. Lives here (not in domain.ts) so production
// bundles never ship fixture builders.
export function testNodes(initialFen: string, moves: string[]) {
  return reviewNodes(buildTimeline(initialFen, moves));
}
