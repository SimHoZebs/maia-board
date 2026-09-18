import { Chess } from 'chess.js';
import { reviewKey, stablePositionKey, type ReviewNode, type ReviewSettings } from './evaluationStore';
import { outcomeExpected, reviewMove, type EngineGrade, type Evaluation, type ObjectiveGrade, type ObjectivePoint } from './reviewMetrics';

export type UnifiedVerdict = {
  posKey: string; fen: string; move: string;
  before?: Evaluation; after?: Evaluation; needsPending: boolean; quality?: EngineGrade;
  // Objective inputs compare by value, not reference: providers rebuild
  // point objects per lookup while the numbers stay identical, and the
  // grade derives from the numbers alone. (SF evaluations above compare by
  // reference because the store retains cache-stable identities.)
  objectiveTop?: string | null; objectiveExpected?: number | null;
  objectiveAfterExpected?: number | null; objectivePending?: boolean;
};
export type UnifiedMemo = { scope: string; verdicts: (UnifiedVerdict | undefined)[]; qualities: (EngineGrade | undefined)[] };

// Objective lane: node-indexed provider points for the active source, plus
// the pending set and key builder for its fetches. The loop never names a
// model: loss math reads points, and the after-position handling below is
// provider-neutral (an opponent-relative expectation inverts the same way
// for every source; terminal outcomes synthesize from game facts).
export type ObjectiveLane = {
  points: (ObjectivePoint | undefined)[];
  pending: Set<string>;
  keyFor: (node: ReviewNode) => string;
};

// Single quality loop for review + play. Callers supply scope (game/user for
// play, constant for review), per-node cache keys, and an activity predicate
// (all plies for review, user side only for play). Memo reuse is stable
// content (posKey + fen + move + eval identity + pending), never memory IDs.
export function computeQualities(args: {
  scope: string; moves: string[]; nodes: ReviewNode[]; evaluations: (Evaluation | undefined)[];
  keyFor: (node: ReviewNode) => string; active: (node: ReviewNode, index: number) => boolean;
  pending: Set<string>; prev: UnifiedMemo | null; stats?: { reviews: number };
  objective?: ObjectiveLane;
}): { qualities: (EngineGrade | undefined)[]; memo: UnifiedMemo } {
  const { scope, moves, nodes, evaluations, keyFor, active, pending, prev, stats, objective } = args;
  const sameScope = prev?.scope === scope;
  let allReused = !!prev && sameScope && prev.qualities.length === moves.length;
  const verdicts = moves.map((move, index): UnifiedVerdict | undefined => {
    const node = nodes[index], next = nodes[index + 1];
    if (!node || !next || !active(node, index)) return;
    const before = evaluations[index], after = evaluations[index + 1];
    // Every missing endpoint must itself be pending. The neighbor sharing
    // only one endpoint (viewing P1 fetches N[i]+N[i+1] while move y needs
    // N[i+1]+N[i+2]) stays blank instead of flashing a spinner it can never
    // settle.
    const beforeMissing = !before, afterMissing = !after;
    const needsPending = (beforeMissing || afterMissing)
      && (!beforeMissing || pending.has(keyFor(node)))
      && (!afterMissing || pending.has(keyFor(next)));
    const old = sameScope ? prev!.verdicts[index] : undefined;
    const posKey = stablePositionKey(node);
    const objectiveInput = objectiveInputFor(objective, node, next, index);
    const objectivePending = objectiveInput ? objectiveInput.grade.beforePending || objectiveInput.grade.afterPending : false;
    if (old && old.posKey === posKey && old.fen === node.fen && old.move === move
      && old.before === before && old.after === after && old.needsPending === needsPending
      && (old.objectiveTop ?? null) === (objectiveInput?.grade.top ?? null)
      && (old.objectiveExpected ?? null) === (objectiveInput?.grade.expected ?? null)
      && (old.objectiveAfterExpected ?? null) === (objectiveInput?.grade.afterExpected ?? null)
      && (old.objectivePending ?? false) === objectivePending) return old;
    allReused = false;
    if (before && after && stats) stats.reviews++;
    const quality = before && after ? reviewMove(before, after, new Chess(node.fen), move, objectiveInput?.grade ?? undefined)
      : needsPending ? { label: 'Unreviewed' as const, accuracy: null, loss: null } : undefined;
    return { posKey, fen: node.fen, move, before, after, needsPending, quality,
      objectiveTop: objectiveInput?.grade.top ?? null, objectiveExpected: objectiveInput?.grade.expected ?? null,
      objectiveAfterExpected: objectiveInput?.grade.afterExpected ?? null, objectivePending };
  });
  const qualities = allReused ? prev!.qualities : verdicts.map(verdict => verdict?.quality);
  return { qualities, memo: { scope, verdicts, qualities } };
}

// One move's objective input: the before-position point plus the
// mover-relative expectation after it. Terminal after-positions synthesize
// from the outcome (delivered mate wins, draws split); otherwise the
// after-node's opponent-relative expectation inverts to the mover.
function objectiveInputFor(lane: ObjectiveLane | undefined, node: ReviewNode, next: ReviewNode, index: number): { grade: ObjectiveGrade; before: ObjectivePoint | undefined } | null {
  if (!lane) return null;
  const before = lane.points[index];
  const after = lane.points[index + 1];
  const afterExpected = outcomeExpected(next.outcome) ?? (after?.expected != null ? 100 - after.expected : null);
  const settled = before?.top != null && before?.expected != null;
  return {
    before,
    grade: {
      top: before?.top ?? null,
      expected: before?.expected ?? null,
      afterExpected,
      beforePending: !settled && lane.pending.has(lane.keyFor(node)),
      afterPending: !next.outcome && afterExpected === null && lane.pending.has(lane.keyFor(next)),
    },
  };
}

// The one call site for both review and play. Review passes scope '' (or its
// line scope) with all plies active; play passes `${gameId}|${userColor}` with
// only its own side active. Hooks must call this, never computeQualities
// directly, so grading stays single-sourced.
export function computeLineQualities(args: {
  scope: string; moves: string[]; nodes: ReviewNode[]; evaluations: (Evaluation | undefined)[];
  settingsForNode: (node: ReviewNode) => ReviewSettings;
  active?: (node: ReviewNode, index: number) => boolean;
  pending: Set<string>; prev: UnifiedMemo | null; stats?: { reviews: number };
  objective?: ObjectiveLane;
}): { qualities: (EngineGrade | undefined)[]; memo: UnifiedMemo } {
  const { scope, moves, nodes, evaluations, settingsForNode, active, pending, prev, stats, objective } = args;
  return computeQualities({ scope, moves, nodes, evaluations,
    keyFor: node => reviewKey('sf', node, settingsForNode(node)),
    active: active ?? (() => true), pending, prev, stats, objective });
}
