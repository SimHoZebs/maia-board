import { Chess } from 'chess.js';
import { reviewKey, stablePositionKey, type ReviewNode, type ReviewSettings } from './evaluationStore';
import { reviewMove, type EngineGrade, type Evaluation } from './reviewMetrics';

export type UnifiedVerdict = {
  posKey: string; fen: string; move: string;
  before?: Evaluation; after?: Evaluation; needsPending: boolean; quality?: EngineGrade;
};
export type UnifiedMemo = { scope: string; verdicts: (UnifiedVerdict | undefined)[]; qualities: (EngineGrade | undefined)[] };

// Single quality loop for review + play. Callers supply scope (game/user for
// play, constant for review), per-node cache keys, and an activity predicate
// (all plies for review, user side only for play). Memo reuse is stable
// content (posKey + fen + move + eval identity + pending), never memory IDs.
export function computeQualities(args: {
  scope: string; moves: string[]; nodes: ReviewNode[]; evaluations: (Evaluation | undefined)[];
  keyFor: (node: ReviewNode) => string; active: (node: ReviewNode, index: number) => boolean;
  pending: Set<string>; prev: UnifiedMemo | null; stats?: { reviews: number };
}): { qualities: (EngineGrade | undefined)[]; memo: UnifiedMemo } {
  const { scope, moves, nodes, evaluations, keyFor, active, pending, prev, stats } = args;
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
    if (old && old.posKey === posKey && old.fen === node.fen && old.move === move
      && old.before === before && old.after === after && old.needsPending === needsPending) return old;
    allReused = false;
    if (before && after && stats) stats.reviews++;
    const quality = before && after ? reviewMove(before, after, new Chess(node.fen), move)
      : needsPending ? { label: 'Unreviewed' as const, accuracy: null, loss: null } : undefined;
    return { posKey, fen: node.fen, move, before, after, needsPending, quality };
  });
  const qualities = allReused ? prev!.qualities : verdicts.map(verdict => verdict?.quality);
  return { qualities, memo: { scope, verdicts, qualities } };
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
}): { qualities: (EngineGrade | undefined)[]; memo: UnifiedMemo } {
  const { scope, moves, nodes, evaluations, settingsForNode, active, pending, prev, stats } = args;
  return computeQualities({ scope, moves, nodes, evaluations,
    keyFor: node => reviewKey('sf', node, settingsForNode(node)),
    active: active ?? (() => true), pending, prev, stats });
}
