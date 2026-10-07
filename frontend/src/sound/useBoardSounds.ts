import { useEffect, useRef } from 'react';
import { analysisLine, START_FEN } from '../shared/domain';
import type { State } from '../state';
import { classifyTip, type SoundKind } from './moveSound';
import { playSound } from './player';

// Board sounds for committed and browsed moves. One instance mounts in the
// route shell so play and analysis share it; only the active mode can sound.
// A sound fires only on a single-step advance of the same game or analysis
// root (+1 ply): new games, loaded lines, takebacks, jumps, and backwards
// steps stay silent. Refs update before playing so a StrictMode rehearsal
// second pass sees no change and cannot double-fire.

export type PlayCursor = { id: string; ply: number };
export type AnalysisCursor = { root: string; ply: number };

// Pure transition decisions (tested without React): null means silence.
export function playTransitionSound(prev: PlayCursor | null, id: string, ply: number, moves: readonly string[], resigned: boolean, wasResigned: boolean): SoundKind | null {
  if (!prev || prev.id !== id) return null;
  if (resigned && !wasResigned) return 'gameEnd';
  if (ply === prev.ply + 1 && !resigned) return classifyTip(START_FEN, moves.slice(0, ply));
  return null;
}

export function analysisTransitionSound(prev: AnalysisCursor | null, root: string, ply: number, initialFen: string, displayedMoves: readonly string[]): SoundKind | null {
  if (!prev || prev.root !== root || ply !== prev.ply + 1) return null;
  return classifyTip(initialFen, displayedMoves);
}

export function useBoardSounds(state: State): void {
  const prevPlay = useRef<PlayCursor | null>(null);
  const prevResigned = useRef(false);
  const prevAnalysis = useRef<AnalysisCursor | null>(null);

  useEffect(() => {
    if (state.mode === 'play') {
      const id = state.play.id;
      const ply = state.viewedPly ?? state.play.moves.length;
      const resigned = state.play.result === 'resigned';
      const kind = state.soundEnabled
        ? playTransitionSound(prevPlay.current, id, ply, state.play.moves, resigned, prevResigned.current)
        : null;
      prevPlay.current = { id, ply };
      prevResigned.current = resigned;
      if (kind) playSound(kind);
      return;
    }
    if (state.mode === 'analysis' && state.analysisLoaded) {
      // Branch explorations extend branchMoves, not the base line, so the
      // root excludes the branch: committing a new explored move still reads
      // as a +1 advance and sounds.
      const root = JSON.stringify([state.analysis.initialFen, state.analysis.moves]);
      const ply = state.analysis.index;
      const line = analysisLine(state.analysis, ply);
      const kind = state.soundEnabled
        ? analysisTransitionSound(prevAnalysis.current, root, ply, line.initialFen, line.moves)
        : null;
      prevAnalysis.current = { root, ply };
      if (kind) playSound(kind);
    }
  }, [state.mode, state.soundEnabled, state.play.id, state.play.moves, state.viewedPly,
    state.play.result, state.analysis, state.analysisLoaded]);
}
