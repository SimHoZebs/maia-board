import type { MoveResponse } from './api';
import { clampElo } from '../board/BoardTools';
import {
  reviewKey,
  stablePositionKey,
  type ReviewNode,
  type ReviewSettings,
} from './evaluationStore';

export type BotDisplayEntry = {
  positionId: string;
  requestKey: string;
  botElo: number;
  userElo: number;
  result: MoveResponse;
};
// A previous identity is display-only. It never satisfies the requested cache
// key, and another position can never inherit it (including a same-ply branch).
// Null means no node / no fresh row (root, loading, failed) — never undefined.
export function selectBotDisplay(
  node: ReviewNode | null,
  settings: ReviewSettings,
  fresh: MoveResponse | null,
  previous: BotDisplayEntry | null,
  pending = false,
) {
  if (node === null || node.outcome)
    return { entry: null as BotDisplayEntry | null, stale: false, pending: false };
  const key = reviewKey('maia', node, settings);
  const positionId = stablePositionKey(node);
  const entry =
    fresh !== null
      ? {
          positionId,
          requestKey: key,
          botElo: clampElo(settings.botElo),
          userElo: clampElo(settings.userElo),
          result: fresh,
        }
      : previous !== null && previous.positionId === positionId
        ? previous
        : null;
  return {
    entry,
    stale: entry !== null && entry.requestKey !== key,
    pending: fresh === null && pending,
  };
}
