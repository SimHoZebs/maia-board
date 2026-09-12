import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { analysisLength, analysisLine, applyUci, positionOf, replay } from './domain';
import type { MaiaModel } from './api';
import type { State } from './state';
import { ReviewCoordinator, type ReviewNode } from './reviewCoordinator';
import { maiaRarity, reviewMove, terminalEvaluation } from './reviewMetrics';
import { getAnalysisRecords, isFreshRecord, lineHash, putAnalysisRecord, type AnalysisRecord, type RecordSettings } from './analysisRecords';

export type RecordStatus = { state: 'checking' | 'fresh' | 'stale' | 'none'; record?: AnalysisRecord };

// Per-position Maia identity. Changing the global rating invalidates only the
// current move (immediate clear + foreground refetch); other moves keep
// displaying their associated Elo until navigated to, at which point they
// show the stale result while the new Elo fetches, then swap.
export type MaiaIdentity = { eloMaia: number; model: MaiaModel };
export function maiaIdentityOf(settings: { eloMaia: number; model: MaiaModel }): MaiaIdentity {
  return { eloMaia: settings.eloMaia, model: settings.model };
}
export function sameMaiaIdentity(a: MaiaIdentity, b: MaiaIdentity): boolean {
  return a.eloMaia === b.eloMaia && a.model === b.model;
}

// Pure display decision, tested without React: prefer the fresh (global)
// result when present, otherwise keep the remembered per-move identity while
// its stale row still exists. Missing memory defaults to the global identity.
export function selectMaiaDisplay(params: { memory?: MaiaIdentity; global: MaiaIdentity; fresh?: unknown; stale?: unknown }):
  { identity: MaiaIdentity; useFresh: boolean } {
  const { memory, global, fresh, stale } = params;
  if (!memory || sameMaiaIdentity(memory, global)) return { identity: global, useFresh: true };
  if (fresh) return { identity: global, useFresh: true };
  if (stale) return { identity: memory, useFresh: false };
  return { identity: global, useFresh: true };
}

// Pure backfill for rating changes, tested without React: unvisited entries
// keep the previous identity, the viewed move jumps to the new one.
export function backfillMaiaMemory(prevMem: Record<number, MaiaIdentity>, prev: MaiaIdentity, next: MaiaIdentity, currentPly: number, length: number): Record<number, MaiaIdentity> {
  const out: Record<number, MaiaIdentity> = { ...prevMem };
  for (let i = 0; i < length; i++) if (!out[i]) out[i] = prev;
  out[currentPly] = next;
  return out;
}

