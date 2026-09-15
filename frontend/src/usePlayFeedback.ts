import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { buildTimeline, legalPrefixLength, lineKeyFor, START_FEN, type Timeline } from './domain';
import { ReviewCoordinator, cancelScope, createLineScope, reviewKey, reviewNodes, subscribeNone, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
import { useServerBatch } from './useServerBatch';
import { computeLineQualities, type UnifiedMemo } from './qualities';
import { effectiveQuality, maiaRarity, type Evaluation, type Quality } from './reviewMetrics';
import type { MoveResponse } from './api';
import type { State } from './state';

export type PlayFeedback = { active: boolean; qualities: (Quality | undefined)[] };
export type PlayQualitiesMemo = UnifiedMemo;
export type PlayQualitiesStats = { reviews: number };

const PRAISE_PENDING: Quality = { label: 'Unreviewed', accuracy: null, loss: null };

export function computePlayQualities(args: {
  gameId: string; timeline: Timeline; userColor: 'white' | 'black'; settings: ReviewSettings;
  sfLookup: (node: ReviewNode) => Evaluation | undefined; maiaLookup: (node: ReviewNode) => MoveResponse | undefined;
  sfPending: Set<string>; maiaPending: Set<string>; prev: PlayQualitiesMemo | null; stats?: PlayQualitiesStats;
}): { qualities: (Quality | undefined)[]; memo: PlayQualitiesMemo } {
  const { gameId, timeline, userColor, settings, sfLookup, maiaLookup, sfPending, maiaPending, prev, stats } = args;
  const nodes = reviewNodes(timeline);
  // Pass 1 stays pure-SF engine facts (memo-safe: keys never see Maia
  // identity). Pass 2 translates only engine-Critical into displayed praise;
  // everything else settles the badge on SF alone (fast path) and reads Maia
  // for its sentence only when cheap.
  const sf = computeLineQualities({ scope: `${gameId}|${userColor}`, moves: [...timeline.moves], nodes,
    evaluations: nodes.map(sfLookup), settingsForNode: () => settings,
    active: node => node.turn === userColor, pending: sfPending, prev, stats });
  // Translation map: engine facts become displayed judgments. Raw memo
  // reuse still holds underneath (proven by stats.reviews); only this
  // translated array is fresh per call.
  let changed = false;
  const qualities: (Quality | undefined)[] = sf.qualities.map((grade, index) => {
    if (grade?.label !== 'Critical') return effectiveQuality(grade, undefined);
    const node = nodes[index];
    const move = timeline.moves[index];
    const maia = node ? maiaLookup(node) : undefined;
    let next: Quality | undefined;
    if (!maia) {
      next = node && maiaPending.has(reviewKey('maia', node, settings))
        ? { ...PRAISE_PENDING }
        : effectiveQuality(grade, { label: 'Unknown', r: null, prob: null, topProb: null });
    } else {
      next = effectiveQuality(grade, maiaRarity(maia, move));
    }
    if (next !== (grade as Quality | undefined)) changed = true;
    return next;
  });
  if (!changed) return { qualities: sf.qualities as (Quality | undefined)[], memo: sf.memo };
  return { qualities, memo: sf.memo };
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
  const lineKey = useMemo(() => lineKeyFor(START_FEN, moves), [movesKey]);
  const scope = useMemo(() => createLineScope(lineKey), [lineKey]);
  useEffect(() => () => cancelScope(scope), [scope]);
  const nodes = useMemo(() => {
    const all = reviewNodes(timeline);
    const wanted = new Set<ReviewNode>();
    for (let ply = 0; ply < timeline.moves.length && ply < 256; ply++) {
      if (all[ply].turn === userColor) { wanted.add(all[ply]); wanted.add(all[ply + 1]); }
    }
    return [...wanted];
  }, [timeline, userColor]);
  // Cache restore runs independently of the batch: even when submit fails,
  // settled rows still grade through the bulk lookup. Signal-abort is the
  // only cancel path; backgrounding never aborts the batch.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void Promise.resolve(coordinator.ensure(nodes, settings, { signal: controller.signal })).catch(() => undefined);
    return () => controller.abort();
  }, [coordinator, active, nodes, settings]);
  // Live grades run as a server batch (sf + maia): each move resubmits the
  // line and the intake filter skips cached plies, so only new positions
  // compute — including ones missed while the tab was backgrounded.
  useServerBatch({ active, nodes, settings, engines: ['sf', 'maia'], coordinator, scope: active ? scope : null, auto: true });
  const previous = useRef<PlayQualitiesMemo | null>(null);
  const sfPending = coordinator.sfPendingKeys(), maiaPending = coordinator.maiaPendingKeys();
  const computed = useMemo(() => active ? computePlayQualities({ gameId, timeline, userColor, settings,
    sfLookup: node => coordinator.result('sf', node, settings), maiaLookup: node => coordinator.result('maia', node, settings),
    sfPending, maiaPending, prev: previous.current }) : null,
  [active, gameId, timeline, userColor, settings, version, coordinator]);
  useEffect(() => { previous.current = computed?.memo ?? null; }, [computed]);
  // Fast-path abort: SF-settled (both endpoints) non-best moves need no Maia
  // for their badge, so drop still-queued Maia predictions for them and free
  // the foreground Play queue. Running predictions are non-preemptive and
  // keep their sentence; the server batch may still compute them.
  useEffect(() => {
    if (!active || !computed) return;
    const keys = new Set<string>();
    const all = reviewNodes(timeline);
    for (let ply = 0; ply < timeline.moves.length && ply < 256; ply++) {
      if (all[ply].turn !== userColor) continue;
      const sf = coordinator.result('sf', all[ply], settings);
      // Badge needs both endpoints; abort only once it can settle without Maia.
      if (!sf || !coordinator.result('sf', all[ply + 1], settings) || timeline.moves[ply] === sf.best_move) continue;
      if (coordinator.result('maia', all[ply], settings)) continue;
      keys.add(reviewKey('maia', all[ply], settings));
    }
    if (keys.size) coordinator.cancelQueued('maia', keys);
  }, [active, computed, timeline, userColor, settings, version, coordinator]);
  return { active, qualities: computed?.qualities ?? [] };
}
