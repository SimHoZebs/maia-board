import { Chess } from 'chess.js';
import { analysisLength, applyUci, loadLine, parseSquare, uciFromMove } from '../domain';
import { sameLine } from '../analysisUrl';
import { KEYS, readStorage } from '../storage';
import { currentPosition, commitMove, transition } from './shared';
import { clampMaiaElo } from '../BoardTools';
import type { Action, AnalysisSnapshot, State } from './types';

// Analysis slice: the reviewed line (cursor, branches, importer inputs) plus
// the snapshot session truth. The loaded analysis line survives refresh
// independently of the import-form inputs: the snapshot is the board, the
// inputs are the importer's text.
export function readSnapshot(): { analysis: State['analysis']; gameId?: string } | undefined {
  const stored = readStorage<Partial<AnalysisSnapshot>>(KEYS.snapshot);
  if (!stored || typeof stored.initialFen !== 'string' || !Array.isArray(stored.moves) || !stored.moves.every(move => typeof move === 'string')) return;
  let base: State['analysis'];
  try { base = loadLine(stored.initialFen, stored.moves.join(' ')); }
  catch { return; }
  if (base.moves.length !== stored.moves.length) return;
  const analysis: State['analysis'] = { ...base,
    index: typeof stored.index === 'number' ? Math.max(0, Math.min(base.moves.length, Math.floor(stored.index))) : base.moves.length,
    perspective: stored.perspective === 'white' || stored.perspective === 'black' ? stored.perspective : base.perspective,
    ownGame: stored.ownGame === true };
  return { analysis, ...(typeof stored.gameId === 'string' ? { gameId: stored.gameId } : {}) };
}
export function snapshotOf(analysis: State['analysis'], gameId?: string): AnalysisSnapshot {
  return { initialFen: analysis.initialFen, moves: analysis.moves, index: analysis.index,
    perspective: analysis.perspective, ownGame: analysis.ownGame, ...(gameId ? { gameId } : {}) };
}

export function reduceAnalysis(state: State, action: Action): State | undefined {
  switch (action.type) {
    case 'analysis-settings': return transition(state, { analysisSettings: { ...state.analysisSettings, ...action.settings,
      ...(action.settings.eloMaia === undefined ? {} : { eloMaia: clampMaiaElo(action.settings.eloMaia) }) } }, false);
    case 'explore': {
      if (state.mode !== 'analysis' || !state.analysisLoaded || state.promotion) return state;
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(action.uci)) return state;
      if (new Chess(currentPosition(state).fen).isGameOver()) return state;
      const from = parseSquare(action.uci.slice(0, 2));
      const to = parseSquare(action.uci.slice(2, 4));
      if (from === undefined || to === undefined) return state;
      return commitMove(state, from, to, action.uci[4]);
    }
    case 'explore-line': {
      // Verdict best-line button: spawn the whole PV as a branch and land on
      // its first move so the punishment is on the board; the rest stays
      // steppable. Atomic single action (not N explore dispatches) so the
      // branch lands in one commit.
      if (state.mode !== 'analysis' || !state.analysisLoaded || state.promotion) return state;
      const ucis = action.ucis;
      if (!Array.isArray(ucis) || ucis.length === 0) return state;
      if (!ucis.every(uci => typeof uci === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci))) return state;
      const { analysis } = state;
      if (analysis.branchFromPly !== null && analysis.index < analysis.branchFromPly) return { ...state, error: 'Step forward to the branching point before exploring from an earlier position.' };
      let originFen: string;
      try {
        originFen = currentPosition(state).fen;
        if (new Chess(originFen).isGameOver()) return state;
      } catch { return state; }
      // Validate the full line before committing: illegal/stale PVs surface
      // the same message as a single illegal explore, never a partial branch.
      const canonical: string[] = [];
      try {
        const game = new Chess(originFen);
        for (const uci of ucis) {
          const applied = applyUci(game, uci);
          canonical.push(uciFromMove({ from: applied.from, to: applied.to, promotion: applied.promotion }));
        }
      } catch { return { ...state, error: 'That line is not legal in this position.' }; }
      const origin = analysis.index;
      if (analysis.branchFromPly === null) {
        return transition(state, { analysis: { ...analysis, branchFromPly: origin, branchMoves: canonical, index: origin + 1 } }, false);
      }
      const prefix = analysis.branchMoves.slice(0, Math.max(0, origin - analysis.branchFromPly));
      return transition(state, { analysis: { ...analysis, branchMoves: [...prefix, ...canonical], index: origin + 1 } }, false);
    }
    case 'original': return transition(state, { analysis: { ...state.analysis, index: state.analysis.branchFromPly ?? state.analysis.index, branchFromPly: null, branchMoves: [] } }, false);
    case 'inputs': return { ...state, inputs: { ...state.inputs, ...action.inputs } };
    case 'load': {
      try { return transition(state, { analysis: loadLine(state.inputs.fen, state.inputs.pgn), analysisLoaded: true, importing: false, analysisSourceId: null }, false); }
      catch (error) { return { ...state, error: error instanceof Error ? error.message : 'Could not load this position.' }; }
    }
    case 'unload': return transition(state, { analysisLoaded: false, importing: true, analysisSourceId: null }, false);
    case 'url-line': {
      // Back/Forward (or tab link) navigation between content URLs. Same line
      // is a no-op while loaded so canonical replaces never reset the cursor
      // or branch; while unloaded the same line still loads, restoring the
      // view Forward took back to.
      if (state.mode !== 'analysis' || (state.analysisLoaded && sameLine(state.analysis, action))) return state;
      try { return transition(state, { analysis: loadLine(action.initialFen, action.moves.join(' ')), analysisLoaded: true, importing: false, analysisSourceId: null }, false); }
      catch { return state; }
    }
    case 'advance': {
      // Next-arrow semantics in analysis: stepping forward from the fork
      // continues the original line, dropping the explored branch. Notation
      // clicks keep entering the branch through 'view', so this stays a
      // separate action instead of overloading 'view'.
      if (state.mode !== 'analysis' || !state.analysisLoaded) return state;
      const { analysis } = state;
      if (analysis.branchFromPly !== null && analysis.index === analysis.branchFromPly) {
        return transition(state, { analysis: { ...analysis, branchFromPly: null, branchMoves: [], index: Math.min(analysis.branchFromPly + 1, analysis.moves.length) } }, false);
      }
      const index = Math.min(analysis.index + 1, analysisLength(analysis));
      return index === analysis.index ? state : transition(state, { analysis: { ...analysis, index } }, false);
    }
    default: return undefined;
  }
}
