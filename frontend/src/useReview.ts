import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Chess } from 'chess.js';
import { applyUci, positionOf, replay } from './domain';
import type { MaiaModel } from './api';
import type { State } from './state';
import { ReviewCoordinator, reviewKey, subscribeNone, type ReviewNode } from './reviewCoordinator';
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
// keep the previous identity, the displayed move jumps to the new one.
export function backfillMaiaMemory(prevMem: Record<number, MaiaIdentity>, prev: MaiaIdentity, next: MaiaIdentity, focusPly: number, length: number): Record<number, MaiaIdentity> {
  const out: Record<number, MaiaIdentity> = { ...prevMem };
  for (let i = 0; i < length; i++) if (!out[i]) out[i] = prev;
  out[focusPly] = next;
  return out;
}

// Pure side classification, tested without React: in an own-game main line,
// positions where the side to move is not the user's are Maia's moves and stay
// pinned to the game Elo. Terminals are never Maia positions (no Maia row
// exists for them) so the rating stays adjustable there. Everything else
// (non-own lines, branches) is adjustable.
export function isMaiaPosition(node: Pick<ReviewNode, 'fen' | 'moves' | 'initialFen'>, userColor: 'white' | 'black', ownGame: boolean): boolean {
  if (!ownGame) return false;
  try {
    if (terminalEvaluation(replay(node.moves, node.initialFen))) return false;
    return (new Chess(node.fen).turn() === 'w' ? 'white' : 'black') !== userColor;
  } catch { return false; }
}

