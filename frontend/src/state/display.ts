import { normalizeBoardOrientation } from '../shared/domain';
import { KEYS, readStorage } from '../history/storage';
import { normalizeStockfishSettings, STOCKFISH_STORAGE_KEY } from '../eval/stockfishSettings';
import { defaultArrowBasis, defaultArrowSettings, normalizeArrowBasis, normalizeArrowSettings, sameArrowSettings } from '../settings/arrowSettings';
import { normalizeBestLineWindow } from '../theory/material';
import type { BadgeLoading } from '../review/ReviewCharts';
import type { Action, State } from './types';

// Display-settings slice: board presentation + engine preferences. These
// fields never enter review cache keys or engine requests (changing them
// recomputes verdict text without a refetch), so they reduce separately
// from game data. Returns undefined for actions owned by other slices.
export function normalizeBadgeLoading(stored: unknown): BadgeLoading {
  return stored === 'shimmer' || stored === 'placeholder' ? stored : 'reel';
}

// Inside-squares coordinates are the default: outside labels use fixed-px
// offsets that drift against fluid square sizes, while on-squares labels are
// proportional and stay aligned at any viewport.
export function normalizeCoordinatesOnSquares(stored: unknown): boolean {
  return stored === false ? false : true;
}

// Move sounds default on: every chess platform sounds the board, and the
// stored value only ever turns them off.
export function normalizeSoundEnabled(stored: unknown): boolean {
  return stored === false ? false : true;
}

export type DisplayState = Pick<State, 'stockfish' | 'feedback' | 'playVerdict' | 'badgeLoading' | 'coordinatesOnSquares' | 'soundEnabled' | 'boardOrientation' | 'bestLineWindow' | 'arrows' | 'arrowBasis' | 'flipped' | 'preview'>;

export function initialDisplayState(): DisplayState {
  return {
    stockfish: normalizeStockfishSettings(readStorage(STOCKFISH_STORAGE_KEY)),
    feedback: readStorage<boolean>(KEYS.feedback) === true,
    playVerdict: readStorage<boolean>(KEYS.playVerdict) === true,
    badgeLoading: normalizeBadgeLoading(readStorage<unknown>(KEYS.badgeLoading)),
    coordinatesOnSquares: normalizeCoordinatesOnSquares(readStorage<unknown>(KEYS.coordinatesOnSquares)),
    soundEnabled: normalizeSoundEnabled(readStorage<unknown>(KEYS.sound)),
    boardOrientation: normalizeBoardOrientation(readStorage<unknown>(KEYS.boardOrientation)),
    bestLineWindow: normalizeBestLineWindow(readStorage<unknown>(KEYS.bestLineWindow)),
    arrows: normalizeArrowSettings(readStorage<unknown>(KEYS.arrows)),
    arrowBasis: normalizeArrowBasis(readStorage<unknown>(KEYS.arrowBasis)),
    flipped: false,
    preview: null,
  };
}

export function reduceDisplay(state: State, action: Action): State | undefined {
  switch (action.type) {
    case 'stockfish-settings': return { ...state, stockfish: normalizeStockfishSettings({ ...state.stockfish, ...action.settings }) };
    case 'feedback': return state.feedback === action.enabled ? state : { ...state, feedback: action.enabled };
    case 'play-verdict': return state.playVerdict === action.enabled ? state : { ...state, playVerdict: action.enabled };
    case 'badge-loading': return state.badgeLoading === action.loading ? state : { ...state, badgeLoading: action.loading };
    case 'coordinates-on-squares': return state.coordinatesOnSquares === action.enabled ? state : { ...state, coordinatesOnSquares: action.enabled };
    case 'sound-enabled': return state.soundEnabled === action.enabled ? state : { ...state, soundEnabled: action.enabled };
    case 'board-orientation': return state.boardOrientation === action.orientation ? state : { ...state, boardOrientation: action.orientation };
    // Display-only like badgeLoading: normalizing here keeps junk storage or
    // dispatches on the default, and the value never enters review cache keys
    // or engine requests, so changing it recomputes verdict text without a
    // refetch.
    case 'best-line-window': { const window = normalizeBestLineWindow(action.window); return state.bestLineWindow === window ? state : { ...state, bestLineWindow: window }; }
    case 'arrow-settings': {
      const current = state.arrows[action.source];
      const merged = normalizeArrowSettings({ ...state.arrows, [action.source]: { ...current, ...action.style } });
      return sameArrowSettings(merged, state.arrows) ? state : { ...state, arrows: merged };
    }
    case 'arrow-settings-reset': return sameArrowSettings(state.arrows, defaultArrowSettings) ? state : { ...state, arrows: defaultArrowSettings };
    case 'arrow-basis': { const basis = normalizeArrowBasis(action.basis); return state.arrowBasis === basis ? state : { ...state, arrowBasis: basis }; }
    case 'flip': return { ...state, flipped: !state.flipped };
    case 'preview': return { ...state, preview: action.uci };
    default: return undefined;
  }
}
