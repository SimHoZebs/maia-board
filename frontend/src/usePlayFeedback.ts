import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Chess } from 'chess.js';
import { applyUci, replay, START_FEN } from './domain';
import { ReviewCoordinator, subscribeNone, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
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
  const active = state.mode === 'play' && state.started && state.feedback;
  // The inactive coordinator is suspended with nothing displayed from it, so
  // don't subscribe: analysis-side settles must not re-render the play tree
  // (and vice versa in useReview). Resubscribing on activation re-reads the
  // snapshot, so no update is missed across the switch.
  useSyncExternalStore(active ? coordinator.subscribe : subscribeNone, coordinator.snapshot, coordinator.snapshot);
  const moves = state.play.moves;
  const movesKey = JSON.stringify(moves);
  const settingsKey = JSON.stringify(state.stockfish);
  const settings: ReviewSettings = useMemo(() => ({
    eloMaia: state.settings.eloMaia, eloUser: state.settings.eloUser, model: state.settings.model, stockfish: state.stockfish,
  }), [state.settings.eloMaia, state.settings.eloUser, state.settings.model, settingsKey]);
  // Every committed user ply needs its before/after pair evaluated, not just
  // the latest: requesting only the tip aborts the running eval on fast play
  // and the superseded move never gets an icon. Sync the full line in ply
  // order into the coordinator's FIFO queue; reconciliation prunes takebacks
  // and policy changes without ever aborting the running search.
  const queuedKey = `${state.play.id}|${movesKey}|${state.settings.userColor}|${settingsKey}`;
  useEffect(() => () => coordinator.suspend(), [coordinator]);
  useEffect(() => {
    if (!active) {
      coordinator.suspend();
      return;
    }
    const nodes: ReviewNode[] = [];
    moves.forEach((_, ply) => {
      if ((ply % 2 === 0) !== (state.settings.userColor === 'white')) return;
      nodes.push(nodeFor(moves.slice(0, ply)), nodeFor(moves.slice(0, ply + 1)));
    });
    coordinator.syncPlayQueue(nodes, settings);
  }, [coordinator, active, queuedKey, settings]);
  // Read live from the coordinator cache as evaluations settle (the
  // subscription above re-renders, turning icons on). One incremental pass,
  // memoized: the game is replayed once with every prefix position captured,
  // instead of replaying from move 0 separately per ply per render
  // (quadratic in game length). Recomputes only when the moves, settings,
  // user color, or cache contents change; unrelated renders reuse it.
  const userColor = state.settings.userColor;
  const cacheVersion = coordinator.snapshot();
  const qualities = useMemo(() => {
    if (!active) return [];
    const game = new Chess(START_FEN);
    const prefixes: string[][] = [[]];
    const fens: string[] = [game.fen()];
    for (const uci of moves) {
      try {
        applyUci(game, uci);
      } catch {
        break;
      }
      prefixes.push(moves.slice(0, prefixes.length));
      fens.push(game.fen());
    }
    const valid = fens.length - 1;
    const node = (ply: number): ReviewNode => ({ initialFen: START_FEN, moves: prefixes[ply], fen: fens[ply] });
    return moves.map((_, ply) => {
      if ((ply % 2 === 0) !== (userColor === 'white') || ply >= valid) return undefined;
      const before = coordinator.result('sf', node(ply), settings);
      const after = coordinator.result('sf', node(ply + 1), settings);
      if (!before || !after) return undefined;
      return reviewMove(before, after, new Chess(fens[ply]), moves[ply]);
    });
  }, [active, moves, settings, userColor, cacheVersion, coordinator]);
  return { active, qualities };
}
