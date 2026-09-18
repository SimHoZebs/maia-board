import type { State } from './state/index';
import { useReviewPipeline } from './useReviewPipeline';
export { computeReviewQualities, gameIdentityFor, isMaiaPosition, translateReviewQualities,
  type RecordStatus, type ReviewQualitiesMemo, type ReviewQualitiesStats, type ReviewState } from './useReviewPipeline';

// Thin adapter over the single review pipeline: the analysis room grades the
// whole line viewed-first with debounce + batch-wait eagerness. Pure grading
// helpers stay re-exported above so existing tests keep compiling.
export function useReview(state: State) {
  return useReviewPipeline(state, 'analysis');
}
export type Review = ReturnType<typeof useReview>;