export function useReview(state: State) {
  const [coordinator] = useState(() => new ReviewCoordinator());
  const active = state.mode === 'analysis' && state.analysisLoaded;
  // Unsubscribed while inactive (see subscribeNone): the suspended analysis
  // coordinator's settles must not re-render the play tree. Index-independent
  // memos below still read the cache synchronously during render, so nothing
  // displayed goes stale; resubscribing on activation re-reads the snapshot.
  useSyncExternalStore(active ? coordinator.subscribe : subscribeNone, coordinator.snapshot, coordinator.snapshot);
  // Line identity without replaying: only the normalized start and the merged
  // move list feed the key and the node timeline below. The full position
  // used to come along for the ride (two extra history walks per render);
  // nothing reads it, so it is no longer built here.
  const lineMoves = state.analysis.branchFromPly === null ? state.analysis.moves : [...state.analysis.moves.slice(0, state.analysis.branchFromPly), ...state.analysis.branchMoves];
  const line = { initialFen: new Chess(state.analysis.initialFen).fen(), moves: lineMoves };
  const lineKey = JSON.stringify([line.initialFen, line.moves]);
  const settingsKey = JSON.stringify([state.analysisSettings.eloMaia, state.analysisSettings.model, state.stockfish]);
  const settings: RecordSettings = useMemo(() => ({ eloMaia: state.analysisSettings.eloMaia, eloUser: state.analysisSettings.eloMaia, model: state.analysisSettings.model, stockfish: state.stockfish }), [settingsKey]);
  const maiaKey = JSON.stringify([state.analysisSettings.eloMaia, state.analysisSettings.model]);
  const maiaIdentity: MaiaIdentity = useMemo(() => maiaIdentityOf(state.analysisSettings), [maiaKey]);
  const currentPly = state.analysis.index;
  const mainLine = state.analysis.branchFromPly === null;
  // Own-game pinning: Maia's moves stay at the game Elo/model while the
  // user's moves follow the adjustable analysis rating. Non-own lines (pasted
  // PGN/FEN) and explored branches stay fully adjustable.
  const ownGame = state.analysis.ownGame && mainLine;
  const gameForLine = ownGame
    ? (state.analysisSourceId
      ? (state.saved.find(game => game.id === state.analysisSourceId)
        ?? (state.play.id === state.analysisSourceId ? state.play : null))
      : state.play)
    : null;
  const pinnedKey = gameForLine ? JSON.stringify([gameForLine.settings.eloMaia, gameForLine.settings.eloUser, gameForLine.settings.model, gameForLine.settings.userColor]) : '';
  const pinnedSettings: RecordSettings | null = useMemo(() => gameForLine
    ? { eloMaia: gameForLine.settings.eloMaia, eloUser: gameForLine.settings.eloUser, model: gameForLine.settings.model, stockfish: state.stockfish }
    : null, [pinnedKey, settingsKey]);
  const pinnedIdentity: MaiaIdentity | null = useMemo(() => gameForLine
    ? { eloMaia: gameForLine.settings.eloMaia, model: gameForLine.settings.model }
    : null, [pinnedKey]);
  const combinedKey = `${settingsKey}|${pinnedKey}|${ownGame ? 1 : 0}`;
  const userColorForLine = gameForLine?.settings.userColor;
  const isMaiaNode = (node: ReviewNode): boolean => {
    if (!ownGame || !userColorForLine) return false;
    return isMaiaPosition(node, userColorForLine, ownGame);
  };
  const settingsForNode = useMemo(() => {
    if (!pinnedSettings) return (_node: ReviewNode) => settings;
    return (node: ReviewNode) => (isMaiaNode(node) ? pinnedSettings : settings);
  }, [settings, pinnedSettings, pinnedKey, ownGame, userColorForLine]);
  const [maiaMemory, setMaiaMemory] = useState<Record<number, MaiaIdentity>>({});
  const [prevMaia, setPrevMaia] = useState<MaiaIdentity>(maiaIdentity);
  // Displayed move: the board shows the position after move x (and before move
  // y), so the analysis panel covers x — the move leading into the viewed
  // position — not y. Focus is that move's before-position; -1 at the start
  // (no move yet).
  const focusPly = currentPly - 1;
  // Last committed focus, for batched rating+navigate updates where the first
  // render with the new identity already carries the navigated index.
  const lastFocusRef = useRef(focusPly);
  useEffect(() => { lastFocusRef.current = focusPly; }, [focusPly]);
  const nodes = useMemo<(ReviewNode & { sanMoves: string[] })[]>(() => {
    const game = replay([], line.initialFen);
    const nodes: (ReviewNode & { sanMoves: string[] })[] = [{ ...positionOf(game), initialFen: line.initialFen }];
    for (const move of line.moves) { applyUci(game, move); nodes.push({ ...positionOf(game), initialFen: line.initialFen }); }
    return nodes;
  }, [lineKey, state.analysis.moves, state.analysis.branchMoves]);
  // New content owns fresh memory: stale Elo associations from another line
  // must never leak into its headers.
  useEffect(() => { setMaiaMemory({}); }, [lineKey]);
  // Rating change invalidates the move viewed at change time. Render-phase
  // state update (not a passive effect) captures that focus: the first render
  // with the new identity backfills before any later navigation can reassign
  // the invalidation to the wrong index. Batched rating+navigate commits also
  // invalidate the pre-batch focus so neither move keeps stale results.
  // Own games: only the user's moves follow the adjustable rating. Maia's
  // moves stay pinned to the game Elo, so pinned plies are re-seeded with the
  // game identity instead of the old global one and never invalidated.
  if (!sameMaiaIdentity(prevMaia, maiaIdentity)) {
    const atChange = lastFocusRef.current;
    setPrevMaia(maiaIdentity);
    setMaiaMemory(prevMem => {
      // Backfill unvisited moves with the previous identity; the displayed
      // move (focus) jumps to the new one. At the start (no move yet) nothing
      // is invalidated, but unvisited entries still backfill.
      let next = focusPly >= 0
        ? backfillMaiaMemory(prevMem, prevMaia, maiaIdentity, focusPly, nodes.length)
        : { ...prevMem };
      if (focusPly < 0) {
        for (let i = 0; i < nodes.length; i++) if (next[i] === undefined) next[i] = prevMaia;
      }
      if (atChange !== focusPly && atChange >= 0 && atChange < nodes.length) next = { ...next, [atChange]: maiaIdentity };
      if (pinnedIdentity) {
        for (let i = 0; i < nodes.length; i++) {
          try {
            if (isMaiaNode(nodes[i])) next = { ...next, [i]: pinnedIdentity };
          } catch { /* keep backfilled identity */ }
        }
        // A rating change while viewing one of Maia's moves must not
        // invalidate that pinned move.
        if (focusPly >= 0 && focusPly < nodes.length) {
          try {
            if (isMaiaNode(nodes[focusPly])) next = { ...next, [focusPly]: pinnedIdentity };
          } catch { /* keep */ }
        }
        if (atChange >= 0 && atChange < nodes.length) {
          try {
            if (isMaiaNode(nodes[atChange])) next = { ...next, [atChange]: pinnedIdentity };
          } catch { /* keep */ }
        }
      }
      return next;
    });
  }
  useEffect(() => { return () => coordinator.suspend(); }, [coordinator, active, lineKey, combinedKey, state.analysis.moves, state.analysis.branchMoves]);
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
    // Foreground covers the displayed move's before/after pair (Stockfish
    // needs both for the verdict) plus Maia for both sides: the panel judges
    // x (focus) while the arrows project y (current). Maia takes the first
    // two slots, so the focus goes first.
    const current = nodes[state.analysis.index];
    const focus = state.analysis.index > 0 ? nodes[state.analysis.index - 1] : null;
    const timer = setTimeout(() => coordinator.foregroundAt(focus ? [focus, current] : [current], settingsForNode, 2), 200);
    return () => { clearTimeout(timer); coordinator.clearForeground(); };
  }, [coordinator, active, nodes, state.analysis.index, combinedKey]);
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
  const primeKey = `${hash}|${combinedKey}`;
  const [primedKey, setPrimedKey] = useState<string | null>(null);
  useEffect(() => {
    // Prime from the server cache on every load: reads only, never inference,
    // so evicted/missing rows simply stay missing for the explicit,
    // user-gated batch. Records are not a gate here — play-time Stockfish and
    // Maia saves must be usable the moment the analysis opens. Own games prime
    // with split identities so Maia's pinned moves restore from play-time
    // saves at the game Elo.
    if (!active || !mainLine || primedKey === primeKey) return;
    const controller = new AbortController();
    void coordinator.primeLine(nodes, settingsForNode, controller.signal).then(
      () => setPrimedKey(primeKey),
      () => { /* Superseded by navigation or settings change; the next key reprimes. */ },
    );
    return () => controller.abort();
  }, [active, mainLine, hash, combinedKey, primedKey]);
  // Coverage is counted live from memory so LRU turnover after priming shows
  // up honestly instead of freezing the prime-time number.
  // Coverage and the derivations below all key on the coordinator's cache
  // version: any settled evaluation bumps it, so results refresh exactly
  // when cache contents change and reuse otherwise.
  const cacheVersion = coordinator.snapshot();
  // Terminal flags are per-line, not per-render: replaying every prefix and
  // generating legal moves per node on each render is quadratic and dominated
  // the analysis render (per the DevTools profile). Compute once per line.
  const terminalByPly = useMemo(
    () => nodes.map(node => terminalEvaluation(replay(node.moves, node.initialFen)) !== undefined),
    [nodes],
  );
  const coverage = useMemo(() => {
    if (!(active && mainLine && primedKey === primeKey)) return null;
    let covered = 0;
    for (let index = 0; index < nodes.length; index++) {
      const s = settingsForNode(nodes[index]);
      if (coordinator.result('sf', nodes[index], s) &&
        (terminalByPly[index] || coordinator.result('maia', nodes[index], s))) covered++;
    }
    return { total: nodes.length, covered };
  }, [active, mainLine, primedKey, primeKey, nodes, settingsForNode, terminalByPly, cacheVersion, coordinator]);
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
  // Index-independent derivations, memoized (sharing cacheVersion above):
  // evaluations, qualities, and rarities depend only on the line, settings,
  // and cache contents — not on the viewed position. Without this every
  // arrow-key step recomputes the full quality loop (a legal-move generation
  // per ply), putting a game-length-scaled hitch between the keypress and
  // the board update.
  const evaluations = useMemo(
    () => nodes.map(node => coordinator.result('sf', node, settingsForNode(node))),
    [nodes, settingsForNode, cacheVersion, coordinator],
  );
  const maiaResults = useMemo(
    () => nodes.map(node => coordinator.result('maia', node, settingsForNode(node))),
    [nodes, settingsForNode, cacheVersion, coordinator],
  );
  const qualities = useMemo(() => {
    const game = replay([], line.initialFen);
    // Contract with QualityBadge: 'Unreviewed' survives only while a verdict
    // may still arrive. The coordinator's pending set covers every lane
    // (batch, foreground, play queue, server restore), so there is no
    // per-source condition here to fall behind when a new one appears.
    const pending = coordinator.sfPendingKeys();
    return line.moves.map((move, index) => {
      const quality = reviewMove(evaluations[index], evaluations[index + 1], game, move);
      applyUci(game, move);
      if (quality.label !== 'Unreviewed') return quality;
      const before = reviewKey('sf', nodes[index], settingsForNode(nodes[index]));
      const after = reviewKey('sf', nodes[index + 1], settingsForNode(nodes[index + 1]));
      return pending.has(before) || pending.has(after) ? quality : undefined;
    });
  }, [line.initialFen, line.moves, nodes, evaluations, settingsForNode, cacheVersion, coordinator]);
  // Additive difficulty axis: Maia probability ratio of the played move.
  // Own games anchor each ply to its responsible Elo: the user's moves to the
  // adjustable analysis rating, Maia's moves to the pinned game Elo.
  const rarities = useMemo(
    () => line.moves.map((move, index) => maiaRarity(maiaResults[index], move)),
    [line.moves, maiaResults],
  );
  const current = nodes[currentPly];
  const focusNode = focusPly >= 0 ? nodes[focusPly] : undefined;
  const focusIsMaia = !!focusNode && isMaiaNode(focusNode);
  // Pinned display for Maia's own moves: always the game identity, never stale.
  const pinnedForFocus = focusIsMaia && pinnedSettings ? coordinator.result('maia', focusNode, pinnedSettings) : undefined;
  // Displayed Maia prefers the fresh (global) result when it exists; otherwise
  // it falls back to the remembered per-move identity so unvisited moves keep
  // their old Elo visible while the new one fetches in the background.
  const memForFocus = focusPly >= 0 ? (maiaMemory[focusPly] ?? maiaIdentity) : maiaIdentity;
  const freshForFocus = active && focusNode && !focusIsMaia ? coordinator.result('maia', focusNode, settings) : undefined;
  const oldSettings: RecordSettings = { ...settings, eloMaia: memForFocus.eloMaia, eloUser: memForFocus.eloMaia, model: memForFocus.model };
  const staleForFocus = focusNode && !focusIsMaia && !sameMaiaIdentity(memForFocus, maiaIdentity) && !freshForFocus
    ? (active ? coordinator.result('maia', focusNode, oldSettings) : undefined)
    : undefined;
  const selection = focusIsMaia
    ? { identity: pinnedIdentity!, useFresh: true }
    : selectMaiaDisplay({ memory: focusPly >= 0 ? maiaMemory[focusPly] : undefined, global: maiaIdentity, fresh: freshForFocus, stale: staleForFocus });
  const displayedIdentity = focusIsMaia ? pinnedIdentity! : (selection.useFresh ? maiaIdentity : ((focusPly >= 0 ? maiaMemory[focusPly] : undefined) ?? maiaIdentity));
  const maiaForFocus = focusNode ? (focusIsMaia ? pinnedForFocus : (selection.useFresh ? freshForFocus : staleForFocus)) : undefined;
  const maiaStale = focusIsMaia ? false : !sameMaiaIdentity(displayedIdentity, maiaIdentity);
  // Once the fresh result lands (or the stale row is gone) the display already
  // reads fresh; sync memory so the next rating change backfills correctly.
  useEffect(() => {
    if (focusPly < 0 || !sameMaiaIdentity(displayedIdentity, maiaIdentity)) return;
    setMaiaMemory(prev => {
      const cur = prev[focusPly];
      if (!cur || sameMaiaIdentity(cur, maiaIdentity)) return prev;
      return { ...prev, [focusPly]: maiaIdentity };
    });
  }, [focusPly, maiaKey, displayedIdentity]);
  const startBatchAtCurrent = () => {
    setMaiaMemory(() => {
      const next: Record<number, MaiaIdentity> = {};
      for (let i = 0; i < nodes.length; i++) {
        try {
          if (pinnedIdentity && isMaiaNode(nodes[i])) next[i] = pinnedIdentity;
          else next[i] = maiaIdentity;
        } catch { next[i] = maiaIdentity; }
      }
      return next;
    });
    coordinator.startBatch(nodes, settingsForNode);
  };
  const focusSettings = focusNode ? settingsForNode(focusNode) : settings;
  const currentSettings = current ? settingsForNode(current) : settings;
  // Forward Maia for the arrows (y's estimates from the viewed position).
  // Fresh identity only, no stale fallback: the foreground lane fetches it on
  // every navigation, so a missing row is briefly absent rather than wrong.
  // settingsForNode already pins Maia's own moves to the game Elo.
  const maiaCurrent = active && current ? coordinator.result('maia', current, currentSettings) : undefined;
  return { nodes, evaluations, qualities, rarities, coverage, current: evaluations[currentPly], focus: focusPly >= 0 ? evaluations[focusPly] : undefined, focusPly, maia: maiaForFocus, maiaCurrent,
    maiaElo: displayedIdentity.eloMaia, maiaModel: displayedIdentity.model,
    maiaWantedElo: focusIsMaia ? pinnedIdentity!.eloMaia : maiaIdentity.eloMaia,
    maiaWantedModel: focusIsMaia ? pinnedIdentity!.model : maiaIdentity.model,
    maiaStale, maiaLocked: focusIsMaia,
    gameElo: gameForLine?.settings.eloMaia,
    error: active && current ? coordinator.error('sf', current, currentSettings) || (focusNode ? coordinator.error('sf', focusNode, focusSettings) || coordinator.error('maia', focusNode, focusSettings) : coordinator.error('maia', current, currentSettings)) : undefined,
    currentError: active && current ? coordinator.error('sf', current, currentSettings) : undefined,
    progress, recordStatus, start: startBatchAtCurrent, retry: () => coordinator.retry(),
    tooLong: nodes.length > 257 };
}
export type Review = ReturnType<typeof useReview>;
