import { Chess, type Square } from 'chess.js';
import { type MaiaColor, type MoveRequest, type MoveResponse, readableApiError } from './api';
import { toGroundColor } from './board-colors';
import { analysisLength, analysisLine, defaultSettings, extendLine, lineRecord, loadLine, newId, oppositeColor, retreatLine, START_FEN,
  type Analysis, type Insight, type Mode, type Position, type Settings, type StoredGame } from './domain';
import type { Evaluation } from './reviewMetrics';
import { sameLine, type UrlLine } from './analysisUrl';
import { KEYS, loadSettings, readStorage } from './storage';
import { mergeSync, type OutboxOp } from './serverGames';
import { readGameRepository } from './gameRepository';
import { normalizeStockfishSettings, STOCKFISH_STORAGE_KEY, type StockfishSettings } from './stockfishSettings';
import type { BadgeLoading } from './ReviewCharts';

export function normalizeBadgeLoading(stored: unknown): BadgeLoading {
  return stored === 'shimmer' || stored === 'placeholder' ? stored : 'reel';
}

// Inside-squares coordinates are the default: outside labels use fixed-px
// offsets that drift against fluid square sizes, while on-squares labels are
// proportional and stay aligned at any viewport.
export function normalizeCoordinatesOnSquares(stored: unknown): boolean {
  return stored === false ? false : true;
}

type Request = { id: number; mode: 'play'; payload: MoveRequest };
export type Draft = Pick<Settings, 'eloMaia' | 'model'> & { userColor: 'white' | 'black' | 'random' };
export type PlayDraft = Draft & Pick<Settings, 'temperature'>;
const newPlayDraft = (settings: Settings): PlayDraft => ({ ...settings, temperature: defaultSettings.temperature });
const sameSettings = (a: Settings, b: Settings) => a.userColor === b.userColor && a.model === b.model
  && a.eloMaia === b.eloMaia && a.eloUser === b.eloUser && (a.temperature ?? 0) === (b.temperature ?? 0);
export type State = {
  mode: Mode; play: StoredGame; saved: StoredGame[];
  started: boolean; setup: PlayDraft | null; viewedPly: number | null; stockfish: StockfishSettings; feedback: boolean; badgeLoading: BadgeLoading; coordinatesOnSquares: boolean;
  analysis: Analysis; analysisSettings: Draft; analysisLoaded: boolean; importing: boolean; analysisSourceId: string | null;
  inputs: { fen: string; pgn: string }; flipped: boolean; preview: string | null;
  promotion: { from: Square; to: Square } | null;
  insight: Insight | null; error: string; request: Request | null; revision: number;
};
export type Action =
  | { type: 'mode'; mode: Mode }
  | { type: 'setup'; draft?: Partial<PlayDraft> } | { type: 'cancel-setup' }
  | { type: 'stockfish-settings'; settings: Partial<StockfishSettings> }
  | { type: 'feedback'; enabled: boolean }
  | { type: 'badge-loading'; loading: BadgeLoading }
  | { type: 'coordinates-on-squares'; enabled: boolean }
  | { type: 'new'; id: string; createdAt: string; resolvedColor?: 'white' | 'black' }
  | { type: 'analysis-settings'; settings: Partial<Draft> }
  | { type: 'takeback' } | { type: 'resign' } | { type: 'flip' }
  | { type: 'move'; from: Square; to: Square }
  | { type: 'explore'; uci: string }
  | { type: 'preview'; uci: string | null } | { type: 'original' }
  | { type: 'promote'; piece: string | null }
  | { type: 'inputs'; inputs: Partial<State['inputs']> }
  | { type: 'load' } | { type: 'unload' } | { type: 'url-line'; initialFen: string; moves: string[] } | { type: 'step'; delta: number } | { type: 'view'; ply: number | null }
  | { type: 'saved'; id: string } | { type: 'review'; id?: string } | { type: 'delete'; id: string }
  | { type: 'reply'; request: Request; response: MoveResponse }
  | { type: 'failure'; request: Request; error: unknown }
  | { type: 'retry' }
  | { type: 'sync'; saved: StoredGame[]; currentId: string | null; total: number | null; pending: OutboxOp[] };

