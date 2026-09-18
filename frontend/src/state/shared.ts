import { Chess, type Square } from 'chess.js';
import { toGroundColor } from '../board-colors';
import { analysisLine, extendLine, lineRecord, oppositeColor, START_FEN, type Position } from '../domain';
import type { Evaluation } from '../reviewMetrics';
import { clampMaiaElo } from '../BoardTools';
import type { State } from './types';

// Cross-slice board mechanics shared by the play, analysis, and root
// reducers. Game data flows through here; display settings never enter.
export function currentPosition(state: State): Position & { initialFen?: string; terminal?: Evaluation | null } {
  if (state.mode === 'analysis') return analysisLine(state.analysis);
  return lineRecord(state.play.moves.slice(0, state.viewedPly ?? state.play.moves.length));
}
// Memoized per moves reference: repeated reads in one render (maiaTurn,
// queueRequest, transition) share one tip lookup instead of re-walking.
const maiaTurnMemo = new WeakMap<readonly string[], { userColor: string; resigned: boolean; result: boolean }>();
export function maiaTurn(state: State): boolean {
  if (!state.started || state.play.result === 'resigned') return false;
  const cached = maiaTurnMemo.get(state.play.moves);
  if (cached && cached.userColor === state.play.settings.userColor && !cached.resigned) return cached.result;
  // The tip record resolves history-aware terminality once per line (repetition
  // needs full history); side-to-move is position-only and safe to parse.
  const record = lineRecord(state.play.moves);
  const result = toGroundColor(new Chess(record.fen).turn()) !== state.play.settings.userColor && record.terminal === null;
  maiaTurnMemo.set(state.play.moves, { userColor: state.play.settings.userColor, resigned: false, result });
  return result;
}
type PlayRequest = NonNullable<State['request']>;
let lastQueuedRequest: { key: string; request: PlayRequest } | null = null;
export function queueRequest(state: State): State {
  const position = lineRecord(state.play.moves);
  const settings = state.play.settings;
  if (position.moves.length > 256) return { ...state, request: null, error: 'Maia inference supports at most 256 plies.' };
  const request: PlayRequest = { id: state.revision, mode: 'play', payload: {
    fen: position.fen, moves: position.moves, elo_maia: clampMaiaElo(settings.eloMaia), elo_user: clampMaiaElo(settings.eloUser), model: settings.model,
    maia_color: oppositeColor(settings.userColor), temperature: settings.temperature ?? 0,
  } };
  // Identical work must yield an identical request object: concurrent
  // renders and URL-lag flaps (navigate+dispatch leaves the URL behind, so
  // the render-phase adjustment swings back and forth) can queue several
  // same-payload requests, which would read as supersedes — dropping the
  // first flight's reply and stalling. Keying the memo on game plus payload
  // keeps one identity per logical request, so the flight guard and reply
  // matching stay sound. Different games, positions, or settings always key
  // differently (the payload carries moves and full settings).
  const key = `${state.play.id}:${JSON.stringify(request.payload)}`;
  if (lastQueuedRequest?.key === key) return { ...state, error: '', request: lastQueuedRequest.request };
  lastQueuedRequest = { key, request };
  return { ...state, error: '', request };
}
export function transition(state: State, changes: Partial<State>, resumePlay = true): State {
  const next = { ...state, ...changes, revision: state.revision + 1, request: null, promotion: null, preview: null, insight: null, error: '' };
  return resumePlay && next.mode === 'play' && maiaTurn(next) ? queueRequest(next) : next;
}
export function withPlay(state: State, play: State['play']): State {
  const existed = state.saved.some(game => game.id === play.id);
  const saved = play.moves.length || play.result === 'resigned' || existed ? [play, ...state.saved.filter(game => game.id !== play.id)] : state.saved;
  return { ...state, play, saved };
}
export function commitMove(state: State, from: Square, to: Square, promotion?: string): State {
  try {
    if (state.mode === 'analysis') {
      const { analysis } = state;
      if (analysis.branchFromPly !== null && analysis.index < analysis.branchFromPly) return { ...state, error: 'Step forward to the branching point before exploring from an earlier position.' };
      const game = new Chess(currentPosition(state).fen);
      const move = game.move({ from, to, ...(promotion ? { promotion } : {}) });
      const branchFromPly = analysis.branchFromPly ?? analysis.index;
      const branchMoves = [...analysis.branchMoves.slice(0, analysis.index - branchFromPly), `${move.from}${move.to}${move.promotion ?? ''}`];
      return transition(state, { analysis: { ...analysis, branchFromPly, branchMoves, index: analysis.index + 1 } }, false);
    }
    // Play games always start from the standard position. The base tip is
    // shared from the memo; the new tip costs its single replay inside
    // extendLine. Throws on illegal moves exactly like the replay it replaces.
    const { moves } = extendLine(state.play.moves, START_FEN, from, to, promotion);
    return transition(withPlay(state, { ...state.play, moves }), { viewedPly: null });
  } catch { return { ...state, promotion: null, error: 'That move is not legal in this position.' }; }
}
