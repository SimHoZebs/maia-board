import type { MoveResponse } from './api';
import { clampMaiaElo } from './BoardTools';
import { reviewKey, stablePositionKey, type ReviewNode, type ReviewSettings } from './evaluationStore';

export type MaiaDisplayEntry = {
  positionId: string; requestKey: string; eloMaia: number; eloUser: number;
  result: MoveResponse;
};
// A previous identity is display-only. It never satisfies the requested cache
// key, and another position can never inherit it (including a same-ply branch).
export function selectMaiaDisplay(node: ReviewNode | undefined, settings: ReviewSettings, fresh: MoveResponse | undefined, previous: MaiaDisplayEntry | null, pending = false) {
  if (!node || node.outcome) return { entry: undefined, stale: false, pending: false };
  const key = reviewKey('maia', node, settings);
  const positionId = stablePositionKey(node);
  const entry = fresh ? { positionId, requestKey: key, eloMaia: clampMaiaElo(settings.eloMaia), eloUser: clampMaiaElo(settings.eloUser), result: fresh }
    : previous?.positionId === positionId ? previous : undefined;
  return { entry, stale: !!entry && entry.requestKey !== key, pending: !fresh && pending };
}
