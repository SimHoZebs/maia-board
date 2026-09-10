import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { analysisLength, analysisLine, applyUci, positionOf, replay } from './domain';
import type { State } from './state';
import { ReviewCoordinator, type ReviewNode } from './reviewCoordinator';
import { reviewMove } from './reviewMetrics';

export function useReview(state: State) {
  const [coordinator] = useState(() => new ReviewCoordinator());
  useSyncExternalStore(coordinator.subscribe, coordinator.snapshot, coordinator.snapshot);
  const active = state.mode === 'analysis' && state.analysisLoaded;
  const line = analysisLine(state.analysis, analysisLength(state.analysis));
  const lineKey = JSON.stringify([line.initialFen, line.moves]);
  const settingsKey = JSON.stringify([state.analysisSettings.eloMaia, state.analysisSettings.model]);
  const settings = useMemo(() => ({ eloMaia: state.analysisSettings.eloMaia, eloUser: state.analysisSettings.eloMaia, model: state.analysisSettings.model }), [settingsKey]);
  const nodes = useMemo(() => {
    const game = replay([], line.initialFen);
    const nodes: ReviewNode[] = [{ ...positionOf(game), initialFen: line.initialFen }];
    for (const move of line.moves) { applyUci(game, move); nodes.push({ ...positionOf(game), initialFen: line.initialFen }); }
    return nodes;
  }, [lineKey, state.analysis.moves, state.analysis.branchMoves]);
  useEffect(() => { return () => coordinator.suspend(); }, [coordinator, active, lineKey, settingsKey, state.analysis.moves, state.analysis.branchMoves]);
  useEffect(() => {
    coordinator.clearForeground();
    if (!active || nodes.length > 257) return;
    const timer = setTimeout(() => coordinator.foregroundAt([nodes[state.analysis.index], ...(state.analysis.index ? [nodes[state.analysis.index - 1]] : [])], settings), 200);
    return () => { clearTimeout(timer); coordinator.clearForeground(); };
  }, [coordinator, active, nodes, state.analysis.index, settings]);
  const evaluations = nodes.map(node => coordinator.result('sf', node, settings));
  const game = replay([], line.initialFen);
  const qualities = line.moves.map((move, index) => { const quality = reviewMove(evaluations[index], evaluations[index + 1], game, move); applyUci(game, move); return quality; });
  const current = nodes[state.analysis.index];
  return { nodes, evaluations, qualities, current: evaluations[state.analysis.index], maia: active ? coordinator.result('maia', current, settings) : undefined,
    error: active ? coordinator.error('sf', current, settings) || coordinator.error('maia', current, settings) || (state.analysis.index > 0 ? coordinator.error('sf', nodes[state.analysis.index - 1], settings) : undefined) : undefined,
    progress: coordinator.progress, start: () => coordinator.startBatch(nodes, settings), cancel: () => coordinator.cancelBatch(), retry: () => coordinator.retry(),
    tooLong: nodes.length > 257 };
}
export type Review = ReturnType<typeof useReview>;
