import { Chess, type Square } from 'chess.js';
import { type MoveRequest, type MoveResponse, readableApiError } from './api';
import { toGroundColor } from './board-colors';
import { analysisLength, analysisLine, applyUci, loadLine, newId, oppositeColor, positionOf, replay, START_FEN,
  type Analysis, type Insight, type Mode, type Settings, type StoredGame } from './domain';
import { KEYS, loadSaved, loadSettings, readStorage, restoreGame } from './storage';

type Request = { id: number; mode: Mode; payload: MoveRequest };
export type Draft = Pick<Settings, 'eloMaia' | 'userColor' | 'model'>;
export type State = {
  mode: Mode; settings: Settings; play: StoredGame; saved: StoredGame[];
  started: boolean; setup: Draft | null; viewedPly: number | null;
  analysis: Analysis; analysisSettings: Draft; analysisLoaded: boolean; importing: boolean;
  inputs: { fen: string; pgn: string }; flipped: boolean; preview: string | null;
  promotion: { from: Square; to: Square } | null;
  insight: Insight | null; error: string; request: Request | null; revision: number;
};
export type Action =
  | { type: 'mode'; mode: Mode }
  | { type: 'setup'; draft?: Partial<Draft> } | { type: 'cancel-setup' }
  | { type: 'new'; id: string; createdAt: string }
  | { type: 'settings'; settings: Partial<Settings>; id: string; createdAt: string }
  | { type: 'analysis-settings'; settings: Partial<Draft> }
  | { type: 'takeback' } | { type: 'flip' }
  | { type: 'move'; from: Square; to: Square } | { type: 'try'; uci: string }
  | { type: 'preview'; uci: string | null } | { type: 'original' }
  | { type: 'promote'; piece: string | null }
  | { type: 'inputs'; inputs: Partial<State['inputs']> }
  | { type: 'import'; open: boolean }
  | { type: 'load' } | { type: 'step'; delta: number } | { type: 'view'; ply: number | null } | { type: 'analyze' }
  | { type: 'saved'; id: string } | { type: 'review'; id?: string } | { type: 'delete'; id: string }
  | { type: 'reply'; request: Request; response: MoveResponse }
  | { type: 'failure'; request: Request; error: unknown };

