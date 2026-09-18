import {
  reviewKey,
  type Engine,
  type ReviewNode,
  type ReviewSettings,
} from '../evaluationStore';
import type { ReviewCoordinator, SettingsInput } from '../reviewCoordinator';
import { whiteWin, type Evaluation, type ObjectiveCandidates, type ObjectivePoint } from '../reviewMetrics';

// Objective provider: pure-engine behavior. Every export here twins
// ./maia.ts name-for-name; the rest of the system imports these names
// through ./index (one line flips the source) and never branches on models.
// Points re-derive from the Stockfish rows the hooks already resolve, so
// this source needs no extra fetches anywhere.

// One position's objective point from an evaluation, read from the mover's
// perspective. Terminal outcome rows flow through the same score shapes as
// the rest of the app, so provider output matches the legacy pure-engine
// grades exactly (see the parity test).
export function sfPoint(evaluation: Evaluation | undefined, turn: 'white' | 'black'): ObjectivePoint {
  if (!evaluation) return { top: null, expected: null };
  const expected = turn === 'white' ? whiteWin(evaluation.score) : 100 - whiteWin(evaluation.score);
  return { top: evaluation.best_move, expected };
}

// No extra inference beyond Stockfish: the schedulers add no lane
// (foreground, prime, batch, and coverage all skip on null).
export function laneSettings(): null {
  return null;
}

// Raw provider rows, node-aligned. The hook's own Stockfish evaluations
// (provisional rows keep first paint fast); the coordinator limb is unused
// on this side.
export function laneRows(
  _nodes: ReviewNode[],
  ctx: { coordinator: ReviewCoordinator; sfEvaluations: (Evaluation | undefined)[] },
): (Evaluation | undefined)[] {
  return ctx.sfEvaluations;
}

// Node-aligned objective points.
export function lanePoints(
  rows: (Evaluation | undefined)[],
  nodes: ReviewNode[],
): (ObjectivePoint | undefined)[] {
  return rows.map((evaluation, index) => (evaluation === undefined ? undefined : sfPoint(evaluation, nodes[index].turn)));
}

// Ranked candidate list for the panel: the engine lines with per-line
// mover-relative expectations. Terminal rows carry no lines, so the panel
// falls back to the outcome there — same contract as the Maia twin.
export function candidatesFor(
  row: Evaluation | undefined,
  node: ReviewNode,
): ObjectiveCandidates | undefined {
  if (!row || row.terminal || row.lines.length === 0) return undefined;
  const mover = node.turn;
  return {
    entries: row.lines.map(line => ({
      uci: line.move,
      expected: mover === 'white' ? whiteWin(line.score) : 100 - whiteWin(line.score),
    })),
    degraded: false,
  };
}

// Lane keys are the main Stockfish keys: the objective shares the
// endpoints the grade already waits on, so pending and coverage need no
// separate surface.
export function laneKey(node: ReviewNode, settingsForNode: (node: ReviewNode) => ReviewSettings): string {
  return reviewKey('sf', node, settingsForNode(node));
}

export function lanePending(coordinator: ReviewCoordinator): Set<string> {
  return coordinator.sfPendingKeys();
}

export function laneError(_coordinator: ReviewCoordinator, _node: ReviewNode | undefined): string | undefined {
  return undefined;
}

// Stockfish failures ride the main sweep; nothing extra to retry here.
export function laneFailures(_nodes: ReviewNode[], _coordinator: ReviewCoordinator): ReviewNode[] {
  return [];
}

// No foreground fetch: the visible pair's Stockfish rows already cover it.
export function ensureLane(_coordinator: ReviewCoordinator, _targets: ReviewNode[], _signal: AbortSignal): void {}

// Human name for copy (bar, graphs).
export function sourceLabel(): string {
  return 'Stockfish 19';
}

// Bulk-restore descriptor for the lane. Null settings mean no extra
// inference beyond the main prime: the second prime and batch entries
// stand down, and coverage needs nothing more than the Stockfish rows.
export function primeDescriptor(): { settings: SettingsInput | null; engines: Engine[]; suffix: string } {
  return { settings: null, engines: [], suffix: '|sflane' };
}
