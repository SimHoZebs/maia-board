import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { buildTimeline, legalPrefixLength, START_FEN, type Timeline } from './domain';
import { ReviewCoordinator, reviewKey, reviewNodes, subscribeNone, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
import { useServerBatch } from './useServerBatch';
import { computeQualities, type UnifiedMemo } from './qualities';
import type { Evaluation, Quality } from './reviewMetrics';
import type { State } from './state';

export type PlayFeedback = { active: boolean; qualities: (Quality | undefined)[] };
export type PlayQualitiesMemo = UnifiedMemo;
export type PlayQualitiesStats = { reviews: number };

export function computePlayQualities(args: {
  gameId: string; timeline: Timeline; userColor: 'white' | 'black'; settings: ReviewSettings;
  lookup: (node: ReviewNode) => Evaluation | undefined; pending: Set<string>; prev: PlayQualitiesMemo | null; stats?: PlayQualitiesStats;
}): { qualities: (Quality | undefined)[]; memo: PlayQualitiesMemo } {
  const { gameId, timeline, userColor, settings, lookup, pending, prev, stats } = args;
  const nodes = reviewNodes(timeline);
  return computeQualities({ scope: `${gameId}|${userColor}`, moves: timeline.moves, nodes,
    evaluations: nodes.map(lookup), keyFor: node => reviewKey('sf', node, settings),
    active: node => node.turn === userColor, pending, prev, stats });
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
  const playSettings = state.play.settings;
  const settings: ReviewSettings = useMemo(() => ({ eloMaia: playSettings.eloMaia, eloUser: playSettings.eloUser, model: playSettings.model, stockfish: state.stockfish }), [settingsKey, playSettings.eloMaia, playSettings.eloUser, playSettings.model]);
  const userColor = playSettings.userColor;
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
  // Cache restore runs independently of the batch: even when submit fails,
  // settled rows still grade through the bulk lookup.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void Promise.resolve(coordinator.ensure(nodes, settings, { engines: ['sf'], signal: controller.signal })).catch(() => undefined);
    return () => controller.abort();
  }, [coordinator, active, nodes, settings]);
  // Live grades run as a server batch (sf only): each move resubmits the
  // line and the intake filter skips cached plies, so only new positions
  // compute — including ones missed while the tab was backgrounded.
  useServerBatch({ active, submitKey: `${gameId}|${movesKey}|${settingsKey}`, auto: true,
    nodes, settings, engines: ['sf'], coordinator });
  const previous = useRef<PlayQualitiesMemo | null>(null);
  const computed = useMemo(() => active ? computePlayQualities({ gameId, timeline, userColor, settings,
    lookup: node => coordinator.result('sf', node, settings), pending: coordinator.sfPendingKeys(), prev: previous.current }) : null,
  [active, gameId, timeline, userColor, settings, version, coordinator]);
  useEffect(() => { previous.current = computed?.memo ?? null; }, [computed]);
  return { active, qualities: computed?.qualities ?? [] };
}
