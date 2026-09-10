import { Chess, type Square } from 'chess.js';
import { type MoveRequest, type MoveResponse, readableApiError } from './api';
import { toGroundColor } from './board-colors';
import { applyUci, loadLine, newId, oppositeColor, positionOf, replay, START_FEN,
  type Analysis, type Insight, type Mode, type Settings, type StoredGame } from './domain';
import { KEYS, loadSaved, loadSettings, readStorage, restoreGame } from './storage';

type Request = { id: number; mode: Mode; payload: MoveRequest };
export type State = {
  mode: Mode; settings: Settings; play: StoredGame; saved: StoredGame[];
  analysis: Analysis; inputs: { fen: string; pgn: string }; flipped: boolean;
  promotion: { from: Square; to: Square } | null;
  insight: Insight | null; error: string; request: Request | null; revision: number;
};
export type Action =
  | { type: 'mode'; mode: Mode }
  | { type: 'new'; id: string; createdAt: string }
  | { type: 'settings'; settings: Partial<Settings>; id: string; createdAt: string }
  | { type: 'takeback' } | { type: 'flip' }
  | { type: 'move'; from: Square; to: Square }
  | { type: 'promote'; piece: string | null }
  | { type: 'inputs'; inputs: Partial<State['inputs']> }
  | { type: 'load' } | { type: 'step'; delta: number } | { type: 'analyze' }
  | { type: 'saved'; id: string }
  | { type: 'reply'; request: Request; response: MoveResponse }
  | { type: 'failure'; request: Request; error: unknown };

export function currentPosition(state: State) {
  return state.mode === 'play' ? positionOf(replay(state.play.moves)) : state.analysis.timeline[state.analysis.index];
}
export function maiaTurn(state: State): boolean {
  const game = replay(state.play.moves);
  return toGroundColor(game.turn()) !== state.settings.userColor && !game.isGameOver();
}
function queueRequest(state: State): State {
  const position = currentPosition(state);
  return { ...state, error: '', request: { id: state.revision, mode: state.mode, payload: {
    fen: position.fen, moves: position.moves, elo_maia: state.settings.eloMaia,
    elo_user: state.settings.eloUser, model: state.settings.model,
    maia_color: state.mode === 'play' ? oppositeColor(state.settings.userColor) : toGroundColor(new Chess(position.fen).turn()),
    ...(state.mode === 'analysis' && state.analysis.initialFen !== START_FEN ? { initial_fen: state.analysis.initialFen } : {}),
  } } };
}
// Every context-changing action retires the previous request, even when its FEN is identical.
function transition(state: State, changes: Partial<State>, resumePlay = true): State {
  const next = { ...state, ...changes, revision: state.revision + 1, request: null, promotion: null, insight: null, error: '' };
  return resumePlay && next.mode === 'play' && maiaTurn(next) ? queueRequest(next) : next;
}
function withPlay(state: State, play: StoredGame): State {
  const existed = state.saved.some(game => game.id === play.id);
  const saved = play.moves.length || existed ? [play, ...state.saved.filter(game => game.id !== play.id)].slice(0, 8) : state.saved;
  return { ...state, play, saved };
}
function commitMove(state: State, from: Square, to: Square, promotion?: string): State {
  try {
    const game = replay(state.play.moves);
    game.move({ from, to, ...(promotion ? { promotion } : {}) });
    return transition(withPlay(state, { ...state.play, moves: positionOf(game).moves }), {});
  } catch { return { ...state, promotion: null, error: 'That move is not legal in this position.' }; }
}
export function initialState(): State {
  const restored = restoreGame(readStorage(KEYS.current));
  const settings = restored?.settings ?? loadSettings();
  const stored = readStorage<Partial<State['inputs']>>(KEYS.analysis);
  const inputs = { fen: typeof stored?.fen === 'string' ? stored.fen : '', pgn: typeof stored?.pgn === 'string' ? stored.pgn : '' };
  let analysis = loadLine();
  try { analysis = loadLine(inputs.fen, inputs.pgn); } catch { /* Keep editable invalid input for correction. */ }
  const state: State = { mode: 'play', settings, play: restored ?? { id: newId(), createdAt: new Date().toISOString(), moves: [], settings },
    saved: loadSaved(), analysis, inputs, flipped: false, promotion: null, insight: null, error: '', request: null, revision: 0 };
  return maiaTurn(state) ? queueRequest(state) : state;
}
export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'mode': return action.mode === state.mode ? state : transition(state, { mode: action.mode });
    case 'new': return transition(state, { play: { id: action.id, createdAt: action.createdAt, moves: [], settings: state.settings } });
    case 'settings': {
      const settings = { ...state.settings, ...action.settings };
      const sideChanged = settings.userColor !== state.settings.userColor;
      const play = { ...state.play, settings, ...(sideChanged ? { id: action.id, createdAt: action.createdAt, moves: [] } : {}) };
      return transition(sideChanged ? state : withPlay(state, play), { settings, play });
    }
    case 'flip': return { ...state, flipped: !state.flipped };
    case 'takeback': {
      if (state.mode !== 'play' || !state.play.moves.length) return state;
      const game = replay(state.play.moves);
      const count = toGroundColor(game.turn()) === state.settings.userColor ? 2 : 1;
      for (let n = 0; n < count; n++) game.undo();
      return transition(withPlay(state, { ...state.play, moves: positionOf(game).moves }), {});
    }
    case 'move': {
      const game = replay(state.play.moves);
      if (state.mode !== 'play' || state.request || state.promotion || game.isGameOver() || toGroundColor(game.turn()) !== state.settings.userColor) return state;
      if (!game.moves({ verbose: true }).some(move => move.from === action.from && move.to === action.to)) return state;
      if (game.get(action.from)?.type === 'p' && /[18]$/.test(action.to)) return { ...state, promotion: { from: action.from, to: action.to } };
      return commitMove(state, action.from, action.to);
    }
    case 'promote': return state.promotion && action.piece ? commitMove(state, state.promotion.from, state.promotion.to, action.piece) : { ...state, promotion: null };
    case 'inputs': return { ...state, inputs: { ...state.inputs, ...action.inputs } };
    case 'load': {
      const next = transition(state, {}, false);
      try { return { ...next, analysis: loadLine(state.inputs.fen, state.inputs.pgn) }; }
      catch (error) { return { ...next, error: error instanceof Error ? error.message : 'Could not load this position.' }; }
    }
    case 'step': {
      const index = Math.max(0, Math.min(state.analysis.timeline.length - 1, state.analysis.index + action.delta));
      return index === state.analysis.index ? state : transition(state, { analysis: { ...state.analysis, index } }, false);
    }
    case 'analyze': return state.mode === 'analysis' && !state.request ? queueRequest({ ...state, revision: state.revision + 1, insight: null }) : state;
    case 'saved': {
      const play = state.saved.find(game => game.id === action.id);
      return play ? transition(state, { play, settings: play.settings, mode: 'play' }) : state;
    }
    case 'reply': {
      if (state.request !== action.request) return state;
      const insight: Insight = { response: action.response, fen: action.request.payload.fen, mode: state.mode };
      if (state.mode === 'analysis') return { ...state, request: null, insight };
      try {
        const game = replay(state.play.moves);
        applyUci(game, action.response.move);
        return { ...withPlay(state, { ...state.play, moves: positionOf(game).moves }), request: null, insight };
      } catch { return { ...state, request: null, error: 'Maia returned an illegal move.' }; }
    }
    case 'failure': return state.request === action.request ? { ...state, request: null, error: readableApiError(action.error) } : state;
  }
}
