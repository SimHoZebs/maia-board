import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { candidateSan, replay, START_FEN } from './domain';
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

export type PlayFeedbackStatus = 'off' | 'empty' | 'pending' | 'ready' | 'error';

export type PlayFeedback = {
  active: boolean;
  status: PlayFeedbackStatus;
  gameId: string;
  userPly: number;
  playedUci: string;
  playedSan: string;
  quality?: Quality;
  before?: Evaluation;
  after?: Evaluation;
  error?: string;
  retry: () => void;
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
  const derived = useMemo(() => {
    const userPly = lastUserPly(moves, state.settings.userColor);
    if (userPly < 0) return null;
    const played = moves[userPly];
    const beforeMoves = moves.slice(0, userPly);
    const afterMoves = moves.slice(0, userPly + 1);
    return {
      userPly, played,
      beforeNode: nodeFor(beforeMoves),
      afterNode: nodeFor(afterMoves),
      key: feedbackKey(state.play.id, userPly, played),
    };
  }, [movesKey, state.play.id, state.settings.userColor]);
  const rowKey = derived ? `${derived.key}|${settingsKey}` : null;
  useEffect(() => () => coordinator.suspend(), [coordinator]);
  useEffect(() => {
    if (!active || !derived) {
      if (!active) coordinator.suspend();
      else coordinator.clearForeground();
      return;
    }
    coordinator.foregroundSfOnly([derived.beforeNode, derived.afterNode], settings);
    return () => coordinator.clearForeground();
  }, [coordinator, active, rowKey]);
  const noop = useMemo(() => () => undefined, []);
  if (!active) {
    return { active: false, status: 'off', gameId: state.play.id, userPly: -1, playedUci: '', playedSan: '', retry: noop };
  }
  if (!derived) {
    return { active: true, status: 'empty', gameId: state.play.id, userPly: -1, playedUci: '', playedSan: '', retry: noop };
  }
  const before = coordinator.result('sf', derived.beforeNode, settings);
  const after = coordinator.result('sf', derived.afterNode, settings);
  const error = coordinator.error('sf', derived.beforeNode, settings) ?? coordinator.error('sf', derived.afterNode, settings);
  const retry = () => coordinator.retrySfOnly([derived.beforeNode, derived.afterNode], settings);
  if (before && after) {
    const game = replay(moves.slice(0, derived.userPly));
    const quality = reviewMove(before, after, game, derived.played);
    let playedSan: string;
    try {
      playedSan = replay(moves.slice(0, derived.userPly + 1)).history()[derived.userPly] ?? candidateSan(derived.beforeNode.fen, derived.played);
    } catch {
      playedSan = candidateSan(derived.beforeNode.fen, derived.played);
    }
    return { active: true, status: 'ready', gameId: state.play.id, userPly: derived.userPly,
      playedUci: derived.played, playedSan, quality, before, after, retry };
  }
  if (error) {
    return { active: true, status: 'error', gameId: state.play.id, userPly: derived.userPly,
      playedUci: derived.played, playedSan: candidateSan(derived.beforeNode.fen, derived.played), error, retry };
  }
  return { active: true, status: 'pending', gameId: state.play.id, userPly: derived.userPly,
    playedUci: derived.played, playedSan: candidateSan(derived.beforeNode.fen, derived.played),
    before, after, retry };
}