export function currentPosition(state: State): Position & { initialFen?: string; terminal?: Evaluation | null } {
  if (state.mode === 'analysis') return analysisLine(state.analysis);
  return lineRecord(state.play.moves.slice(0, state.viewedPly ?? state.play.moves.length));
}
export function maiaTurn(state: State): boolean {
  if (!state.started || state.play.result === 'resigned') return false;
  // The tip record resolves history-aware terminality once per line (repetition
  // needs full history); side-to-move is position-only and safe to parse.
  const record = lineRecord(state.play.moves);
  return toGroundColor(new Chess(record.fen).turn()) !== state.play.settings.userColor && record.terminal === null;
}
function queueRequest(state: State): State {
  const position = lineRecord(state.play.moves);
  const settings = state.play.settings;
  if (position.moves.length > 256) return { ...state, request: null, error: 'Maia inference supports at most 256 plies.' };
  return { ...state, error: '', request: { id: state.revision, mode: 'play', payload: {
    fen: position.fen, moves: position.moves, elo_maia: settings.eloMaia, elo_user: settings.eloUser, model: settings.model,
    maia_color: oppositeColor(settings.userColor), temperature: settings.temperature ?? 0,
  } } };
}
function transition(state: State, changes: Partial<State>, resumePlay = true): State {
  const next = { ...state, ...changes, revision: state.revision + 1, request: null, promotion: null, preview: null, insight: null, error: '' };
  return resumePlay && next.mode === 'play' && maiaTurn(next) ? queueRequest(next) : next;
}
function withPlay(state: State, play: StoredGame): State {
  const existed = state.saved.some(game => game.id === play.id);
  const saved = play.moves.length || play.result === 'resigned' || existed ? [play, ...state.saved.filter(game => game.id !== play.id)] : state.saved;
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
    // Play games always start from the standard position. The base tip is
    // shared from the memo; the new tip costs its single replay inside
    // extendLine. Throws on illegal moves exactly like the replay it replaces.
    const { moves } = extendLine(state.play.moves, START_FEN, from, to, promotion);
    return transition(withPlay(state, { ...state.play, moves }), { viewedPly: null });
  } catch { return { ...state, promotion: null, error: 'That move is not legal in this position.' }; }
}
export type AnalysisSnapshot = { initialFen: string; moves: string[]; index: number; perspective: MaiaColor; ownGame: boolean; gameId?: string };
// The loaded analysis line survives refresh independently of the import-form
// inputs: the snapshot is the board, the inputs are the importer's text.
// Typing without loading never overwrites it, so boot precedence needs no
// rule.
export function readSnapshot(): { analysis: Analysis; gameId?: string } | undefined {
  const stored = readStorage<Partial<AnalysisSnapshot>>(KEYS.snapshot);
  if (!stored || typeof stored.initialFen !== 'string' || !Array.isArray(stored.moves) || !stored.moves.every(move => typeof move === 'string')) return;
  let base: Analysis;
  try { base = loadLine(stored.initialFen, stored.moves.join(' ')); }
  catch { return; }
  if (base.moves.length !== stored.moves.length) return;
  const analysis: Analysis = { ...base,
    index: typeof stored.index === 'number' ? Math.max(0, Math.min(base.moves.length, Math.floor(stored.index))) : base.moves.length,
    perspective: stored.perspective === 'white' || stored.perspective === 'black' ? stored.perspective : base.perspective,
    ownGame: stored.ownGame === true };
  return { analysis, ...(typeof stored.gameId === 'string' ? { gameId: stored.gameId } : {}) };
}
export function snapshotOf(analysis: Analysis, gameId?: string): AnalysisSnapshot {
  return { initialFen: analysis.initialFen, moves: analysis.moves, index: analysis.index,
    perspective: analysis.perspective, ownGame: analysis.ownGame, ...(gameId ? { gameId } : {}) };
}
export function initialState(mode: Mode = 'play', urlLine?: UrlLine, repository = readGameRepository()): State {
  const restored = repository.games.find(game => game.id === repository.currentId);
  const settings = restored?.settings ?? loadSettings();
  const stored = readStorage<Partial<State['inputs']>>(KEYS.analysis);
  const inputs = { fen: typeof stored?.fen === 'string' ? stored.fen : '', pgn: typeof stored?.pgn === 'string' ? stored.pgn : '' };
  const snapshot = readSnapshot();
  let analysis = loadLine();
  let analysisLoaded = false;
  let analysisSourceId: string | null = snapshot?.gameId ?? null;
  if (mode === 'analysis' && urlLine) {
    try {
      const linked = loadLine(urlLine.initialFen, urlLine.moves.join(' '));
      if (snapshot && sameLine(snapshot.analysis, linked)) {
        // Shared link to the already-restored line: keep the snapshot's
        // cursor, branch origin, and perspective across refresh.
        analysis = snapshot.analysis;
        analysisLoaded = true;
      } else {
        analysis = linked;
        analysisLoaded = true;
        analysisSourceId = null;
      }
    } catch { /* Fall through to snapshot/inputs below. */ }
  }
  if (!analysisLoaded) {
    if (snapshot) {
      analysis = snapshot.analysis;
      analysisLoaded = true;
    } else {
      try { analysis = loadLine(inputs.fen, inputs.pgn); } catch { /* Keep editable invalid input for correction. */ }
    }
  }
  const state: State = { mode, play: restored ?? { id: newId(), createdAt: new Date().toISOString(), moves: [], settings },
    started: !!restored, setup: restored ? null : newPlayDraft(settings), viewedPly: null,
    saved: repository.games, analysis, analysisSettings: { eloMaia: settings.eloMaia, model: settings.model, userColor: settings.userColor }, analysisLoaded, importing: !analysisLoaded, analysisSourceId,
    stockfish: normalizeStockfishSettings(readStorage(STOCKFISH_STORAGE_KEY)), feedback: readStorage<boolean>(KEYS.feedback) === true, badgeLoading: normalizeBadgeLoading(readStorage<unknown>(KEYS.badgeLoading)), coordinatesOnSquares: normalizeCoordinatesOnSquares(readStorage<unknown>(KEYS.coordinatesOnSquares)),
    inputs, flipped: false, preview: null, promotion: null, insight: null, error: '', request: null, revision: 0 };
  return mode === 'play' && maiaTurn(state) ? queueRequest(state) : state;
}
export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'mode': return action.mode === state.mode ? state : transition(state, { mode: action.mode, setup: state.started ? null : state.setup });
    case 'stockfish-settings': return { ...state, stockfish: normalizeStockfishSettings({ ...state.stockfish, ...action.settings }) };
    case 'feedback': return state.feedback === action.enabled ? state : { ...state, feedback: action.enabled };
    case 'badge-loading': return state.badgeLoading === action.loading ? state : { ...state, badgeLoading: action.loading };
    case 'coordinates-on-squares': return state.coordinatesOnSquares === action.enabled ? state : { ...state, coordinatesOnSquares: action.enabled };
    case 'setup': return { ...state, setup: { ...(state.setup ?? newPlayDraft(state.play.settings)), ...action.draft } };
    case 'cancel-setup': return state.started ? { ...state, setup: null } : state;
    case 'new': {
      const draft = state.setup ?? newPlayDraft(state.play.settings);
      if (draft.userColor === 'random' && !action.resolvedColor) return state;
      const settings: Settings = { ...draft, userColor: action.resolvedColor ?? (draft.userColor === 'black' ? 'black' : 'white'), eloUser: draft.eloMaia };
      return transition(state, { started: true, setup: null, viewedPly: null, play: { id: action.id, createdAt: action.createdAt, moves: [], settings } });
    }
    case 'analysis-settings': return transition(state, { analysisSettings: { ...state.analysisSettings, ...action.settings } }, false);
    case 'flip': return { ...state, flipped: !state.flipped };
    case 'preview': return { ...state, preview: action.uci };
    case 'unload': return transition(state, { analysisLoaded: false, importing: true, analysisSourceId: null }, false);
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
    case 'move': {
      // History-aware terminality comes from the shared tip record (repetition
      // needs full history); the legality scan below is position-only.
      const playRecord = state.mode === 'play' ? lineRecord(state.play.moves) : null;
      const game = playRecord ? new Chess(playRecord.fen) : new Chess(currentPosition(state).fen);
      if (state.promotion || (playRecord ? playRecord.terminal !== null : game.isGameOver()) || (state.mode !== 'play' && state.mode !== 'analysis')) return state;
      if (state.mode === 'play' && (!state.started || state.play.result === 'resigned' || state.viewedPly !== null || state.request || toGroundColor(game.turn()) !== state.play.settings.userColor)) return state;
      if (state.mode === 'analysis' && !state.analysisLoaded) return state;
      if (!game.moves({ verbose: true }).some(move => move.from === action.from && move.to === action.to)) return state;
      if (game.get(action.from)?.type === 'p' && /[18]$/.test(action.to)) return { ...state, promotion: { from: action.from, to: action.to } };
      return commitMove(state, action.from, action.to);
    }
    case 'promote': return state.promotion && action.piece ? commitMove(state, state.promotion.from, state.promotion.to, action.piece) : { ...state, promotion: null };
    case 'explore': {
      if (state.mode !== 'analysis' || !state.analysisLoaded || state.promotion) return state;
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(action.uci)) return state;
      if (new Chess(currentPosition(state).fen).isGameOver()) return state;
      return commitMove(state, action.uci.slice(0, 2) as Square, action.uci.slice(2, 4) as Square, action.uci[4]);
    }
    case 'original': return transition(state, { analysis: { ...state.analysis, index: state.analysis.branchFromPly ?? state.analysis.index, branchFromPly: null, branchMoves: [] } }, false);
    case 'inputs': return { ...state, inputs: { ...state.inputs, ...action.inputs } };
    case 'load': {
      try { return transition(state, { analysis: loadLine(state.inputs.fen, state.inputs.pgn), analysisLoaded: true, importing: false, analysisSourceId: null }, false); }
      catch (error) { return { ...state, error: error instanceof Error ? error.message : 'Could not load this position.' }; }
    }
    case 'url-line': {
      // Back/Forward (or tab link) navigation between content URLs. Same line
      // is a no-op while loaded so canonical replaces never reset the cursor
      // or branch; while unloaded the same line still loads, restoring the
      // view Forward took back to.
      if (state.mode !== 'analysis' || (state.analysisLoaded && sameLine(state.analysis, action))) return state;
      try { return transition(state, { analysis: loadLine(action.initialFen, action.moves.join(' ')), analysisLoaded: true, importing: false, analysisSourceId: null }, false); }
      catch { return state; }
    }
    case 'step': return reducer(state, { type: 'view', ply: (state.mode === 'play' ? state.viewedPly ?? state.play.moves.length : state.analysis.index) + action.delta });
    case 'view': {
      if (state.mode !== 'play' && state.mode !== 'analysis') return state;
      if (state.mode === 'play') {
        const ply = action.ply === null ? null : Math.max(0, Math.min(state.play.moves.length, action.ply));
        return { ...state, viewedPly: ply === state.play.moves.length ? null : ply, promotion: null };
      }
      const index = Math.max(0, Math.min(analysisLength(state.analysis), action.ply ?? analysisLength(state.analysis)));
      return index === state.analysis.index ? state : transition(state, { analysis: { ...state.analysis, index } }, false);
    }
    case 'saved': {
      const play = state.saved.find(game => game.id === action.id);
      return play ? transition(state, { play, started: true, setup: null, viewedPly: null, mode: 'play' }) : state;
    }
    case 'review': {
      const play = action.id ? state.saved.find(game => game.id === action.id) : state.play;
      if (!play) return state;
      let analysis: Analysis;
      try { analysis = loadLine('', play.moves.join(' ')); }
      catch { return { ...state, error: 'Could not load this game.' }; }
      // Analysis defaults to the Elo the game was played at, so the first
      // review reuses play-time Maia compute instead of re-inferring at a
      // stale global rating. Changing the rating later only affects the
      // user's own moves (see useReview); Maia's moves stay pinned. The
      // source id is always the game id (not null) so the pinned Elo survives
      // starting a new game while the analysis stays open.
      return transition(state, { mode: 'analysis', analysis: { ...analysis, perspective: play.settings.userColor, ownGame: true }, analysisLoaded: true, importing: false, analysisSourceId: action.id ?? play.id,
        analysisSettings: { ...state.analysisSettings, eloMaia: play.settings.eloMaia, model: play.settings.model } }, false);
    }
    case 'delete': {
      const saved = state.saved.filter(game => game.id !== action.id);
      const analysisSourceId = state.analysisSourceId === action.id ? null : state.analysisSourceId;
      const analysisLoaded = state.analysisSourceId === action.id ? false : state.analysisLoaded;
      if (state.play.id !== action.id) return { ...state, saved, analysisSourceId, analysisLoaded };
      return transition(state, { saved, analysisSourceId, analysisLoaded, started: false, setup: newPlayDraft(state.play.settings), viewedPly: null,
        play: { id: `${state.play.id}:deleted:${state.revision + 1}`, createdAt: state.play.createdAt, moves: [], settings: state.play.settings } }, false);
    }
    case 'sync': {
      const rows = new Map(state.saved.map(game => [game.id, game]));
      for (const game of action.saved) rows.set(game.id, game);
      const merged = mergeSync([...rows.values()], action.currentId, action.pending);
      // Display counts (pending, total, errors) live in the HistorySyncStore,
      // updated by the effect that dispatches this action — the reducer owns
      // only game data, so sync display updates never re-render the board.
      const base = { ...state, saved: merged.saved };
      const deletedPlay = action.pending.some(op => op.op === 'delete' && op.id === state.play.id);
      if (!deletedPlay && merged.currentId === null && action.saved.length === 0 && state.started) {
        // An empty partial history does not retire a cache-seeded live game.
        return base;
      }
      const current = merged.saved.find(game => game.id === merged.currentId);
      if (!current) {
        if (!state.started) return base;
        return transition(base, { started: false, setup: newPlayDraft(base.play.settings), viewedPly: null,
          play: { id: `${state.play.id}:empty:${state.revision + 1}`, createdAt: state.play.createdAt, moves: [], settings: base.play.settings } }, false);
      }
      if (current.id === state.play.id && current.moves.join(',') === state.play.moves.join(',') && current.result === state.play.result && sameSettings(current.settings, state.play.settings)) {
        // Same tip with inference already running: keep the request, no duplicate.
        return { ...base, started: true };
      }
      return transition(base, { play: current, started: true, setup: null, viewedPly: null });
    }
    case 'reply': {
      if (!state.request || state.request !== action.request) return state;
      try {
        const uci = action.response.move;
        const { moves } = extendLine(state.play.moves, START_FEN, uci.slice(0, 2) as Square, uci.slice(2, 4) as Square, uci[4]);
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
  }
}
