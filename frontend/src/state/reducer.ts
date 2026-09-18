import { Chess } from 'chess.js';
import { toGroundColor } from '../board-colors';
import { analysisLength, lineRecord, loadLine, newId, type Analysis, type Mode, type Settings } from '../domain';
import { sameLine, type UrlLine } from '../analysisUrl';
import { KEYS, loadSettings, readStorage } from '../storage';
import { mergeSync } from '../serverGames';
import { readGameRepository } from '../gameRepository';
import { currentPosition, commitMove, maiaTurn, queueRequest, transition } from './shared';
import { initialDisplayState } from './display';
import { newPlayDraft } from './play';
import { readSnapshot } from './analysis';
import { reduceDisplay } from './display';
import { reducePlay } from './play';
import { reduceAnalysis } from './analysis';
import type { Action, State } from './types';

const sameSettings = (a: Settings, b: Settings) => a.userColor === b.userColor && a.model === b.model
  && a.eloMaia === b.eloMaia && a.eloUser === b.eloUser && (a.temperature ?? 0) === (b.temperature ?? 0);

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
    ...initialDisplayState(),
    inputs, flipped: false, preview: null, promotion: null, insight: null, error: '', request: null, revision: 0 };
  return mode === 'play' && maiaTurn(state) ? queueRequest(state) : state;
}

// Root reducer: spanning navigation (mode/move/promote/view/step), cross-line
// transfers (review/saved-current/delete), and server sync. The `sync`-case
// merge and the snapshot-vs-v2 session truth stay exactly as-is; this composes
// the slices above and owns only what touches more than one of them.
function reduceRoot(state: State, action: Action): State | undefined {
  switch (action.type) {
    case 'mode': return action.mode === state.mode ? state : transition(state, { mode: action.mode, setup: state.started ? null : state.setup });
    case 'move': {
      // History-aware terminality comes from the shared tip record (repetition
      // needs full history); the legality scan below is position-only.
      const playRecord = state.mode === 'play' ? lineRecord(state.play.moves) : null;
      const game = playRecord ? new Chess(playRecord.fen) : new Chess(currentPosition(state).fen);
      if (state.promotion || (playRecord ? playRecord.terminal !== null : game.isGameOver()) || (state.mode !== 'play' && state.mode !== 'analysis')) return state;
      if (state.mode === 'play' && (!state.started || state.play.result === 'resigned' || state.viewedPly !== null || state.request || toGroundColor(game.turn()) !== state.play.settings.userColor)) return state;
      if (state.mode === 'analysis' && !state.analysisLoaded) return state;
      if (!game.moves({ square: action.from, verbose: true }).some(move => move.to === action.to)) return state;
      if (game.get(action.from)?.type === 'p' && /[18]$/.test(action.to)) return { ...state, promotion: { from: action.from, to: action.to } };
      return commitMove(state, action.from, action.to);
    }
    case 'promote': return state.promotion && action.piece ? commitMove(state, state.promotion.from, state.promotion.to, action.piece) : { ...state, promotion: null };
    case 'view': {
      if (state.mode !== 'play' && state.mode !== 'analysis') return state;
      if (state.mode === 'play') {
        const ply = action.ply === null ? null : Math.max(0, Math.min(state.play.moves.length, action.ply));
        return { ...state, viewedPly: ply === state.play.moves.length ? null : ply, promotion: null };
      }
      const index = Math.max(0, Math.min(analysisLength(state.analysis), action.ply ?? analysisLength(state.analysis)));
      return index === state.analysis.index ? state : transition(state, { analysis: { ...state.analysis, index } }, false);
    }
    case 'step': return reducer(state, { type: 'view', ply: (state.mode === 'play' ? state.viewedPly ?? state.play.moves.length : state.analysis.index) + action.delta });
    case 'review': {
      const play = action.id ? state.saved.find(game => game.id === action.id) : state.play;
      if (!play) return state;
      let analysis: Analysis;
      try { analysis = loadLine('', play.moves.join(' ')); }
      catch { return { ...state, error: 'Could not load this game.' }; }
      // Analysis defaults to the Elo the game was played at, so the first
      // review reuses play-time Maia compute instead of re-inferring at a
      // stale global rating. Changing the rating later only affects the
      // user's own moves (see useReviewPipeline); Maia's moves stay pinned. The
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
    default: return undefined;
  }
}

export function reducer(state: State, action: Action): State {
  return reduceDisplay(state, action) ?? reducePlay(state, action) ?? reduceAnalysis(state, action) ?? reduceRoot(state, action) ?? state;
}
