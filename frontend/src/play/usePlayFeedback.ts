import type { State } from '../state/index';
import { useReviewPipeline } from '../review/useReviewPipeline';
export {
  computePlayQualities,
  getNavigatorOnLine,
  hasExhaustedPlayRetries,
  isOfflineNow,
  isOfflineValue,
  PLAY_RETRY_EXHAUSTED_MESSAGE,
  playExhaustedError,
  unsettledReviewNodes,
  wantedPlayPair,
  type PlayFeedback,
  type PlayQualitiesMemo,
  type PlayQualitiesStats,
} from '../review/useReviewPipeline';

// Thin adapter over the single review pipeline: the play room grades the
// newest pair plus user-side-only activity with foreground-fetch-on-move +
// 3x2s retry + sweep-all-user-moves-on-reconnect eagerness. Cache-fill runs
// for every started game regardless of the feedback toggle (display stays
// gated): the temperature-less pair, restore, and sweeps write through to
// the server cache, so a later reload hits instead of recomputing.
// Pure helpers stay re-exported above so existing tests keep compiling.
export function usePlayFeedback(state: State) {
  return useReviewPipeline(state, 'play');
}
