import { buildTimeline } from './domain';
import { reviewNodes } from './evaluationStore';
import { isRecord } from './guards';

// Test-only timeline helper. Lives here (not in domain.ts) so production
// bundles never ship fixture builders.
export function testNodes(initialFen: string, moves: string[]) {
  return reviewNodes(buildTimeline(initialFen, moves));
}

// Read a mocked fetch init's JSON body. Mock inits are loosely typed, so
// assert the shape loudly instead of casting: a changed call shape fails the
// test at this line rather than deep inside JSON.parse.
export function requestBodyText(init: unknown): string {
  if (!isRecord(init) || typeof init.body !== 'string') throw new Error('expected a fetch init with a string body');
  return init.body;
}

// A real Response whose JSON body never arrives, for abort/timeout paths.
// No partial-response cast: the hanging stream simply never closes.
export function hangingResponse(): Response {
  return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'application/json' } });
}
