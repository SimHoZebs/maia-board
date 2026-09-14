import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Chess } from 'chess.js';
import { buildTimeline, legalPrefixLength, START_FEN, type Timeline } from './domain';
import { ReviewCoordinator, reviewKey, reviewNodes, subscribeNone, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
import { reviewMove, type Evaluation, type Quality } from './reviewMetrics';
import type { State } from './state';

export type PlayFeedback = { active: boolean; qualities: (Quality | undefined)[] };
type Verdict = { historyId: number; move: string; before?: Evaluation; after?: Evaluation; pending: boolean; quality?: Quality };
export type PlayQualitiesMemo = { gameId: string; userColor: 'white' | 'black'; verdicts: (Verdict | undefined)[]; qualities: (Quality | undefined)[] };
export type PlayQualitiesStats = { reviews: number };

export function computePlayQualities(args: {
  gameId: string; timeline: Timeline; userColor: 'white' | 'black'; settings: ReviewSettings;
  lookup: (node: ReviewNode) => Evaluation | undefined; pending: Set<string>; prev: PlayQualitiesMemo | null; stats?: PlayQualitiesStats;
}): { qualities: (Quality | undefined)[]; memo: PlayQualitiesMemo } {
  const { gameId, timeline, userColor, settings, lookup, pending, prev, stats } = args;
  const nodes = reviewNodes(timeline);
  const sameScope = prev?.gameId === gameId && prev.userColor === userColor;
  let reused = sameScope && prev.qualities.length === timeline.moves.length;
  const verdicts = timeline.moves.map((move, ply): Verdict | undefined => {
    const node = nodes[ply], next = nodes[ply + 1];
    if (node.turn !== userColor) return;
    const before = lookup(node), after = lookup(next);
    const awaiting = (!before || !after) && (pending.has(reviewKey('sf', node, settings)) || pending.has(reviewKey('sf', next, settings)));
    const old = sameScope ? prev.verdicts[ply] : undefined;
    if (old && old.historyId === node.historyId && old.move === move && old.before === before && old.after === after && old.pending === awaiting) return old;
    reused = false;
    if (before && after && stats) stats.reviews++;
    const quality = before && after ? reviewMove(before, after, new Chess(node.fen), move)
      : awaiting ? { label: 'Unreviewed' as const, accuracy: null, loss: null } : undefined;
    return { historyId: node.historyId, move, before, after, pending: awaiting, quality };
  });
  const qualities = reused ? prev!.qualities : verdicts.map(verdict => verdict?.quality);
  return { qualities, memo: { gameId, userColor, verdicts, qualities } };
}

export function usePlayFeedback(state: State): PlayFeedback {
  const [coordinator] = useState(() => new ReviewCoordinator());
  const active = state.started && state.feedback;
  const version = useSyncExternalStore(active ? coordinator.subscribe : subscribeNone, coordinator.snapshot, coordinator.snapshot);
  const moves = state.play.moves;
  const movesKey = JSON.stringify(moves);
  const timeline = useMemo(() => {
    try { return buildTimeline(START_FEN, moves); }
    catch { return buildTimeline(START_FEN, moves.slice(0, legalPrefixLength(START_FEN, moves))); }
  }, [movesKey]);
  const settingsKey = JSON.stringify(state.stockfish);
  const settings: ReviewSettings = useMemo(() => ({ eloMaia: state.settings.eloMaia, eloUser: state.settings.eloUser, model: state.settings.model, stockfish: state.stockfish }), [settingsKey, state.settings.eloMaia, state.settings.eloUser, state.settings.model]);
  const userColor = state.settings.userColor;
  const gameId = state.play.id;
  const nodes = useMemo(() => {
    const all = reviewNodes(timeline);
    const wanted = new Set<ReviewNode>();
    for (let ply = 0; ply < timeline.moves.length && ply < 256; ply++) {
      if (all[ply].turn === userColor) { wanted.add(all[ply]); wanted.add(all[ply + 1]); }
    }
    return [...wanted];
  }, [timeline, userColor]);
  useEffect(() => () => coordinator.suspend(), [coordinator, gameId, settingsKey]);
  useEffect(() => {
    if (!active) { coordinator.suspend(); return; }
    const controller = new AbortController();
    void coordinator.primePositions(nodes, settings, controller.signal).then(
      () => { if (!controller.signal.aborted) coordinator.syncPlayQueue(nodes, settings); },
      () => { if (!controller.signal.aborted) coordinator.syncPlayQueue(nodes, settings); },
    );
    return () => controller.abort();
  }, [coordinator, active, nodes, settings]);
  const previous = useRef<PlayQualitiesMemo | null>(null);
  const computed = useMemo(() => active ? computePlayQualities({ gameId, timeline, userColor, settings,
    lookup: node => coordinator.result('sf', node, settings), pending: coordinator.sfPendingKeys(), prev: previous.current }) : null,
  [active, gameId, timeline, userColor, settings, version, coordinator]);
  useEffect(() => { previous.current = computed?.memo ?? null; }, [computed]);
  return { active, qualities: computed?.qualities ?? [] };
}
