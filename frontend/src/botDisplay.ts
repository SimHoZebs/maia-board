import type { MoveResponse } from './api';
import { clampBotElo } from './BoardTools';
import { reviewKey, stablePositionKey, type ReviewNode, type ReviewSettings } from './evaluationStore';

export type BotDisplayEntry = {
  positionId: string; requestKey: string; botElo: number; userElo: number;
  result: MoveResponse;
};
// A previous identity is display-only. It never satisfies the requested cache
// key, and another position can never inherit it (including a same-ply branch).
export function selectBotDisplay(node: ReviewNode | undefined, settings: ReviewSettings, fresh: MoveResponse | undefined, previous: BotDisplayEntry | null, pending = false) {
  if (!node || node.outcome) return { entry: undefined, stale: false, pending: false };
  const key = reviewKey('maia', node, settings);
  const positionId = stablePositionKey(node);
  const entry = fresh ? { positionId, requestKey: key, botElo: clampBotElo(settings.botElo), userElo: clampBotElo(settings.userElo), result: fresh }
    : previous?.positionId === positionId ? previous : undefined;
  return { entry, stale: !!entry && entry.requestKey !== key, pending: !fresh && pending };
}
