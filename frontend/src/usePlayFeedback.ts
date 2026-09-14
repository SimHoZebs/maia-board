import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Chess } from 'chess.js';
import { applyUci, replay, START_FEN } from './domain';
import { ReviewCoordinator, reviewKey, subscribeNone, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
import { reviewMove, terminalEvaluation, type Evaluation, type Quality } from './reviewMetrics';
import { stockfishPolicy } from './stockfishSettings';
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

// One ply's verdict inputs. Verdicts are pure functions of (prefix line,
// before/after evals, settings), so a ply reuses its verdict exactly when all
// three still match — regardless of coordinator version bumps, LRU eviction
// and refetch (new object identity recomputes to the identical value), or
// appends/truncates elsewhere in the line. Output equality with a from-scratch
// recompute holds by construction: same function, same inputs.
type PlyVerdict = {
  before: Evaluation | undefined;
  after: Evaluation | undefined;
  needsPending: boolean;
  quality: Quality | undefined;
};

export type PlayQualitiesMemo = {
  gameId: string;
  userColor: 'white' | 'black';
  policyKey: string;
  moves: string[];
  fens: string[];
  verdicts: (PlyVerdict | undefined)[];
  qualities: (Quality | undefined)[];
};

// Test observability only: counts incremental work inside computePlayQualities
// (applyUci walk steps + reviewMove calls), mirroring lineRecordMissesForTests.
export type PlayQualitiesStats = { walks: number; reviews: number };

export function computePlayQualities(args: {
  gameId: string;
  moves: string[];
  userColor: 'white' | 'black';
  settings: ReviewSettings;
  lookup: (node: ReviewNode) => Evaluation | undefined;
  pending: Set<string>;
  prev: PlayQualitiesMemo | null;
  stats?: PlayQualitiesStats;
}): { qualities: (Quality | undefined)[]; memo: PlayQualitiesMemo } {
  const { gameId, moves, userColor, settings, lookup, pending, prev, stats } = args;
  // Elo/temperature are deliberately excluded: sf-lane verdicts depend only on
  // the Stockfish search policy, so rating tweaks reuse everything.
  const policyKey = stockfishPolicy(settings.stockfish);
  // Walk reuse is moves-content-only and version-independent: prefix fens never
  // depend on evaluations, settings, or color — only on the UCI prefix.
  let fens: string[];
  if (prev && prev.moves.length <= moves.length && prev.moves.every((uci, index) => moves[index] === uci)) {
    fens = prev.fens.slice(0, moves.length + 1);
    if (fens.length < moves.length + 1) {
      // Extension: continue walking from the cached tip.
      const game = new Chess(fens[fens.length - 1]);
      for (let ply = fens.length - 1; ply < moves.length; ply++) {
        try {
          applyUci(game, moves[ply]);
        } catch {
          break;
        }
        stats && stats.walks++;
        fens.push(game.fen());
      }
    }
  } else if (prev && moves.length <= prev.moves.length && moves.every((uci, index) => prev.moves[index] === uci)) {
    // Truncation (takeback): surviving prefixes keep their fens.
    fens = prev.fens.slice(0, moves.length + 1);
  } else {
    const game = new Chess(START_FEN);
    fens = [game.fen()];
    for (const uci of moves) {
      try {
        applyUci(game, uci);
      } catch {
        break;
      }
      stats && stats.walks++;
      fens.push(game.fen());
    }
  }
  const valid = fens.length - 1;
  const sameScope = !!prev && prev.gameId === gameId && prev.userColor === userColor && prev.policyKey === policyKey;
  const awaitingEval: Quality = { label: 'Unreviewed', accuracy: null, loss: null };
  const verdicts: (PlyVerdict | undefined)[] = [];
  const qualities: (Quality | undefined)[] = [];
  let allReused = sameScope && !!prev && prev.qualities.length === moves.length;
  moves.forEach((_, ply) => {
    if ((ply % 2 === 0) !== (userColor === 'white') || ply >= valid) {
      if (sameScope && prev!.verdicts[ply] !== undefined) allReused = false;
      verdicts.push(undefined);
      qualities.push(undefined);
      return;
    }
    const beforeNode: ReviewNode = { initialFen: START_FEN, moves: moves.slice(0, ply), fen: fens[ply] };
    const afterNode: ReviewNode = { initialFen: START_FEN, moves: moves.slice(0, ply + 1), fen: fens[ply + 1] };
    const before = lookup(beforeNode);
    const after = lookup(afterNode);
    // Same contract as analysis: the coordinator's pending set decides what
    // may still arrive. Opponent plies never enter any lane, so they stay
    // blank even mid-batch.
    const needsPending = !before || !after
      ? pending.has(reviewKey('sf', beforeNode, settings)) || pending.has(reviewKey('sf', afterNode, settings))
      : false;
    const prevVerdict = sameScope ? prev!.verdicts[ply] : undefined;
    if (prevVerdict && prevVerdict.before === before && prevVerdict.after === after && prevVerdict.needsPending === needsPending) {
      verdicts.push(prevVerdict);
      qualities.push(prevVerdict.quality);
      return;
    }
    allReused = false;
    let quality: Quality | undefined;
    if (!before || !after) {
      quality = needsPending ? awaitingEval : undefined;
    } else {
      stats && stats.reviews++;
      quality = reviewMove(before, after, new Chess(fens[ply]), moves[ply]);
    }
    verdicts.push({ before, after, needsPending, quality });
    qualities.push(quality);
  });
  const memo: PlayQualitiesMemo = {
    gameId, userColor, policyKey, moves: [...moves], fens,
    verdicts, qualities: allReused && prev ? prev.qualities : qualities,
  };
  return { qualities: memo.qualities, memo };
}

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
    // Restore from the server cache first (bounded concurrent probes,
    // tip-first), then queue only true misses for live inference. Without
    // this the single-file queue re-probes every position sequentially on
    // every page load (~400 round trips for a 133-ply game).
    const controller = new AbortController();
    let cancelled = false;
    const items: { node: ReviewNode; terminal: Evaluation | null }[] = [];
    {
      // One progressive walk for the whole line: prefix fens plus history-aware
      // terminals (repetition included) with zero replays — instead of a replay
      // per node. Terminal entries seed the cache exactly as job() would.
      const game = new Chess(START_FEN);
      const prefixes: string[][] = [[]];
      const fens: string[] = [game.fen()];
      const terminals: (Evaluation | null)[] = [terminalEvaluation(game) ?? null];
      for (const uci of moves) {
        try {
          applyUci(game, uci);
        } catch {
          break;
        }
        prefixes.push(moves.slice(0, prefixes.length));
        fens.push(game.fen());
        terminals.push(terminalEvaluation(game) ?? null);
      }
      moves.forEach((_, ply) => {
        if ((ply % 2 === 0) !== (state.settings.userColor === 'white')) return;
        if (ply + 1 >= prefixes.length) return;
        items.push(
          { node: { initialFen: START_FEN, moves: prefixes[ply], fen: fens[ply] }, terminal: terminals[ply] },
          { node: { initialFen: START_FEN, moves: prefixes[ply + 1], fen: fens[ply + 1] }, terminal: terminals[ply + 1] },
        );
      });
    }
    void coordinator.primePositions(items, settings, controller.signal).then(
      remaining => {
        if (cancelled) return;
        coordinator.syncPlayQueueResolved(remaining, settings);
      },
      () => { /* Aborted by cleanup/navigation; the next sync supersedes. */ },
    );
    return () => { cancelled = true; controller.abort(); };
  }, [coordinator, active, queuedKey, settings]);
  // Read live from the coordinator cache as evaluations settle (the
  // subscription above re-renders, turning icons on). The walk is incremental:
  // surviving prefixes reuse cached fens and verdicts, so a reply commit
  // recomputes only its new tail instead of replaying the whole line before
  // the board animation starts. The ref is read during render but written
  // post-commit, so StrictMode/concurrent double-computes are merely less
  // optimal, never wrong — reuse validity is content-derived.
  const userColor = state.settings.userColor;
  const gameId = state.play.id;
  const cacheVersion = coordinator.snapshot();
  const cacheRef = useRef<PlayQualitiesMemo | null>(null);
  const computed = useMemo(() => {
    if (!active) return null;
    return computePlayQualities({
      gameId,
      moves,
      userColor,
      settings,
      lookup: node => coordinator.result('sf', node, settings),
      pending: coordinator.sfPendingKeys(),
      prev: cacheRef.current,
    });
  }, [active, moves, settings, userColor, gameId, cacheVersion, coordinator]);
  useEffect(() => {
    cacheRef.current = computed?.memo ?? null;
  }, [computed]);
  const qualities = computed?.qualities ?? [];
  return { active, qualities };
}
