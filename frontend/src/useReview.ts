import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MoveResponse } from './api';
import { buildTimeline, lineKeyFor, type StoredGame, type TimelineRow } from './domain';
import type { State } from './state';
import { ReviewCoordinator, reviewNodes, subscribeNone, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
import { useLineScope } from './useLineScope';
import { useBulkPrime } from './useBulkPrime';
import { useServerBatch } from './useServerBatch';
import { computeLineQualities, type UnifiedMemo } from './qualities';
import { effectiveQuality, maiaRarity, type EngineGrade, type Evaluation, type Quality } from './reviewMetrics';
import { selectMaiaDisplay, type MaiaDisplayEntry } from './maiaDisplay';

export type RecordStatus = { state: 'checking' | 'fresh' | 'none' };
export type ReviewState = 'loading' | 'partial' | 'complete' | 'failed';
export function isMaiaPosition(row: Pick<TimelineRow, 'turn' | 'outcome'>, userColor: 'white' | 'black', ownGame: boolean): boolean {
  return ownGame && row.outcome === null && row.turn !== userColor;
}
// Saved-game identity for a line: the reviewed game when ids match, else the
// live game when sourceless. Shared by the branched view (gated on the view)
// and the mainline continuation pass (gated on the line) so the two cannot
// resolve the same line to different games.
export function gameIdentityFor(sourceId: string | null, saved: StoredGame[], play: StoredGame): StoredGame | null {
  return sourceId
    ? saved.find(game => game.id === sourceId) ?? (play.id === sourceId ? play : null)
    : play;
}
export type ReviewQualitiesMemo = UnifiedMemo;
export type ReviewQualitiesStats = { reviews: number };
// Kept for existing tests/callers: delegates to the single shared helper so
// computeQualities retains one call site in qualities.ts.
export function computeReviewQualities(args: {
  line: { moves: string[] }; nodes: ReviewNode[]; evaluations: (Evaluation | undefined)[];
  settingsForNode: (node: ReviewNode) => ReviewSettings; pending: Set<string>; prev: ReviewQualitiesMemo | null; stats?: ReviewQualitiesStats;
}): { qualities: (EngineGrade | undefined)[]; memo: ReviewQualitiesMemo } {
  const { line, nodes, evaluations, settingsForNode, pending, prev, stats } = args;
  return computeLineQualities({ scope: '', moves: line.moves, nodes, evaluations, settingsForNode, pending, prev, stats });
}

// Display translation for review badges: every engine grade goes through
// effectiveQuality so no engine-only label (Top/Holds/Critical) ever reaches
// QualityBadge, which has no glyph for them and would render an empty gray
// box. Pure for tests; the hook supplies lookups from the coordinator.
export function translateReviewQualities(args: {
  grades: (EngineGrade | undefined)[]; nodes: ReviewNode[]; maiaResults: (MoveResponse | undefined)[];
  rarities: (ReturnType<typeof maiaRarity> | undefined)[]; settingsForNode: (node: ReviewNode) => ReviewSettings;
  isMaiaPending: (node: ReviewNode, settings: ReviewSettings) => boolean;
}): (Quality | undefined)[] {
  const { grades, nodes, maiaResults, rarities, settingsForNode, isMaiaPending } = args;
  return grades.map((grade, ply) => {
    if (grade?.label !== 'Critical') return effectiveQuality(grade, undefined);
    const node = nodes[ply];
    const maia = maiaResults[ply];
    if (!maia) {
      return node && isMaiaPending(node, settingsForNode(node))
        ? { label: 'Unreviewed' as const, accuracy: null, loss: null }
        : effectiveQuality(grade, { label: 'Unknown', r: null, prob: null, topProb: null });
    }
    return effectiveQuality(grade, rarities[ply]);
  });
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
  const lineKey = useMemo(() => lineKeyFor(state.analysis.initialFen, moves), [state.analysis.initialFen, moves]);
  // One abort scope per line (shared hook). Batch jobs are never cancelled:
  // scope change only drops local optimism. Backgrounding never aborts.
  const scope = useLineScope(lineKey);
  const timeline = useMemo(() => buildTimeline(state.analysis.initialFen, moves), [lineKey]);
  const nodes = useMemo(() => reviewNodes(timeline), [timeline]);
  const settingsKey = JSON.stringify([state.analysisSettings.eloMaia, state.analysisSettings.model, state.stockfish]);
  const settings: ReviewSettings = useMemo(() => ({ eloMaia: state.analysisSettings.eloMaia, eloUser: state.analysisSettings.eloMaia, model: state.analysisSettings.model, stockfish: state.stockfish }), [settingsKey]);
  const mainLine = state.analysis.branchFromPly === null;
  const ownGame = state.analysis.ownGame && mainLine;
  const gameForLine = ownGame ? gameIdentityFor(state.analysisSourceId, state.saved, state.play) : null;
  const pinnedKey = gameForLine ? JSON.stringify([gameForLine.settings.eloMaia, gameForLine.settings.eloUser, gameForLine.settings.model, gameForLine.settings.userColor]) : '';
  const userColor = gameForLine?.settings.userColor;
  // On own-game mainlines, Maia positions retain the saved game identity.
  // User positions and explored branches use adjustable analysis settings.
  const settingsForNode = useMemo(() => {
    const pinned = gameForLine ? { eloMaia: gameForLine.settings.eloMaia, eloUser: gameForLine.settings.eloUser, model: gameForLine.settings.model, stockfish: state.stockfish } : null;
    return (node: ReviewNode): ReviewSettings => pinned && userColor && isMaiaPosition(node, userColor, ownGame) ? pinned : settings;
  }, [settings, pinnedKey, userColor, ownGame]);
  // Mainline game identity for the continuation pass, gated on the line
  // instead of the view: ownGame flips false inside a branch, which would
  // unpin saved-game Maia settings and cap Critical continuation badges at
  // Best instead of the Maia-aware badge the mainline showed. Keep the
  // resolver below in sync with settingsForNode above.
  const mainGameForLine = state.analysis.ownGame ? gameIdentityFor(state.analysisSourceId, state.saved, state.play) : null;
  const mainPinnedKey = mainGameForLine ? JSON.stringify([mainGameForLine.settings.eloMaia, mainGameForLine.settings.eloUser, mainGameForLine.settings.model, mainGameForLine.settings.userColor]) : '';
  const mainUserColor = mainGameForLine?.settings.userColor;
  const mainlineSettingsForNode = useMemo(() => {
    const pinned = mainGameForLine ? { eloMaia: mainGameForLine.settings.eloMaia, eloUser: mainGameForLine.settings.eloUser, model: mainGameForLine.settings.model, stockfish: state.stockfish } : null;
    const mainOwnGame = state.analysis.ownGame;
    return (node: ReviewNode): ReviewSettings => pinned && mainUserColor && isMaiaPosition(node, mainUserColor, mainOwnGame) ? pinned : settings;
  }, [settings, mainPinnedKey, mainUserColor, state.analysis.ownGame]);
  const combinedKey = `${settingsKey}|${pinnedKey}|${ownGame}`;
  const currentPly = Math.max(0, Math.min(state.analysis.index, nodes.length - 1));
  const focusPly = currentPly - 1;
  const currentNode = nodes[currentPly], focusNode = nodes[focusPly];
  const currentSettings = settingsForNode(currentNode);
  const focusSettings = focusNode ? settingsForNode(focusNode) : settings;
  const focusIsMaia = !!focusNode && !!userColor && isMaiaPosition(focusNode, userColor, ownGame);
  const tooLong = timeline.moves.length > 256;

  useEffect(() => {
    if (!active || tooLong) return;
    // Current and previous Stockfish grade the displayed move. Maia's focus
    // grades that move; current-position Maia supplies forward candidates.
    // Signal-abort is the only foreground cancel path: a line change aborts
    // the scope, a ply change replaces the queue latest-wins.
    const timer = setTimeout(() => {
      coordinator.ensure(focusNode ? [focusNode, currentNode] : [currentNode], settingsForNode, { priority: true, signal: scope.signal });
    }, 200);
    return () => { clearTimeout(timer); };
  }, [coordinator, active, tooLong, nodes, currentPly, combinedKey, scope]);

  const primeKey = `${lineKey}|${combinedKey}`;
  const batch = useServerBatch({ active: active && !tooLong, nodes, settings: settingsForNode, coordinator, scope: active ? scope : null, auto: false });
  const [prime, setPrime] = useState<{ key: string; error?: string } | null>(null);
  const [primeAttempt, setPrimeAttempt] = useState(0);
  useBulkPrime({ active: active && !tooLong, nodes, settings: settingsForNode, coordinator,
    loadKey: `${primeKey}|${primeAttempt}`,
    onSettled: (error) => setPrime({ key: primeKey, error }) });

  const evaluations = useMemo(() => nodes.map(node => coordinator.result('sf', node, settingsForNode(node))), [nodes, settingsForNode, version, coordinator]);
  const maiaResults = useMemo(() => nodes.map(node => coordinator.result('maia', node, settingsForNode(node))), [nodes, settingsForNode, version, coordinator]);
  const previous = useRef<ReviewQualitiesMemo | null>(null);
  // Memo cache without an effect: the ref carries the last computed memo into
  // the next computation synchronously, so reuse never lags one commit
  // behind. Worst case (abandoned concurrent render) is a recompute — keys
  // are stable content, so correctness never depends on the cache.
  const computed = useMemo(() => {
    const result = computeReviewQualities({ line: timeline, nodes, evaluations, settingsForNode, pending: coordinator.sfPendingKeys(), prev: previous.current });
    previous.current = result.memo;
    return result;
  }, [timeline, nodes, evaluations, settingsForNode, version, coordinator]);
  const rarities = useMemo(() => timeline.moves.map((move, ply) => maiaRarity(maiaResults[ply], move)), [timeline, maiaResults]);
  // Best-move rarity per ply: for mistakes, avoidance difficulty is the
  // rarity of the move they had to find, not the one they played. UCI-level
  // only (no SAN plumbing — the engine candidate list already names it), so
  // verdicts stay text-only and badges untouched. Missing best_move or Maia
  // yields undefined, which reads as standard temptation wording.
  // Badges show the Maia-aware judgment translated from engine facts
  // (Critical/Top/Holds → Excellent/Great/Best/Good). Praise needs hard-find
  // evidence; Expected/Unknown cap at Best. Engine-critical praise with Maia
  // still in flight holds the spinner instead of flashing a provisional
  // Best; SF-settled non-critical moves complete without Maia (fast path).
  // (The translated array is fresh per call; raw memo reuse underneath is
  // what avoids recompute.)
  const qualities = useMemo(() => translateReviewQualities({ grades: computed.qualities, nodes, maiaResults, rarities,
    settingsForNode, isMaiaPending: (node, settings) => coordinator.isPending('maia', node, settings) }),
  [computed.qualities, rarities, maiaResults, nodes, settingsForNode, version, coordinator]);
  const bestRarities = useMemo(() => timeline.moves.map((_move, ply) => {
    const best = evaluations[ply]?.best_move;
    const maia = maiaResults[ply];
    return best && maia ? maiaRarity(maia, best) : undefined;
  }), [timeline, evaluations, maiaResults]);
  // Coverage is completeness (badges + sentences), not badge readiness:
  // badges fast-path on SF alone, but progress stays partial until Maia
  // lands for every non-outcome node.
  const coverage = useMemo(() => active && prime?.key === primeKey ? { total: nodes.length,
    covered: nodes.filter((node, ply) => evaluations[ply] && (node.outcome || maiaResults[ply])).length } : null,
  [active, prime, primeKey, nodes, evaluations, maiaResults]);
  const recordStatus: RecordStatus = { state: !active || tooLong ? 'none' : prime?.key !== primeKey ? 'checking' : coverage?.covered === coverage?.total ? 'fresh' : 'none' };
  const priorFocus = useRef<MaiaDisplayEntry | null>(null);
  const displayed = selectMaiaDisplay(active ? focusNode : undefined, focusSettings, active ? maiaResults[focusPly] : undefined, priorFocus.current,
    active && !!focusNode && coordinator.isPending('maia', focusNode, focusSettings));
  // Render-phase carry-forward (no effect): the note is fully determined by
  // this render (fresh, same-position reuse, or nothing), so banking it here
  // removes the one-commit lag of the effect version. Read runs first, so
  // Mainline display qualities for the original-line continuation rendered
  // under an explored branch. MovesPanel draws that continuation from the
  // mainline while review.qualities aligns with the branch timeline, so
  // without this the badges those moves showed on the mainline vanish on
  // branching. Position-keyed coordinator results make it a cache-read-only
  // second pass (no fetches, no memo retention); skipped on mainlines.
  const mainlineQualities = useMemo(() => {
    if (state.analysis.branchFromPly === null) return undefined;
    const mainTimeline = buildTimeline(state.analysis.initialFen, state.analysis.moves);
    const mainNodes = reviewNodes(mainTimeline);
    const mainSf = mainNodes.map(node => coordinator.result('sf', node, mainlineSettingsForNode(node)));
    const mainMaiaResults = mainNodes.map(node => coordinator.result('maia', node, mainlineSettingsForNode(node)));
    const mainRarities = mainTimeline.moves.map((move, ply) => maiaRarity(mainMaiaResults[ply], move));
    const mainGrades = computeReviewQualities({ line: mainTimeline, nodes: mainNodes, evaluations: mainSf,
      settingsForNode: mainlineSettingsForNode, pending: coordinator.sfPendingKeys(), prev: null });
    return translateReviewQualities({ grades: mainGrades.qualities, nodes: mainNodes, maiaResults: mainMaiaResults,
      rarities: mainRarities, settingsForNode: mainlineSettingsForNode, isMaiaPending: (node, settings) => coordinator.isPending('maia', node, settings) });
  }, [state.analysis.branchFromPly, state.analysis.moves, state.analysis.initialFen, mainlineSettingsForNode, version, coordinator]);
  // the fallback stays yesterday's answer; the position-ID check inside
  // selectMaiaDisplay discards a note from an abandoned concurrent render.
  priorFocus.current = displayed.entry ?? null;
  const maia = displayed.entry?.result;
  // Forward candidates only expose the requested key. The focus panel can
  // retain a same-position previous identity with its explicit stale label.
  const maiaCurrent = active ? maiaResults[currentPly] : undefined;
  const currentError = active ? coordinator.error('sf', currentNode, currentSettings) : undefined;
  const error = currentError || (active && focusNode ? coordinator.error('sf', focusNode, focusSettings) || coordinator.error('maia', focusNode, focusSettings) : undefined)
    || (active ? coordinator.error('maia', currentNode, currentSettings) : undefined) || (prime?.key === primeKey ? prime.error : undefined)
    || batch.error;
  const batchComplete = !!batch.progress && !batch.progress.running && batch.progress.done === batch.progress.total && !batch.progress.failed;
  const coverageComplete = !!(coverage && coverage.covered === coverage.total);
  const reviewState: ReviewState = error || (batch.progress && batch.progress.failed > 0) ? 'failed'
    : batchComplete || coverageComplete ? 'complete'
    : !prime || prime.key !== primeKey || !coverage ? 'loading'
    : 'partial';
  return { timeline, nodes, evaluations, qualities, rarities, bestRarities, mainlineQualities, coverage,
    current: evaluations[currentPly], focus: evaluations[focusPly], focusPly, maia, maiaCurrent,
    maiaElo: displayed.entry?.eloMaia ?? focusSettings.eloMaia, maiaModel: maia?.model_used ?? focusSettings.model,
    maiaWantedElo: focusSettings.eloMaia, maiaWantedModel: focusSettings.model,
    maiaStale: displayed.stale, maiaPending: displayed.pending, maiaLocked: focusIsMaia, maiaDegraded: maia?.degraded ?? false,
    maiaCurrentModel: maiaCurrent?.model_used, maiaCurrentDegraded: maiaCurrent?.degraded ?? false,
    maiaCurrentPending: active && coordinator.isPending('maia', currentNode, currentSettings),
    gameElo: gameForLine?.settings.eloMaia, error, currentError,
    progress: batch.progress, recordStatus, reviewState, scope, lineKey, start: batch.start,
    retry: () => { coordinator.retry(); batch.retry(); if (prime?.error) setPrimeAttempt(attempt => attempt + 1); }, tooLong };
}
export type Review = ReturnType<typeof useReview>;
