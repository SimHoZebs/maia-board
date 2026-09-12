import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { replay, START_FEN } from './domain';
import { ReviewCoordinator, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
import { reviewMove, type Evaluation, type Quality } from './reviewMetrics';
import type { State } from './state';

export function lastUserPly(moves: string[], userColor: 'white' | 'black'): number {
  for (let index = moves.length - 1; index >= 0; index--) {
    if ((index % 2 === 0) === (userColor === 'white')) return index;
  }
  return -1;
}

export function feedbackKey(gameId: string, userPly: number, played: string): string {
  return `${gameId}|${userPly}|${played}`;
}

function nodeFor(moves: string[]): ReviewNode {
  return { initialFen: START_FEN, moves, fen: replay(moves).fen() };
}

// Retrospective quality for one committed ply: undefined for the opponent's
// moves and for user moves still awaiting (or missing) evaluations, so the
// move list shows no icon until Stockfish has weighed in.
export function qualityAtPly(moves: string[], ply: number, userColor: 'white' | 'black',
  lookup: (slice: string[]) => Evaluation | undefined): Quality | undefined {
  if ((ply % 2 === 0) !== (userColor === 'white')) return undefined;
  const before = lookup(moves.slice(0, ply));
  const after = lookup(moves.slice(0, ply + 1));
  if (!before || !after) return undefined;
  return reviewMove(before, after, replay(moves.slice(0, ply)), moves[ply]);
}

export type PlayFeedback = {
  active: boolean;
  qualities: (Quality | undefined)[];
};

export function usePlayFeedback(state: State): PlayFeedback {
  const [coordinator] = useState(() => new ReviewCoordinator());
  useSyncExternalStore(coordinator.subscribe, coordinator.snapshot, coordinator.snapshot);
  const active = state.mode === 'play' && state.started && state.feedback;
  const moves = state.play.moves;
  const movesKey = JSON.stringify(moves);
  const settingsKey = JSON.stringify(state.stockfish);
  const settings: ReviewSettings = useMemo(() => ({
    eloMaia: state.settings.eloMaia, eloUser: state.settings.eloUser, model: state.settings.model, stockfish: state.stockfish,
  }), [state.settings.eloMaia, state.settings.eloUser, state.settings.model, settingsKey]);
  const latest = useMemo(() => {
    const userPly = lastUserPly(moves, state.settings.userColor);
    if (userPly < 0) return null;
    return {
      userPly, played: moves[userPly],
      beforeNode: nodeFor(moves.slice(0, userPly)),
      afterNode: nodeFor(moves.slice(0, userPly + 1)),
      key: feedbackKey(state.play.id, userPly, moves[userPly]),
    };
  }, [movesKey, state.play.id, state.settings.userColor]);
  const rowKey = latest ? `${latest.key}|${settingsKey}` : null;
  useEffect(() => () => coordinator.suspend(), [coordinator]);
  useEffect(() => {
    if (!active || !latest) {
      if (!active) coordinator.suspend();
      else coordinator.clearForeground();
      return;
    }
    coordinator.foregroundSfOnly([latest.beforeNode, latest.afterNode], settings);
    return () => coordinator.clearForeground();
  }, [coordinator, active, rowKey]);
  // Read live from the coordinator cache each render (like useReview): the
  // subscription above re-renders as evaluations settle, turning icons on.
  const lookup = (slice: string[]) => coordinator.result('sf', nodeFor(slice), settings);
  const qualities = active
    ? moves.map((_, ply) => qualityAtPly(moves, ply, state.settings.userColor, lookup))
    : [];
  return { active, qualities };
}