export function currentPosition(state: State) {
  return state.mode === 'analysis' ? analysisLine(state.analysis) : positionOf(replay(state.play.moves.slice(0, state.viewedPly ?? state.play.moves.length)));
}
export function maiaTurn(state: State): boolean {
  const game = replay(state.play.moves);
  return state.started && toGroundColor(game.turn()) !== state.settings.userColor && !game.isGameOver();
}
function queueRequest(state: State): State {
  const position = state.mode === 'play' ? positionOf(replay(state.play.moves)) : analysisLine(state.analysis);
  const settings = state.mode === 'play' ? state.settings : { ...state.analysisSettings, eloUser: state.analysisSettings.eloMaia };
  return { ...state, error: '', request: { id: state.revision, mode: state.mode, payload: {
    fen: position.fen, moves: position.moves, elo_maia: settings.eloMaia, elo_user: settings.eloUser, model: settings.model,
    maia_color: state.mode === 'play' ? oppositeColor(state.settings.userColor) : toGroundColor(new Chess(position.fen).turn()),
    ...(state.mode === 'analysis' && state.analysis.initialFen !== START_FEN ? { initial_fen: state.analysis.initialFen } : {}),
  } } };
}
function transition(state: State, changes: Partial<State>, resumePlay = true): State {
  const next = { ...state, ...changes, revision: state.revision + 1, request: null, promotion: null, preview: null, insight: null, error: '' };
  return resumePlay && next.mode === 'play' && maiaTurn(next) ? queueRequest(next) : next;
}
function withPlay(state: State, play: StoredGame): State {
  const existed = state.saved.some(game => game.id === play.id);
  const saved = play.moves.length || existed ? [play, ...state.saved.filter(game => game.id !== play.id)].slice(0, 8) : state.saved;
  return { ...state, play, saved };
}
function commitMove(state: State, from: Square, to: Square, promotion?: string): State {
  try {
    if (state.mode === 'analysis') {
      const { analysis } = state;
      if (analysis.branchFromPly !== null && analysis.index < analysis.branchFromPly) return { ...state, error: 'Return to original before exploring from another starting point.' };
      const game = new Chess(currentPosition(state).fen);
      const move = game.move({ from, to, ...(promotion ? { promotion } : {}) });
      const branchFromPly = analysis.branchFromPly ?? analysis.index;
      const branchMoves = [...analysis.branchMoves.slice(0, analysis.index - branchFromPly), `${move.from}${move.to}${move.promotion ?? ''}`];
      return transition(state, { analysis: { ...analysis, branchFromPly, branchMoves, index: analysis.index + 1 } }, false);
    }
    const game = replay(state.play.moves);
    game.move({ from, to, ...(promotion ? { promotion } : {}) });
    return transition(withPlay(state, { ...state.play, moves: positionOf(game).moves }), { viewedPly: null });
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
    started: !!restored, setup: restored ? null : { ...settings }, viewedPly: null,
    saved: loadSaved(), analysis, analysisSettings: { ...settings }, analysisLoaded: false, importing: true,
    inputs, flipped: false, preview: null, promotion: null, insight: null, error: '', request: null, revision: 0 };
  return maiaTurn(state) ? queueRequest(state) : state;
}
export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'mode': return action.mode === state.mode ? state : transition(state, { mode: action.mode, setup: state.started ? null : state.setup });
    case 'setup': return { ...state, setup: { ...(state.setup ?? state.settings), ...action.draft } };
    case 'cancel-setup': return state.started ? { ...state, setup: null } : state;
    case 'new': {
      const draft = state.setup ?? state.settings;
      const settings = { ...draft, eloUser: draft.eloMaia };
      return transition(state, { started: true, setup: null, viewedPly: null, settings, play: { id: action.id, createdAt: action.createdAt, moves: [], settings } });
    }
    // Legacy action is draft-only; settings cannot mutate an active game.
    case 'settings': return reducer(state, { type: 'setup', draft: action.settings });
    case 'analysis-settings': return transition(state, { analysisSettings: { ...state.analysisSettings, ...action.settings } }, false);
    case 'flip': return { ...state, flipped: !state.flipped };
    case 'preview': return { ...state, preview: action.uci };
    case 'import': return { ...state, importing: action.open };
    case 'takeback': {
      if (state.mode !== 'play' || !state.play.moves.length) return state;
      const game = replay(state.play.moves);
      const count = toGroundColor(game.turn()) === state.settings.userColor ? 2 : 1;
      for (let n = 0; n < count; n++) game.undo();
      return transition(withPlay(state, { ...state.play, moves: positionOf(game).moves }), { viewedPly: null });
    }
    case 'move': {
      const game = state.mode === 'play' ? replay(state.play.moves) : new Chess(currentPosition(state).fen);
      if (state.promotion || game.isGameOver() || state.mode === 'history') return state;
      if (state.mode === 'play' && (!state.started || state.viewedPly !== null || state.request || toGroundColor(game.turn()) !== state.settings.userColor)) return state;
      if (state.mode === 'analysis' && !state.analysisLoaded) return state;
      if (!game.moves({ verbose: true }).some(move => move.from === action.from && move.to === action.to)) return state;
      if (game.get(action.from)?.type === 'p' && /[18]$/.test(action.to)) return { ...state, promotion: { from: action.from, to: action.to } };
      return commitMove(state, action.from, action.to);
    }
    case 'try': return state.mode === 'analysis' && state.insight ? commitMove(state, action.uci.slice(0, 2) as Square, action.uci.slice(2, 4) as Square, action.uci[4]) : state;
    case 'promote': return state.promotion && action.piece ? commitMove(state, state.promotion.from, state.promotion.to, action.piece) : { ...state, promotion: null };
    case 'original': return transition(state, { analysis: { ...state.analysis, index: state.analysis.branchFromPly ?? state.analysis.index, branchFromPly: null, branchMoves: [] } }, false);
    case 'inputs': return { ...state, inputs: { ...state.inputs, ...action.inputs } };
    case 'load': {
      try { return transition(state, { analysis: loadLine(state.inputs.fen, state.inputs.pgn), analysisLoaded: true, importing: false }, false); }
      catch (error) { return { ...state, error: error instanceof Error ? error.message : 'Could not load this position.' }; }
    }
    case 'step': return reducer(state, { type: 'view', ply: (state.mode === 'play' ? state.viewedPly ?? state.play.moves.length : state.analysis.index) + action.delta });
    case 'view': {
      if (state.mode === 'play') {
        const ply = action.ply === null ? null : Math.max(0, Math.min(state.play.moves.length, action.ply));
        return { ...state, viewedPly: ply === state.play.moves.length ? null : ply, promotion: null };
      }
      const index = Math.max(0, Math.min(analysisLength(state.analysis), action.ply ?? analysisLength(state.analysis)));
      return index === state.analysis.index ? state : transition(state, { analysis: { ...state.analysis, index } }, false);
    }
    case 'analyze': return state.mode === 'analysis' && state.analysisLoaded && !state.request ? queueRequest({ ...state, revision: state.revision + 1, insight: null, preview: null }) : state;
    case 'saved': {
      const play = state.saved.find(game => game.id === action.id);
      return play ? transition(state, { play, settings: play.settings, started: true, setup: null, viewedPly: null, mode: 'play' }) : state;
    }
    case 'review': {
      const play = action.id ? state.saved.find(game => game.id === action.id) : state.play;
      return play ? transition(state, { mode: 'analysis', analysis: loadLine('', play.moves.join(' ')), analysisLoaded: true, importing: false }, false) : state;
    }
    case 'delete': {
      const saved = state.saved.filter(game => game.id !== action.id);
      if (state.play.id !== action.id) return { ...state, saved };
      return transition(state, { saved, started: false, setup: { ...state.settings }, viewedPly: null,
        play: { id: newId(), createdAt: new Date().toISOString(), moves: [], settings: state.settings } }, false);
    }
    case 'reply': {
      if (state.request !== action.request) return state;
      const insight: Insight = { response: action.response, fen: action.request.payload.fen, mode: state.mode };
      if (state.mode === 'analysis') return { ...state, request: null, insight };
      try {
        const game = replay(state.play.moves);
        applyUci(game, action.response.move);
        return { ...withPlay(state, { ...state.play, moves: positionOf(game).moves }), request: null, insight: null };
      } catch { return { ...state, request: null, error: 'Maia returned an illegal move.' }; }
    }
    case 'failure': return state.request === action.request ? { ...state, request: null, error: readableApiError(action.error) } : state;
  }
}
