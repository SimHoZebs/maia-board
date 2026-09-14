import type { MoveResponse } from './api';
import { reviewKey, type ReviewNode, type ReviewSettings } from './evaluationStore';

export type MaiaDisplayEntry = {
  positionId: number; requestKey: string; eloMaia: number; eloUser: number;
  result: MoveResponse;
};
// A previous identity is display-only. It never satisfies the requested cache
// key, and another position can never inherit it (including a same-ply branch).
export function selectMaiaDisplay(node: ReviewNode | undefined, settings: ReviewSettings, fresh: MoveResponse | undefined, previous: MaiaDisplayEntry | null, pending = false) {
  if (!node || node.outcome) return { entry: undefined, stale: false, pending: false };
  const key = reviewKey('maia', node, settings);
  const entry = fresh ? { positionId: node.historyId, requestKey: key, eloMaia: settings.eloMaia, eloUser: settings.eloUser, result: fresh }
    : previous?.positionId === node.historyId ? previous : undefined;
  return { entry, stale: !!entry && entry.requestKey !== key, pending: !fresh && pending };
}
