import type { MoveResponse } from '../api';
import {
  GRADING_BOT_SETTINGS,
  gradingBotKey,
  type Engine,
  type ReviewNode,
  type ReviewSettings,
} from '../evaluationStore';
import type { ReviewCoordinator, SettingsInput } from '../reviewCoordinator';
import { type Evaluation, type ObjectiveCandidates, type ObjectivePoint } from '../reviewMetrics';
import { botExpected, botPoint, botWhiteWdl } from './winrate';

// Grader role: objective grading (best + expected per position), currently
// implemented by bot-2400 human-like expectations. Callers import the role
// through ./index and never name the model; the dormant alternate
// implementation lives in ./graderStockfish. Row types differ per
// implementation (MoveResponse here); shared shapes live in
// reviewMetrics/qualities. WDL math lives in ./winrate.

// Raw provider rows, node-aligned. The fixed 2400 identity lives inside
// this module; callers never name it.
export function laneRows(
  nodes: ReviewNode[],
  ctx: { coordinator: ReviewCoordinator; sfEvaluations: (Evaluation | undefined)[] },
): (MoveResponse | undefined)[] {
  return nodes.map(node => ctx.coordinator.result('maia', node, GRADING_BOT_SETTINGS));
}

// Node-aligned objective points. The white-relative WDL rides along for the
// eval bar (three segments + percentages); grading still reads only
// top/expected.
export function lanePoints(
  rows: (MoveResponse | undefined)[],
  nodes: ReviewNode[],
): (ObjectivePoint | undefined)[] {
  return rows.map((response, index) => {
    if (response === undefined) return undefined;
    const point = botPoint(response);
    return { ...point, wdl: botWhiteWdl(response.wdl, nodes[index].turn) };
  });
}

// Ranked candidate list for the panel: the full top_moves with per-choice
// expectations, in policy order. Undefined while the row is missing (the bot
// never infers game-over positions — the panel falls back to the outcome).
// The policy share rides along so the panel can mirror the display columns
// (prob% + winrate delta) instead of absolute values only.
export function candidatesFor(
  row: MoveResponse | undefined,
  _node: ReviewNode,
): ObjectiveCandidates | undefined {
  if (!row) return undefined;
  return {
    entries: row.top_moves.map(candidate => ({ uci: candidate.move, expected: botExpected(candidate.wdl), prob: candidate.prob, delta: candidate.delta ?? null })),
    degraded: row.degraded,
    baseline: row.delta_baseline ?? null,
  };
}

export function laneKey(node: ReviewNode, _settingsForNode: (node: ReviewNode) => ReviewSettings): string {
  return gradingBotKey(node);
}

export function lanePending(coordinator: ReviewCoordinator): Set<string> {
  return coordinator.botPendingKeys();
}

export function laneError(coordinator: ReviewCoordinator, node: ReviewNode | undefined): string | undefined {
  if (!node || node.outcome) return undefined;
  return coordinator.error('maia', node, GRADING_BOT_SETTINGS);
}

// Nodes whose objective rows failed and need a retry sweep. The main sweep
// owns every other engine; this module owns only its own lane.
export function laneFailures(nodes: ReviewNode[], coordinator: ReviewCoordinator): ReviewNode[] {
  return nodes.filter(node => laneError(coordinator, node) !== undefined);
}

// Foreground fetch for the visible pair. Appends to the shared bot queue
// without wiping queued display jobs (different keys, same lane).
export function ensureLane(coordinator: ReviewCoordinator, targets: ReviewNode[], signal: AbortSignal): void {
  coordinator.ensure(targets, GRADING_BOT_SETTINGS, { priority: true, engines: ['maia'], signal, append: true });
}

// Human name for copy (bar, graphs). Names the role, never the model.
export function sourceLabel(): string {
  return 'Bot 2400';
}

// Pinned Elo shown as a locked dropdown in the panel heading. Null means
// the source has no Elo to show (the heading renders without a dropdown).
export function fixedElo(): number | null {
  return GRADING_BOT_SETTINGS.botElo;
}

// Bulk-restore descriptor for the lane. `settings` null means the source
// needs no extra inference, so the second restore and batch entries stand
// down; callers check presence, never model kind.
export function restoreDescriptor(): { settings: SettingsInput | null; engines: Engine[]; suffix: string } {
  return { settings: GRADING_BOT_SETTINGS, engines: ['maia'], suffix: '|g2400' };
}
