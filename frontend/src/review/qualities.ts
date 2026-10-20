import { Chess } from 'chess.js';
import { plyAt } from '../shared/explicit';
import {
  reviewKey,
  stablePositionKey,
  type ReviewNode,
  type ReviewSettings,
} from '../eval/evaluationStore';
import {
  outcomeExpected,
  reviewMove,
  type EngineGrade,
  type Evaluation,
  type ObjectiveGrade,
  type ObjectivePoint,
} from './reviewMetrics';

export type QualityMemoEntry = {
  stableKey: string;
  fen: string;
  move: string;
  before: Evaluation | null;
  after: Evaluation | null;
  needsPending: boolean;
  grade: EngineGrade | null;
  // Objective inputs compare by value, not reference: providers rebuild
  // point objects per lookup while the numbers stay identical, and the
  // grade derives from the numbers alone. (SF evaluations above compare by
  // reference because the store retains cache-stable identities.)
  // Null means no reading at this ply — never undefined.
  objectiveTop: string | null;
  objectiveExpected: number | null;
  objectiveAfterExpected: number | null;
  objectivePending: boolean;
};
export type UnifiedMemo = {
  scope: string;
  entries: (QualityMemoEntry | null)[];
  grades: (EngineGrade | null)[];
};

// Objective lane: node-indexed provider points for the active source, plus
// the pending set and key builder for its fetches. Null marks no point at
// this ply — never undefined. Handling below is provider-neutral.
export type ObjectiveLane = {
  points: (ObjectivePoint | null)[];
  pending: Set<string>;
  keyFor: (node: ReviewNode) => string;
};

// Single quality loop for review + play. Callers supply scope, per-node
// cache keys, an activity predicate, and pending sets. Memo keys combine
// stableKey + fen + move + eval identity.
export function computeQualities(args: {
  scope: string;
  moves: string[];
  nodes: ReviewNode[];
  evaluations: (Evaluation | null)[];
  keyFor: (node: ReviewNode) => string;
  active: (node: ReviewNode, index: number) => boolean;
  pending: Set<string>;
  prev: UnifiedMemo | null;
  stats?: { reviews: number };
  objective: ObjectiveLane | null;
}): { grades: (EngineGrade | null)[]; memo: UnifiedMemo } {
  const { scope, moves, nodes, evaluations, keyFor, active, pending, prev, stats, objective } =
    args;
  const sameScope = prev !== null && prev.scope === scope;
  let allReused = prev !== null && sameScope && prev.grades.length === moves.length;
  const entries = moves.map((move, index): QualityMemoEntry | null => {
    const node = index < nodes.length ? nodes[index] : null;
    const next = index + 1 < nodes.length ? nodes[index + 1] : null;
    if (node === null || next === null || !active(node, index)) return null;
    const before = plyAt(evaluations, index, 'evaluations');
    const after = plyAt(evaluations, index + 1, 'evaluations');
    // Every missing endpoint must itself be pending. The neighbor sharing
    // only one endpoint (viewing P1 fetches N[i]+N[i+1] while move y needs
    // N[i+1]+N[i+2]) stays blank instead of flashing a spinner it can never
    // settle.
    const beforeMissing = before === null,
      afterMissing = after === null;
    const needsPending =
      (beforeMissing || afterMissing) &&
      (!beforeMissing || pending.has(keyFor(node))) &&
      (!afterMissing || pending.has(keyFor(next)));
    // Memo reuse across line growth/shrink: a shorter memo (append) or a
    // longer one (takeback) is normal — out-of-range reads mean recompute
    // (null), never a failure. In-range holes still throw via plyAt.
    const old =
      sameScope && prev !== null && index < prev.entries.length
        ? plyAt(prev.entries, index, 'memo entries')
        : null;
    const stableKey = stablePositionKey(node);
    const objectiveInput = objectiveInputFor(objective, node, next, index);
    const objectivePending = objectiveInput
      ? objectiveInput.grade.beforePending || objectiveInput.grade.afterPending
      : false;
    if (
      old !== null &&
      old.stableKey === stableKey &&
      old.fen === node.fen &&
      old.move === move &&
      old.before === before &&
      old.after === after &&
      old.needsPending === needsPending &&
      old.objectiveTop === (objectiveInput === null ? null : objectiveInput.grade.top) &&
      old.objectiveExpected === (objectiveInput === null ? null : objectiveInput.grade.expected) &&
      old.objectiveAfterExpected ===
        (objectiveInput === null ? null : objectiveInput.grade.afterExpected) &&
      old.objectivePending === objectivePending
    )
      return old;
    allReused = false;
    if (before !== null && after !== null && stats) stats.reviews++;
    const grade =
      before !== null && after !== null
        ? reviewMove(
            before,
            after,
            new Chess(node.fen),
            move,
            objectiveInput === null ? undefined : objectiveInput.grade,
          )
        : needsPending
          ? { label: 'Unreviewed' as const, accuracy: null, loss: null }
          : null;
    return {
      stableKey,
      fen: node.fen,
      move,
      before,
      after,
      needsPending,
      grade,
      objectiveTop: objectiveInput === null ? null : objectiveInput.grade.top,
      objectiveExpected: objectiveInput === null ? null : objectiveInput.grade.expected,
      objectiveAfterExpected: objectiveInput === null ? null : objectiveInput.grade.afterExpected,
      objectivePending,
    };
  });
  const grades =
    allReused && prev !== null
      ? prev.grades
      : entries.map(entry => (entry === null ? null : entry.grade));
  return { grades, memo: { scope, entries, grades } };
}

// One move's objective input: the before-position point plus the
// mover-relative expectation after it. Terminal after-positions synthesize
// from the outcome (delivered mate wins, draws split); otherwise the
// after-node's opponent-relative expectation inverts to the mover.
function objectiveInputFor(
  lane: ObjectiveLane | null,
  node: ReviewNode,
  next: ReviewNode,
  index: number,
): { grade: ObjectiveGrade; before: ObjectivePoint | null } | null {
  if (lane === null) return null;
  // Points align 1:1 with nodes by construction (lanePoints maps laneRows
  // maps nodes). A short lane is a bug, so plyAt throws instead of
  // silently grading against the wrong position.
  const before = plyAt(lane.points, index, 'objective points');
  const after = plyAt(lane.points, index + 1, 'objective points');
  const afterExpected =
    outcomeExpected(next.outcome) ??
    (after !== null && after.expected != null ? 100 - after.expected : null);
  const settled = before !== null && before.top != null && before.expected != null;
  return {
    before,
    grade: {
      top: before === null ? null : before.top,
      expected: before === null ? null : before.expected,
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
  scope: string;
  moves: string[];
  nodes: ReviewNode[];
  evaluations: (Evaluation | null)[];
  settingsForNode: (node: ReviewNode) => ReviewSettings;
  active?: (node: ReviewNode, index: number) => boolean;
  pending: Set<string>;
  prev: UnifiedMemo | null;
  stats?: { reviews: number };
  objective: ObjectiveLane | null;
}): { grades: (EngineGrade | null)[]; memo: UnifiedMemo } {
  const {
    scope,
    moves,
    nodes,
    evaluations,
    settingsForNode,
    active,
    pending,
    prev,
    stats,
    objective,
  } = args;
  return computeQualities({
    scope,
    moves,
    nodes,
    evaluations,
    keyFor: node => reviewKey('sf', node, settingsForNode(node)),
    active: active ?? (() => true),
    pending,
    prev,
    stats,
    objective,
  });
}
