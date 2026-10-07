// Shared objective best-line hook for both rooms. The walk reads only
// settled coordinator cache (lane rows for Maia tops, provisional Stockfish
// rows for the mate veto) and names exactly one Maia frontier plus one
// Stockfish frontier; the room fetches those through ensureFrontier, so the
// line deepens one verified step per settle like the true-delta children.
// Rooms gate `enabled` on their own Mistake/Blunder + cp-vs-cp facts — the
// hook never decides when a line is wanted, only what it contains.
import { useEffect, useMemo } from 'react';
import { buildTimeline } from '../shared/domain';
import { laneError, lanePoints, laneRows } from '../objective/index';
import { walkObjectiveLine } from '../objective/bestLine';
import { reviewNodes, type ReviewCoordinator, type ReviewNode, type ReviewSettings } from './reviewCoordinator';

export function useObjectiveBestLine(args: {
  coordinator: ReviewCoordinator;
  initialFen: string;
  lineMoves: readonly string[];
  // After-index of the reviewed move: the walk roots at the position after
  // lineMoves[reviewedPly - 1]. Values below 1 mean no reviewed move.
  reviewedPly: number;
  enabled: boolean;
  window: number;
  sfSettingsFor: (node: ReviewNode) => ReviewSettings;
  ensureFrontier: (maia: ReviewNode | null, sf: ReviewNode | null) => void;
  // Coordinator snapshot: recompute as rows (and failures) land.
  version: unknown;
}): string[] {
  const { coordinator, initialFen, lineMoves, reviewedPly, enabled, window, sfSettingsFor, ensureFrontier, version } = args;
  const baseKey = useMemo(() => JSON.stringify(lineMoves.slice(0, Math.max(0, reviewedPly))), [lineMoves, reviewedPly]);
  const walk = useMemo(() => {
    if (!enabled || reviewedPly < 1) return { ucis: [], maiaFrontier: null as string[] | null, sfFrontier: null as string[] | null };
    const baseMoves: string[] = JSON.parse(baseKey);
    const nodeFor = (prefix: string[]): ReviewNode | null => {
      try {
        return reviewNodes(buildTimeline(initialFen, prefix))[prefix.length] ?? null;
      } catch {
        return null;
      }
    };
    return walkObjectiveLine({
      initialFen,
      baseMoves,
      maxPlies: window,
      topAt: prefix => {
        const node = nodeFor(prefix);
        // Terminal positions carry no lane rows: never fetch them (the job
        // filter would no-op, leaving a stuck frontier).
        if (!node || node.outcome) return { kind: 'none' as const };
        const row = laneRows([node], { coordinator, sfEvaluations: [undefined] })[0];
        if (!row) return { kind: 'missing' as const };
        if (row.degraded || laneError(coordinator, node)) return { kind: 'none' as const };
        const top = lanePoints([row], [node])[0]?.top;
        return typeof top === 'string' ? { kind: 'top' as const, uci: top } : { kind: 'none' as const };
      },
      sfAt: prefix => {
        const node = nodeFor(prefix);
        if (!node) return { kind: 'none' as const };
        if (coordinator.error('sf', node, sfSettingsFor(node))) return { kind: 'none' as const };
        const found = coordinator.provisionalSfResult(node, sfSettingsFor(node));
        if (!found) return { kind: 'missing' as const };
        return { kind: 'score' as const, score: found.score };
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinator, initialFen, baseKey, window, enabled, version]);
  const frontierKey = useMemo(
    () => JSON.stringify([walk.maiaFrontier, walk.sfFrontier]),
    [walk.maiaFrontier, walk.sfFrontier],
  );
  useEffect(() => {
    if (!enabled) return;
    const [maiaPrefix, sfPrefix] = JSON.parse(frontierKey) as (string[] | null)[];
    // Rebuild nodes from prefixes (nodeFor stays inside the walk memo).
    const toNode = (prefix: string[] | null): ReviewNode | null => {
      if (!prefix) return null;
      try {
        return reviewNodes(buildTimeline(initialFen, prefix))[prefix.length] ?? null;
      } catch {
        return null;
      }
    };
    const maia = toNode(maiaPrefix);
    const sf = toNode(sfPrefix);
    if (!maia && !sf) return;
    ensureFrontier(maia, sf);
  }, [enabled, frontierKey, initialFen, ensureFrontier]);
  return walk.ucis;
}
