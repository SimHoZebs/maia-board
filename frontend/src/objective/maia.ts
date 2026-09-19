import type { MoveResponse } from '../api';
import {
  GRADING_MAIA_SETTINGS,
  gradingMaiaKey,
  type Engine,
  type ReviewNode,
  type ReviewSettings,
} from '../evaluationStore';
import type { ReviewCoordinator, SettingsInput } from '../reviewCoordinator';
import { type Evaluation, type ObjectiveCandidates, type ObjectivePoint } from '../reviewMetrics';

// Objective provider: Maia 2400 human-like expectations. Every export here
// has a same-named twin in ./stockfish.ts; the rest of the system imports
// these names through ./index (one line flips the source) and never branches
// on models. Row types differ per module (MoveResponse here); shared shapes
// live in reviewMetrics/qualities.

// One position's objective point. A degraded response still carries an
// expectation (shown, not graded); only a clean top move names the best.
export function maiaPoint(response: Pick<MoveResponse, 'top_moves' | 'wdl' | 'degraded'> | undefined): ObjectivePoint {
  if (!response) return { top: null, expected: null };
  const top = !response.degraded && typeof response.top_moves?.[0]?.move === 'string' ? response.top_moves[0].move : null;
  return { top, expected: maiaExpected(response.wdl) };
}

// Expected score from a mover-relative WDL triple [loss, draw, win]. WDL
// compresses extremes relative to engine win%, so identical cutoffs flag
// fewer moves — that leniency is the point, not a bug.
export function maiaExpected(wdl: MoveResponse['wdl']): number {
  const [loss, draw, win] = wdl;
  return 100 * (win + 0.5 * draw);
}

// Display values for the Maia analysis list: policy share plus winrate delta
// vs the best listed winrate, in percentage points. The best winrate reads
// 0.0%; everything else is <= 0. One decimal keeps sub-point gaps visible
// where integer rounding would collapse them to 0. Rendered as two separate
// columns (prob + delta), never a combined string.
export function formatWinrateDelta(delta: number): string {
  if (Math.abs(delta) < 0.05) return '0.0%';
  const rounded = (Math.sign(delta) * Math.round(Math.abs(delta) * 10) / 10).toFixed(1);
  return delta > 0 ? `+${rounded}%` : `${rounded}%`;
}

export function maiaDisplayParts(topMoves: MoveResponse['top_moves']): { prob: string; delta: string }[] {
  if (topMoves.length === 0) return [];
  const best = Math.max(...topMoves.map(candidate => maiaExpected(candidate.wdl)));
  return topMoves.map(candidate => ({
    prob: `${Math.round(candidate.prob * 100)}%`,
    delta: formatWinrateDelta(maiaExpected(candidate.wdl) - best),
  }));
}

// Raw provider rows, node-aligned. The fixed 2400 identity lives inside
// this module; callers never name it. The Stockfish twin reads the passed
// evaluations instead.
export function laneRows(
  nodes: ReviewNode[],
  ctx: { coordinator: ReviewCoordinator; sfEvaluations: (Evaluation | undefined)[] },
): (MoveResponse | undefined)[] {
  return nodes.map(node => ctx.coordinator.result('maia', node, GRADING_MAIA_SETTINGS));
}

// Node-aligned objective points.
export function lanePoints(
  rows: (MoveResponse | undefined)[],
  _nodes: ReviewNode[],
): (ObjectivePoint | undefined)[] {
  return rows.map(response => (response === undefined ? undefined : maiaPoint(response)));
}

// Ranked candidate list for the panel: the full top_moves with per-choice
// expectations, in policy order. Undefined while the row is missing (Maia
// never infers game-over positions — the panel falls back to the outcome).
// The policy share rides along so the panel can mirror the display columns
// (prob% + winrate delta) instead of absolute values only.
export function candidatesFor(
  row: MoveResponse | undefined,
  _node: ReviewNode,
): ObjectiveCandidates | undefined {
  if (!row) return undefined;
  return {
    entries: row.top_moves.map(candidate => ({ uci: candidate.move, expected: maiaExpected(candidate.wdl), prob: candidate.prob })),
    degraded: row.degraded,
  };
}

export function laneKey(node: ReviewNode, _settingsForNode: (node: ReviewNode) => ReviewSettings): string {
  return gradingMaiaKey(node);
}

export function lanePending(coordinator: ReviewCoordinator): Set<string> {
  return coordinator.maiaPendingKeys();
}

export function laneError(coordinator: ReviewCoordinator, node: ReviewNode | undefined): string | undefined {
  if (!node || node.outcome) return undefined;
  return coordinator.error('maia', node, GRADING_MAIA_SETTINGS);
}

// Nodes whose objective rows failed and need a retry sweep. The main sweep
// owns every other engine; this module owns only its own lane.
export function laneFailures(nodes: ReviewNode[], coordinator: ReviewCoordinator): ReviewNode[] {
  return nodes.filter(node => laneError(coordinator, node) !== undefined);
}

// Foreground fetch for the visible pair. Appends to the shared maia queue
// without wiping queued display jobs (different keys, same lane).
export function ensureLane(coordinator: ReviewCoordinator, targets: ReviewNode[], signal: AbortSignal): void {
  coordinator.ensure(targets, GRADING_MAIA_SETTINGS, { priority: true, engines: ['maia'], signal, append: true });
}

// Human name for copy (bar, graphs). Twins differ here by definition.
export function sourceLabel(): string {
  return 'Maia3 2400';
}

// Pinned Elo shown as a locked dropdown in the panel heading. Null means
// the source has no Elo to show (the heading renders without a dropdown).
export function fixedElo(): number | null {
  return GRADING_MAIA_SETTINGS.eloMaia;
}

// Bulk-restore descriptor for the lane. `settings` null means the source
// needs no extra inference, so the second prime and batch entries stand
// down; callers check presence, never model kind.
export function primeDescriptor(): { settings: SettingsInput | null; engines: Engine[]; suffix: string } {
  return { settings: GRADING_MAIA_SETTINGS, engines: ['maia'], suffix: '|g2400' };
}
