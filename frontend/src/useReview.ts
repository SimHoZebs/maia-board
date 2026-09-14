import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { buildTimeline, type TimelineRow } from './domain';
import type { State } from './state';
import { ReviewCoordinator, reviewKey, reviewNodes, subscribeNone, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
import { computeQualities, type UnifiedMemo, type UnifiedVerdict } from './qualities';
import { maiaRarity, type Evaluation, type Quality } from './reviewMetrics';
import { selectMaiaDisplay, type MaiaDisplayEntry } from './maiaDisplay';

export type RecordStatus = { state: 'checking' | 'fresh' | 'none' };
export function isMaiaPosition(row: Pick<TimelineRow, 'turn' | 'outcome'>, userColor: 'white' | 'black', ownGame: boolean): boolean {
  return ownGame && row.outcome === null && row.turn !== userColor;
}
type ReviewPlyVerdict = UnifiedVerdict & { needsPending: boolean };
export type ReviewQualitiesMemo = UnifiedMemo;
export type ReviewQualitiesStats = { reviews: number };
export function computeReviewQualities(args: {
  line: { moves: string[] }; nodes: ReviewNode[]; evaluations: (Evaluation | undefined)[];
  settingsForNode: (node: ReviewNode) => ReviewSettings; pending: Set<string>; prev: ReviewQualitiesMemo | null; stats?: ReviewQualitiesStats;
}): { qualities: (Quality | undefined)[]; memo: ReviewQualitiesMemo } {
  const { line, nodes, evaluations, settingsForNode, pending, prev, stats } = args;
  return computeQualities({ scope: '', moves: line.moves, nodes, evaluations,
    keyFor: node => reviewKey('sf', node, settingsForNode(node)),
    active: () => true, pending, prev, stats });
}

export function useReview(state: State) {
  const [coordinator] = useState(() => new ReviewCoordinator());
  // AnalysisWorkspace owns this hook's lifetime. An unloaded importer has no
  // subscriber; settled app-memory rows remain available to its next mount.
  const active = state.analysisLoaded;
  const version = useSyncExternalStore(active ? coordinator.subscribe : subscribeNone, coordinator.snapshot, coordinator.snapshot);
  const moves = useMemo(() => state.analysis.branchFromPly === null ? state.analysis.moves
    : [...state.analysis.moves.slice(0, state.analysis.branchFromPly), ...state.analysis.branchMoves],
  [state.analysis.moves, state.analysis.branchFromPly, state.analysis.branchMoves]);
  const lineKey = JSON.stringify([state.analysis.initialFen, moves]);
  const timeline = useMemo(() => buildTimeline(state.analysis.initialFen, moves), [lineKey]);
  const nodes = useMemo(() => reviewNodes(timeline), [timeline]);
  const settingsKey = JSON.stringify([state.analysisSettings.eloMaia, state.analysisSettings.model, state.stockfish]);
  const settings: ReviewSettings = useMemo(() => ({ eloMaia: state.analysisSettings.eloMaia, eloUser: state.analysisSettings.eloMaia, model: state.analysisSettings.model, stockfish: state.stockfish }), [settingsKey]);
  const mainLine = state.analysis.branchFromPly === null;
  const ownGame = state.analysis.ownGame && mainLine;
  const gameForLine = ownGame ? (state.analysisSourceId
    ? state.saved.find(game => game.id === state.analysisSourceId) ?? (state.play.id === state.analysisSourceId ? state.play : null)
    : state.play) : null;
  const pinnedKey = gameForLine ? JSON.stringify([gameForLine.settings.eloMaia, gameForLine.settings.eloUser, gameForLine.settings.model, gameForLine.settings.userColor]) : '';
  const userColor = gameForLine?.settings.userColor;
  // On own-game mainlines, Maia positions retain the saved game identity.
  // User positions and explored branches use adjustable analysis settings.
  const settingsForNode = useMemo(() => {
    const pinned = gameForLine ? { eloMaia: gameForLine.settings.eloMaia, eloUser: gameForLine.settings.eloUser, model: gameForLine.settings.model, stockfish: state.stockfish } : null;
    return (node: ReviewNode): ReviewSettings => pinned && userColor && isMaiaPosition(node, userColor, ownGame) ? pinned : settings;
  }, [settings, pinnedKey, userColor, ownGame]);
  const combinedKey = `${settingsKey}|${pinnedKey}|${ownGame}`;
  const currentPly = Math.max(0, Math.min(state.analysis.index, nodes.length - 1));
  const focusPly = currentPly - 1;
  const currentNode = nodes[currentPly], focusNode = nodes[focusPly];
  const currentSettings = settingsForNode(currentNode);
  const focusSettings = focusNode ? settingsForNode(focusNode) : settings;
  const focusIsMaia = !!focusNode && !!userColor && isMaiaPosition(focusNode, userColor, ownGame);
  const tooLong = timeline.moves.length > 256;

  useEffect(() => () => coordinator.suspend(), [coordinator, active, lineKey, combinedKey]);
  useEffect(() => {
    let hiddenAt = 0;
    const hide = () => { hiddenAt = Date.now(); };
    const show = () => { coordinator.resume(hiddenAt ? Date.now() - hiddenAt : 0); hiddenAt = 0; };
    const visibility = () => document.hidden ? hide() : show();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    for (const event of ['pageshow', 'focus', 'online']) window.addEventListener(event, show);
    return () => {
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', hide);
      for (const event of ['pageshow', 'focus', 'online']) window.removeEventListener(event, show);
    };
  }, [coordinator]);
  useEffect(() => {
    coordinator.clearForeground();
    if (!active || tooLong) return;
    // Current and previous Stockfish grade the displayed move. Maia's focus
    // grades that move; current-position Maia supplies forward candidates.
    const timer = setTimeout(() => { coordinator.ensure(focusNode ? [focusNode, currentNode] : [currentNode], settingsForNode, { priority: true }); }, 200);
    return () => { clearTimeout(timer); coordinator.clearForeground(); };
  }, [coordinator, active, tooLong, nodes, currentPly, combinedKey]);

  const primeKey = `${lineKey}|${combinedKey}`;
  const [prime, setPrime] = useState<{ key: string; error?: string } | null>(null);
  const [primeAttempt, setPrimeAttempt] = useState(0);
  useEffect(() => {
    if (!active || tooLong) return;
    const controller = new AbortController();
    void Promise.resolve(coordinator.ensure(nodes, settingsForNode, { signal: controller.signal })).then(
      () => { if (!controller.signal.aborted) setPrime({ key: primeKey }); },
      error => { if (!controller.signal.aborted) setPrime({ key: primeKey, error: error instanceof Error ? error.message : 'Evaluation lookup failed.' }); },
    );
    return () => controller.abort();
  }, [coordinator, active, tooLong, primeKey, primeAttempt]);

  const evaluations = useMemo(() => nodes.map(node => coordinator.result('sf', node, settingsForNode(node))), [nodes, settingsForNode, version, coordinator]);
  const maiaResults = useMemo(() => nodes.map(node => coordinator.result('maia', node, settingsForNode(node))), [nodes, settingsForNode, version, coordinator]);
  const previous = useRef<ReviewQualitiesMemo | null>(null);
  const computed = useMemo(() => computeReviewQualities({ line: timeline, nodes, evaluations, settingsForNode, pending: coordinator.sfPendingKeys(), prev: previous.current }), [timeline, nodes, evaluations, settingsForNode, version, coordinator]);
  useEffect(() => { previous.current = computed.memo; }, [computed]);
  const rarities = useMemo(() => timeline.moves.map((move, ply) => maiaRarity(maiaResults[ply], move)), [timeline, maiaResults]);
  const coverage = useMemo(() => active && prime?.key === primeKey ? { total: nodes.length,
    covered: nodes.filter((node, ply) => evaluations[ply] && (node.outcome || maiaResults[ply])).length } : null,
  [active, prime, primeKey, nodes, evaluations, maiaResults]);
  const recordStatus: RecordStatus = { state: !active || tooLong ? 'none' : prime?.key !== primeKey ? 'checking' : coverage?.covered === coverage?.total ? 'fresh' : 'none' };
  const priorFocus = useRef<MaiaDisplayEntry | null>(null);
  const displayed = selectMaiaDisplay(active ? focusNode : undefined, focusSettings, active ? maiaResults[focusPly] : undefined, priorFocus.current,
    active && !!focusNode && coordinator.isPending('maia', focusNode, focusSettings));
  useEffect(() => { priorFocus.current = displayed.entry ?? null; }, [displayed.entry]);
  const maia = displayed.entry?.result;
  // Forward candidates only expose the requested key. The focus panel can
  // retain a same-position previous identity with its explicit stale label.
  const maiaCurrent = active ? maiaResults[currentPly] : undefined;
  const currentError = active ? coordinator.error('sf', currentNode, currentSettings) : undefined;
  const error = currentError || (active && focusNode ? coordinator.error('sf', focusNode, focusSettings) || coordinator.error('maia', focusNode, focusSettings) : undefined)
    || (active ? coordinator.error('maia', currentNode, currentSettings) : undefined) || (prime?.key === primeKey ? prime.error : undefined);
  return { timeline, nodes, evaluations, qualities: computed.qualities, rarities, coverage,
    current: evaluations[currentPly], focus: evaluations[focusPly], focusPly, maia, maiaCurrent,
    maiaElo: displayed.entry?.eloMaia ?? focusSettings.eloMaia, maiaModel: maia?.model_used ?? focusSettings.model,
    maiaWantedElo: focusSettings.eloMaia, maiaWantedModel: focusSettings.model,
    maiaStale: displayed.stale, maiaPending: displayed.pending, maiaLocked: focusIsMaia, maiaDegraded: maia?.degraded ?? false,
    maiaCurrentModel: maiaCurrent?.model_used, maiaCurrentDegraded: maiaCurrent?.degraded ?? false,
    maiaCurrentPending: active && coordinator.isPending('maia', currentNode, currentSettings),
    gameElo: gameForLine?.settings.eloMaia, error, currentError,
    progress: coordinator.progress, recordStatus, start: () => { coordinator.ensure(nodes, settingsForNode, { retain: true }); },
    retry: () => { coordinator.retry(); if (prime?.error) setPrimeAttempt(attempt => attempt + 1); }, tooLong };
}
export type Review = ReturnType<typeof useReview>;
