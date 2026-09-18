// Board state barrel. The god reducer is dissolved: game data reduces in
// play.ts (live game) and analysis.ts (reviewed line + snapshot session
// truth), display settings reduce in display.ts, cross-slice mechanics live
// in shared.ts, and reducer.ts composes them plus the spanning navigation
// and sync cases. Import from './state/index' (or a slice for narrower
// coupling); the './state' file is gone.
export type { Action, AnalysisSnapshot, Draft, PlayDraft, State } from './types';
export { currentPosition, maiaTurn } from './shared';
export { initialDisplayState, normalizeBadgeLoading, normalizeCoordinatesOnSquares, type DisplayState } from './display';
export { newPlayDraft } from './play';
export { readSnapshot, snapshotOf } from './analysis';
export { initialState, reducer } from './reducer';
