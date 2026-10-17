import { useEffect, useRef } from 'react';
import { analysisLine, START_FEN } from '../shared/domain';
import type { State } from '../state';
import { classifyTip, tipCaptured, type SoundKind } from './moveSound';
import { playSound } from './player';

// Board sounds for committed and browsed moves. One instance mounts in the
// route shell so play and analysis share it; only the active mode can sound.
// A sound fires on a single-step move in either direction within the same
// game or analysis root (±1 ply): new games, loaded lines, takeback jumps,
// multi-step jumps, and same-ply re-renders stay silent. The sound always
// reflects the displayed position's tip (the generic knock at the start),
// so stepping back over a move re-sounds the position you arrive at. Refs
// update before playing so a StrictMode rehearsal second pass sees no change
// and cannot double-fire.

export type PlayCursor = { id: string; ply: number };
export type AnalysisCursor = { root: string; ply: number };

// Pure transition decisions (tested without React): null means silence.
// Stepping back re-sounds the arrived-at position (generic knock at ply 0).

// A checking move replays its underlying knock: quiet checks knock like
// moves, checking captures like captures. This mirrors lichess, whose
// standard set resolves `check` to silence on top of the move/capture knock.
function resolveCheck(
  kind: SoundKind | null,
  initialFen: string,
  landing: readonly string[],
): SoundKind | null {
  if (kind !== 'check') return kind;
  return tipCaptured(initialFen, landing) ? 'capture' : 'move';
}

export function playTransitionSound(
  prev: PlayCursor | null,
  id: string,
  ply: number,
  moves: readonly string[],
  resigned: boolean,
  wasResigned: boolean,
): SoundKind | null {
  if (!prev || prev.id !== id) return null;
  if (resigned && !wasResigned) return 'gameEnd';
  if (ply === prev.ply + 1 && !resigned) {
    const landing = moves.slice(0, ply);
    return resolveCheck(classifyTip(START_FEN, landing), START_FEN, landing);
  }
  if (ply === prev.ply - 1) {
    const landing = moves.slice(0, ply);
    return resolveCheck(classifyTip(START_FEN, landing), START_FEN, landing) ?? 'move';
  }
  return null;
}

export function analysisTransitionSound(
  prev: AnalysisCursor | null,
  root: string,
  ply: number,
  initialFen: string,
  displayedMoves: readonly string[],
): SoundKind | null {
  if (!prev || prev.root !== root) return null;
  if (ply === prev.ply + 1)
    return resolveCheck(classifyTip(initialFen, displayedMoves), initialFen, displayedMoves);
  // Stepping back: displayedMoves is already the arrived-at prefix.
  if (ply === prev.ply - 1)
    return (
      resolveCheck(classifyTip(initialFen, displayedMoves), initialFen, displayedMoves) ?? 'move'
    );
  return null;
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
        ? playTransitionSound(
            prevPlay.current,
            id,
            ply,
            state.play.moves,
            resigned,
            prevResigned.current,
          )
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
  }, [
    state.mode,
    state.soundEnabled,
    state.play.id,
    state.play.moves,
    state.viewedPly,
    state.play.result,
    state.analysis,
    state.analysisLoaded,
  ]);
}