export function useReview(state: State) {
  const [coordinator] = useState(() => new ReviewCoordinator());
  useSyncExternalStore(coordinator.subscribe, coordinator.snapshot, coordinator.snapshot);
  const active = state.mode === 'analysis' && state.analysisLoaded;
  const line = analysisLine(state.analysis, analysisLength(state.analysis));
  const lineKey = JSON.stringify([line.initialFen, line.moves]);
  const settingsKey = JSON.stringify([state.analysisSettings.eloMaia, state.analysisSettings.model, state.stockfish]);
  const settings: RecordSettings = useMemo(() => ({ eloMaia: state.analysisSettings.eloMaia, eloUser: state.analysisSettings.eloMaia, model: state.analysisSettings.model, stockfish: state.stockfish }), [settingsKey]);
  const maiaKey = JSON.stringify([state.analysisSettings.eloMaia, state.analysisSettings.model]);
  const maiaIdentity: MaiaIdentity = useMemo(() => maiaIdentityOf(state.analysisSettings), [maiaKey]);
  const currentPly = state.analysis.index;
  const [maiaMemory, setMaiaMemory] = useState<Record<number, MaiaIdentity>>({});
  const [prevMaia, setPrevMaia] = useState<MaiaIdentity>(maiaIdentity);
  // Last committed ply, for batched rating+navigate updates where the first
  // render with the new identity already carries the navigated index.
  const lastPlyRef = useRef(currentPly);
  useEffect(() => { lastPlyRef.current = currentPly; }, [currentPly]);
  const mainLine = state.analysis.branchFromPly === null;
  const nodes = useMemo(() => {
    const game = replay([], line.initialFen);
    const nodes: ReviewNode[] = [{ ...positionOf(game), initialFen: line.initialFen }];
    for (const move of line.moves) { applyUci(game, move); nodes.push({ ...positionOf(game), initialFen: line.initialFen }); }
    return nodes;
  }, [lineKey, state.analysis.moves, state.analysis.branchMoves]);
  // New content owns fresh memory: stale Elo associations from another line
  // must never leak into its headers.
  useEffect(() => { setMaiaMemory({}); }, [lineKey]);
  // Rating change invalidates the move viewed at change time. Render-phase
  // state update (not a passive effect) captures that ply: the first render
  // with the new identity backfills before any later navigation can reassign
  // the invalidation to the wrong index. Batched rating+navigate commits also
  // invalidate the pre-batch index so neither position keeps stale results.
  if (!sameMaiaIdentity(prevMaia, maiaIdentity)) {
    const atChange = lastPlyRef.current;
    setPrevMaia(maiaIdentity);
    setMaiaMemory(prevMem => {
      let next = backfillMaiaMemory(prevMem, prevMaia, maiaIdentity, currentPly, nodes.length);
      if (atChange !== currentPly && atChange >= 0 && atChange < nodes.length) next = { ...next, [atChange]: maiaIdentity };
      return next;
    });
  }
  useEffect(() => { return () => coordinator.suspend(); }, [coordinator, active, lineKey, settingsKey, state.analysis.moves, state.analysis.branchMoves]);
  useEffect(() => {
    // Mobile background freezes timers and sockets while promises stay
    // pending: the running lane would never settle and progress would stall
    // with no failure to retry. On return, re-issue jobs that straddled the
    // freeze; healthy jobs are left alone. This never starts new work (see
    // resume), so restores still never infer.
    let hiddenAt = 0;
    const shown = (fallbackMs: number) => {
      const hiddenMs = fallbackMs || (hiddenAt ? Date.now() - hiddenAt : 0);
      hiddenAt = 0;
      coordinator.resume(hiddenMs);
    };
    const onHidden = () => { hiddenAt = Date.now(); };
    const onVisibility = () => {
      if (document.hidden) onHidden();
      else shown(0);
    };
    const onShown = () => shown(0);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHidden);
    window.addEventListener('pageshow', onShown);
    window.addEventListener('focus', onShown);
    window.addEventListener('online', onShown);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHidden);
      window.removeEventListener('pageshow', onShown);
      window.removeEventListener('focus', onShown);
      window.removeEventListener('online', onShown);
    };
  }, [coordinator]);
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
    if (!active || !mainLine || !live || live.running || live.done !== live.total) return;
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
  // Additive difficulty axis: Maia probability ratio of the played move at the
  // review elo. Same batch settings for every ply, so the anchor is uniform.
  const maiaResults = nodes.map(node => coordinator.result('maia', node, settings));
  const rarities = line.moves.map((move, index) => maiaRarity(maiaResults[index], move));
  const current = nodes[currentPly];
  // Displayed Maia prefers the fresh (global) result when it exists; otherwise
  // it falls back to the remembered per-move identity so unvisited moves keep
  // their old Elo visible while the new one fetches in the background.
  const memForCurrent = maiaMemory[currentPly] ?? maiaIdentity;
  const freshForCurrent = active && current ? coordinator.result('maia', current, settings) : undefined;
  const oldSettings: RecordSettings = { ...settings, eloMaia: memForCurrent.eloMaia, eloUser: memForCurrent.eloMaia, model: memForCurrent.model };
  const staleForCurrent = !sameMaiaIdentity(memForCurrent, maiaIdentity) && !freshForCurrent && current
    ? (active ? coordinator.result('maia', current, oldSettings) : undefined)
    : undefined;
  const selection = selectMaiaDisplay({ memory: maiaMemory[currentPly], global: maiaIdentity, fresh: freshForCurrent, stale: staleForCurrent });
  const displayedIdentity = selection.useFresh ? maiaIdentity : (maiaMemory[currentPly] ?? maiaIdentity);
  const maiaForCurrent = selection.useFresh ? freshForCurrent : staleForCurrent;
  const maiaStale = !sameMaiaIdentity(displayedIdentity, maiaIdentity);
  // Once the fresh result lands (or the stale row is gone) the display already
  // reads fresh; sync memory so the next rating change backfills correctly.
  useEffect(() => {
    if (sameMaiaIdentity(displayedIdentity, maiaIdentity)) {
      setMaiaMemory(prev => {
        const cur = prev[currentPly];
        if (!cur || sameMaiaIdentity(cur, maiaIdentity)) return prev;
        return { ...prev, [currentPly]: maiaIdentity };
      });
    }
  }, [currentPly, maiaKey, displayedIdentity]);
  const startBatchAtCurrent = () => {
    setMaiaMemory(() => {
      const next: Record<number, MaiaIdentity> = {};
      for (let i = 0; i < nodes.length; i++) next[i] = maiaIdentity;
      return next;
    });
    coordinator.startBatch(nodes, settings);
  };
  return { nodes, evaluations, qualities, rarities, coverage, current: evaluations[currentPly], maia: maiaForCurrent,
    maiaElo: displayedIdentity.eloMaia, maiaModel: displayedIdentity.model,
    maiaWantedElo: maiaIdentity.eloMaia, maiaWantedModel: maiaIdentity.model, maiaStale,
    error: active ? coordinator.error('sf', current, settings) || coordinator.error('maia', current, settings) || (currentPly > 0 ? coordinator.error('sf', nodes[currentPly - 1], settings) : undefined) : undefined,
    progress, recordStatus, start: startBatchAtCurrent, retry: () => coordinator.retry(),
    tooLong: nodes.length > 257 };
}
export type Review = ReturnType<typeof useReview>;
