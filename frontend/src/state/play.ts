import { Chess } from 'chess.js';
import { readableApiError } from '../api';
import { toGroundColor } from '../board-colors';
import { defaultSettings, extendLine, lineRecord, parseSquare, retreatLine, START_FEN, type Settings } from '../domain';
import { maiaTurn, queueRequest, transition, withPlay } from './shared';
import type { Action, PlayDraft, State } from './types';

// Play slice: live game data (setup draft, current game, saved games,
// in-flight Maia reply). Owns only play-game actions; spanning navigation
// (move/promote/mode/review/delete/sync) lives in the root reducer.
export const newPlayDraft = (settings: Settings): PlayDraft => ({ ...settings, temperature: defaultSettings.temperature });

export function reducePlay(state: State, action: Action): State | undefined {
  switch (action.type) {
    case 'setup': return { ...state, setup: { ...(state.setup ?? newPlayDraft(state.play.settings)), ...action.draft } };
    case 'cancel-setup': return state.started ? { ...state, setup: null } : state;
    case 'new': {
      const draft = state.setup ?? newPlayDraft(state.play.settings);
      if (draft.userColor === 'random' && !action.resolvedColor) return state;
      const settings: Settings = { ...draft, userColor: action.resolvedColor ?? (draft.userColor === 'black' ? 'black' : 'white'), eloUser: draft.eloMaia };
      return transition(state, { started: true, setup: null, viewedPly: null, play: { id: action.id, createdAt: action.createdAt, moves: [], settings } });
    }
    case 'takeback': {
      if (state.mode !== 'play' || !state.play.moves.length || state.play.result === 'resigned') return state;
      const tip = lineRecord(state.play.moves);
      const count = toGroundColor(new Chess(tip.fen).turn()) === state.play.settings.userColor ? 2 : 1;
      const { moves } = retreatLine(state.play.moves, START_FEN, count);
      return transition(withPlay(state, { ...state.play, moves }), { viewedPly: null });
    }
    case 'resign': {
      if (state.mode !== 'play' || !state.started || state.play.result === 'resigned') return state;
      if (lineRecord(state.play.moves).terminal !== null) return state;
      // transition drops any in-flight Maia reply; its stale response is
      // rejected by request identity in 'reply'.
      return transition(withPlay(state, { ...state.play, result: 'resigned' }), { viewedPly: null }, false);
    }
    case 'reply': {
      if (!state.request || state.request !== action.request) return state;
      try {
        const uci = action.response.move;
        const from = parseSquare(uci.slice(0, 2));
        const to = parseSquare(uci.slice(2, 4));
        if (from === undefined || to === undefined) throw new Error(`Maia returned an unreadable move: ${uci}`);
        const { moves } = extendLine(state.play.moves, START_FEN, from, to, uci[4]);
        return { ...withPlay(state, { ...state.play, moves }), request: null,
          insight: { response: action.response, fen: action.request.payload.fen, mode: 'play' } };
      } catch { return { ...state, request: null, error: 'Maia returned an illegal move.' }; }
    }
    case 'failure': return state.request === action.request ? { ...state, request: null, error: readableApiError(action.error) } : state;
    case 'retry': {
      // Manual retry for the last failed Maia reply. Automatic loops are
      // intentionally avoided (a busy engine would hot-loop); the banner
      // surfaces the message first and the user gates the next attempt.
      if (state.request || !state.error) return state;
      if (state.mode === 'play') return maiaTurn(state) ? queueRequest({ ...state, revision: state.revision + 1 }) : state;
      return state;
    }
    case 'saved': {
      const play = state.saved.find(game => game.id === action.id);
      return play ? transition(state, { play, started: true, setup: null, viewedPly: null, mode: 'play' }) : state;
    }
    default: return undefined;
  }
}
