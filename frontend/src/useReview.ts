import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { analysisLength, analysisLine, applyUci, positionOf, replay } from './domain';
import type { State } from './state';
import { ReviewCoordinator, type ReviewNode } from './reviewCoordinator';
import { reviewMove, terminalEvaluation } from './reviewMetrics';
import { getAnalysisRecords, isFreshRecord, lineHash, putAnalysisRecord, type AnalysisRecord, type RecordSettings } from './analysisRecords';

export type RecordStatus = { state: 'checking' | 'fresh' | 'stale' | 'none'; record?: AnalysisRecord };

export function useReview(state: State) {
  const [coordinator] = useState(() => new ReviewCoordinator());
  useSyncExternalStore(coordinator.subscribe, coordinator.snapshot, coordinator.snapshot);
  const active = state.mode === 'analysis' && state.analysisLoaded;
  const line = analysisLine(state.analysis, analysisLength(state.analysis));
  const lineKey = JSON.stringify([line.initialFen, line.moves]);
  const settingsKey = JSON.stringify([state.analysisSettings.eloMaia, state.analysisSettings.model]);
  const settings: RecordSettings = useMemo(() => ({ eloMaia: state.analysisSettings.eloMaia, eloUser: state.analysisSettings.eloMaia, model: state.analysisSettings.model }), [settingsKey]);
  const mainLine = state.analysis.branchFromPly === null;
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
  const hash = useMemo(() => lineHash(line.initialFen, line.moves), [lineKey]);
  const [recordStatus, setRecordStatus] = useState<RecordStatus>({ state: 'checking' });
  useEffect(() => {
    // Explored branches are ephemeral: only main lines record and restore.
    if (!active || !mainLine) { setRecordStatus({ state: 'none' }); return; }
    let cancelled = false;
    setRecordStatus({ state: 'checking' });
    getAnalysisRecords([hash]).then(
      records => {
        if (cancelled) return;
        const fresh = records.find(record => isFreshRecord(record, settings));
        if (fresh) { setRecordStatus({ state: 'fresh', record: fresh }); return; }
        const latest = records.filter(record => record.failed === 0).sort((a, b) => b.completed_at.localeCompare(a.completed_at))[0];
        setRecordStatus(latest ? { state: 'stale', record: latest } : { state: 'none' });
      },
      () => { if (!cancelled) setRecordStatus({ state: 'none' }); },
    );
    return () => { cancelled = true; };
  }, [active, mainLine, hash, settingsKey]);
  const recorded = useRef<string | null>(null);
  const progress = coordinator.progress;
  const primeKey = `${hash}|${settingsKey}`;
  const [primedKey, setPrimedKey] = useState<string | null>(null);
  useEffect(() => {
    // Auto-prime fully cached lines: reads only, so a fresh record restores
    // itself with zero inference. Partial coverage stays for an explicit,
    // user-gated batch over exactly the missing positions.
    if (!active || !mainLine || recordStatus.state !== 'fresh' || primedKey === primeKey) return;
    const controller = new AbortController();
    void coordinator.primeLine(nodes, settings, controller.signal).then(
      () => setPrimedKey(primeKey),
      () => { /* Superseded by navigation or settings change; the next key reprimes. */ },
    );
    return () => controller.abort();
  }, [active, mainLine, hash, settingsKey, recordStatus, primedKey]);
  // Coverage is counted live from memory so LRU turnover after priming shows
  // up honestly instead of freezing the prime-time number.
  const coverage = active && mainLine && primedKey === primeKey ? {
    total: nodes.length,
    covered: nodes.filter(node => coordinator.result('sf', node, settings) &&
      (terminalEvaluation(replay(node.moves, node.initialFen)) || coordinator.result('maia', node, settings))).length,
  } : null;
  useEffect(() => {
    // Record main-line batches once per outcome: failures stay visible via
    // retry (a clean retry records under its own key), restores skip when the
    // fresh record that triggered them is still current, and degraded Maia
    // answers must never masquerade as the requested model. Progress is read
    // live, not from the render closure: the suspend cleanup in this same
    // commit nulls the batch first, and a stale render-time snapshot would
    // record the previous settings' completion under the new settings.
    const live = coordinator.progress;
    if (!active || !mainLine || !live || live.running || live.canceled || live.done !== live.total) return;
    if (recordStatus.state === 'fresh' && recordStatus.record?.line_hash === hash && isFreshRecord(recordStatus.record, settings)) return;
    const key = `${hash}|${settingsKey}|${live.failed}`;
    if (recorded.current === key || coordinator.batchDegraded()) return;
    recorded.current = key;
    putAnalysisRecord(hash, settings, nodes.length, live.failed).then(
      record => { if (record.failed === 0) setRecordStatus({ state: 'fresh', record }); },
      () => { recorded.current = null; },
    );
  }, [active, mainLine, progress, hash, settingsKey, recordStatus]);
  const evaluations = nodes.map(node => coordinator.result('sf', node, settings));
  const game = replay([], line.initialFen);
  const qualities = line.moves.map((move, index) => { const quality = reviewMove(evaluations[index], evaluations[index + 1], game, move); applyUci(game, move); return quality; });
  const current = nodes[state.analysis.index];
  return { nodes, evaluations, qualities, coverage, current: evaluations[state.analysis.index], maia: active ? coordinator.result('maia', current, settings) : undefined,
    error: active ? coordinator.error('sf', current, settings) || coordinator.error('maia', current, settings) || (state.analysis.index > 0 ? coordinator.error('sf', nodes[state.analysis.index - 1], settings) : undefined) : undefined,
    progress, recordStatus, start: () => coordinator.startBatch(nodes, settings), cancel: () => coordinator.cancelBatch(), retry: () => coordinator.retry(),
    tooLong: nodes.length > 257 };
}
export type Review = ReturnType<typeof useReview>;
