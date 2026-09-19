import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MoveResponse } from './api';
import { buildTimeline, legalPrefixLength, lineKeyFor, START_FEN, type StoredGame, type Timeline, type TimelineRow } from './domain';
import type { State } from './state/index';
import { ReviewCoordinator, resolveSettings, reviewKey, reviewNodes, subscribeNone, type ReviewNode, type ReviewSettings, type SettingsInput } from './reviewCoordinator';
import { ensureLane, candidatesFor, laneError, laneFailures, laneKey, lanePending, lanePoints, laneRows, primeDescriptor } from './objective';
import type { ObjectiveLane } from './qualities';
import { useLineScope } from './useLineScope';
import { useLookupRestore } from './useLookupRestore';
import { useServerBatch } from './useServerBatch';
import { computeLineQualities, type UnifiedMemo } from './qualities';
import { effectiveQuality, maiaRarity, type EngineGrade, type Evaluation, type ObjectivePoint, type Quality } from './reviewMetrics';
import { selectMaiaDisplay, type MaiaDisplayEntry } from './maiaDisplay';

// Configuration expressing room differences, not architecture. One pipeline
// owns coordinator + scope + restore + grading + translation for both rooms;
// the room selects:
// - target set: analysis grades the whole line viewed-first; play grades the
//   newest pair plus user-side-only activity.
// - eagerness: play fetches foreground on move + 3x2s retry + sweeps all
//   user-side moves on reconnect; analysis debounces + waits for batch.
// The room is static per mount (each adapter passes a literal), so branching
// rooms below never reorder hooks within a lifetime.
export type PipelineRoom = 'analysis' | 'play';

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
  objective?: ObjectiveLane;
}): { qualities: (EngineGrade | undefined)[]; memo: ReviewQualitiesMemo } {
  const { line, nodes, evaluations, settingsForNode, pending, prev, stats, objective } = args;
  return computeLineQualities({ scope: '', moves: line.moves, nodes, evaluations, settingsForNode, pending, prev, stats, objective });
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

export type PlayFeedback = {
  active: boolean;
  qualities: (Quality | undefined)[];
  error?: string;
  timeline: Timeline;
  nodes: ReviewNode[];
  evaluations: (Evaluation | undefined)[];
  maiaResults: (MoveResponse | undefined)[];
  objectivePoints: (ObjectivePoint | undefined)[];
  engineGrades: (EngineGrade | undefined)[];
  settings: ReviewSettings;
};
export type PlayQualitiesMemo = UnifiedMemo;
export type PlayQualitiesStats = { reviews: number };

// Newest move's grading endpoints. Stockfish needs the before/after pair;
// Maia only ever translates the mover's node (pass 2 below), and only
// user-side moves display, so opponent movers skip the Maia fetch.
export function wantedPlayPair(nodes: ReviewNode[], userColor: 'white' | 'black'): { sfNodes: ReviewNode[]; maiaNode: ReviewNode | null } {
  // No moves yet means nothing to grade: the first move's own pair fetch
  // covers the root, so starting empty keeps the lane free for Maia's reply.
  if (nodes.length < 2) return { sfNodes: [], maiaNode: null };
  const after = nodes[nodes.length - 1];
  const before = nodes[nodes.length - 2];
  return {
    sfNodes: before !== after ? [before, after] : [after],
    maiaNode: before.turn === userColor ? before : null,
  };
}

const FOREGROUND_RETRY_MS = 2000;
const FOREGROUND_RETRY_ATTEMPTS = 3;

// Sustained-failure surface: returning the string is enough — the caller
// (today workspaces.tsx PlayWorkspace reads only .qualities) decides display
// later. No new UI panels are built here; {active,qualities} stays compatible
// via the optional `error` field.
export const PLAY_RETRY_EXHAUSTED_MESSAGE = 'Move feedback unavailable — reviews kept failing.';

// Pure offline/retry helpers (wantedPlayPair precedent): DOM access stays
// injected/guarded so vitest's node env (no window) covers them without jsdom.
export function isOfflineValue(onLine: unknown): boolean {
  return onLine === false;
}

export function getNavigatorOnLine(): boolean | undefined {
  if (typeof window === 'undefined' || typeof window.navigator === 'undefined') return undefined;
  const onLine = window.navigator?.onLine;
  return typeof onLine === 'boolean' ? onLine : undefined;
}

export function isOfflineNow(readOnLine: () => unknown = getNavigatorOnLine): boolean {
  try {
    return isOfflineValue(readOnLine());
  } catch {
    return false;
  }
}

export function hasExhaustedPlayRetries(attemptCount: number): boolean {
  return attemptCount >= FOREGROUND_RETRY_ATTEMPTS;
}

export function playExhaustedError(hasErrors: boolean, attemptCount: number): string | undefined {
  return hasErrors && hasExhaustedPlayRetries(attemptCount) ? PLAY_RETRY_EXHAUSTED_MESSAGE : undefined;
}

const PRAISE_PENDING: Quality = { label: 'Unreviewed', accuracy: null, loss: null };

export function computePlayQualities(args: {
  gameId: string; timeline: Timeline; userColor: 'white' | 'black'; settings: ReviewSettings;
  sfLookup: (node: ReviewNode) => Evaluation | undefined; maiaLookup: (node: ReviewNode) => MoveResponse | undefined;
  objective?: ObjectiveLane;
  sfPending: Set<string>; maiaPending: Set<string>; prev: PlayQualitiesMemo | null; stats?: PlayQualitiesStats;
}): { qualities: (Quality | undefined)[]; memo: PlayQualitiesMemo; grades: (EngineGrade | undefined)[] } {
  const { gameId, timeline, userColor, settings, sfLookup, maiaLookup, objective, sfPending, maiaPending, prev, stats } = args;
  const nodes = reviewNodes(timeline);
  // Pass 1 stays engine-fact grading (memo-safe: keys never see objective
  // identity): negatives read the objective lane, praise still translates
  // engine-Critical below. Pass 2 translates only engine-Critical into
  // displayed praise; everything else settles the badge on the objective
  // lane and reads display Maia for its sentence only when cheap.
  const sf = computeLineQualities({ scope: `${gameId}|${userColor}`, moves: [...timeline.moves], nodes,
    evaluations: nodes.map(sfLookup), settingsForNode: () => settings,
    active: node => node.turn === userColor, pending: sfPending, prev, stats, objective });
  // Translation map: engine facts become displayed judgments. Raw memo
  // reuse still holds underneath (proven by stats.reviews); only this
  // translated array is fresh per call. Every grade goes through
  // effectiveQuality — returning the raw array when nothing is Critical
  // would leak engine-only labels (Top/Holds) the badge has no glyph for,
  // rendering as an empty gray box.
  const qualities: (Quality | undefined)[] = sf.qualities.map((grade, index) => {
    if (grade?.label !== 'Critical') return effectiveQuality(grade, undefined);
    const node = nodes[index];
    const move = timeline.moves[index];
    const maia = node ? maiaLookup(node) : undefined;
    if (!maia) {
      return node && maiaPending.has(reviewKey('maia', node, settings))
        ? { ...PRAISE_PENDING }
        : effectiveQuality(grade, { label: 'Unknown', r: null, prob: null, topProb: null });
    }
    return effectiveQuality(grade, maiaRarity(maia, move));
  });
  return { qualities, memo: sf.memo, grades: sf.qualities };
}

// Shared restore pair: one wiring for both rooms — the display restore plus
// the objective-lane (grading) restore through the single lookup hook. Rooms
// differ only in the target set they pass (whole line viewed-first vs the
// user-side subset) and the base key; the lane descriptor, the settle states,
// and the retry bump are identical.
function useRestorePair(args: {
  active: boolean;
  nodes: ReviewNode[];
  settings: SettingsInput;
  coordinator: ReviewCoordinator;
  displayKey: string;
  priorityPlies?: readonly number[];
}): {
  prime: { key: string; error?: string } | null;
  gradePrime: { key: string; error?: string } | null;
  gradeKey: string;
  lane: ReturnType<typeof primeDescriptor>;
  laneReady: boolean;
  retryPrime: () => void;
} {
  const { active, nodes, settings, coordinator, displayKey, priorityPlies } = args;
  const lane = useMemo(() => primeDescriptor(), []);
  const [prime, setPrime] = useState<{ key: string; error?: string } | null>(null);
  const [gradePrime, setGradePrime] = useState<{ key: string; error?: string } | null>(null);
  const [primeAttempt, setPrimeAttempt] = useState(0);
  // Stable across renders so room retry/online effects can depend on it
  // without rescheduling every render.
  const retryPrime = useCallback(() => setPrimeAttempt(attempt => attempt + 1), []);
  const gradeKey = `${displayKey}|${lane?.suffix ?? 'nolane'}`;
  useLookupRestore({ active, nodes, settings, coordinator,
    loadKey: `${displayKey}|${primeAttempt}`, priorityPlies,
    onSettled: (error) => setPrime({ key: displayKey, error }) });
  useLookupRestore({ active: active && lane.settings !== null, nodes, settings: lane?.settings ?? settings, engines: lane?.engines ?? [], coordinator,
    loadKey: `${gradeKey}|${primeAttempt}`, priorityPlies,
    onSettled: (error) => setGradePrime({ key: gradeKey, error }) });
  const laneReady = lane === null || gradePrime?.key === gradeKey;
  return { prime, gradePrime, gradeKey, lane, laneReady, retryPrime };
}

function useAnalysisRoom(state: State, coordinator: ReviewCoordinator) {
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

  // Eagerness (analysis): debounce + batch-wait. Current and previous
  // Stockfish grade the displayed move. Maia's focus grades that move;
  // current-position Maia supplies forward candidates. Signal-abort is the
  // only foreground cancel path: a line change aborts the scope, a ply
  // change replaces the queue latest-wins.
  useEffect(() => {
    if (!active || tooLong) return;
    // Cached-instant bypass: when both SF sides are already settled
    // (cache hit or terminal outcome), ensure synchronously so navigation
    // renders without the debounce. Only debounce on SF cache miss.
    const targets = focusNode ? [focusNode, currentNode] : [currentNode];
    const sfCached = targets.every(node => {
      if (!node) return true;
      if (node.outcome) return true;
      return !!coordinator.store.peek('sf', reviewKey('sf', node, resolveSettings(settingsForNode, node)));
    });
    if (sfCached) {
      coordinator.ensure(focusNode ? [focusNode, currentNode] : [currentNode], settingsForNode, { priority: true, signal: scope.signal, fastFirst: true });
      ensureLane(coordinator, focusNode ? [focusNode, currentNode] : [currentNode], scope.signal);
      return;
    }
    const timer = setTimeout(() => {
      coordinator.ensure(focusNode ? [focusNode, currentNode] : [currentNode], settingsForNode, { priority: true, signal: scope.signal, fastFirst: true });
      ensureLane(coordinator, focusNode ? [focusNode, currentNode] : [currentNode], scope.signal);
    }, 200);
    return () => { clearTimeout(timer); };
  }, [coordinator, active, tooLong, nodes, currentPly, combinedKey, scope]);

  // Target set (analysis): the whole line, viewed-first. Focus-first
  // restore: visible pair settles in the first lookup chunk.
  const primeKey = `${lineKey}|${combinedKey}`;
  const priorityPlies = focusNode ? [focusPly, currentPly] : [currentPly];
  const restore = useRestorePair({ active: active && !tooLong, nodes, settings: settingsForNode, coordinator,
    displayKey: primeKey, priorityPlies });
  const { prime, gradePrime } = restore;
  const batch = useServerBatch({ active: active && !tooLong, nodes, settings: settingsForNode, objectiveLane: restore.lane?.settings ?? null, coordinator, scope: active ? scope : null, auto: false, priorityPlies });

  // Display evaluations accept the fast MPV1 row provisionally: mate
  // detection and the material-note gating need only rank-1, so they render
  // from fast while the full MPV2 refines in the background. Coverage below
  // stays exact-full (completeness, not readiness) so a fast-only pair never
  // marks the line complete.
  // Known transient: a 1-line provisional can understate Critical (gap needs
  // before.lines[1]) and converge to Critical/Excellent/Great on full refine.
  const evaluations = useMemo(() => nodes.map(node => coordinator.provisionalSfResult(node, settingsForNode(node))), [nodes, settingsForNode, version, coordinator]);
  const maiaResults = useMemo(() => nodes.map(node => coordinator.result('maia', node, settingsForNode(node))), [nodes, settingsForNode, version, coordinator]);
  // Objective points for the active source. Row reads and point
  // conversion both live in the provider module; provisional Stockfish rows
  // keep first paint fast while coverage below still requires exact rows
  // independently. Raw rows are retained (not just points) because the
  // candidate panel renders the full ranked list, which points discard.
  const objectiveRows = useMemo(() => laneRows(nodes, { coordinator, sfEvaluations: evaluations }),
    [nodes, evaluations, version, coordinator]);
  const objectivePoints = useMemo(() => lanePoints(objectiveRows, nodes),
    [objectiveRows, nodes]);
  // Candidate lists for the panel: the focus position's list judges the
  // displayed move (with "(played)" marking), the current position's list
  // describes the root. Same provider seam as the points above, so the list
  // always shows the objective source — never the display Elo.
  const objectiveCandidates = useMemo(() => ({
    focus: focusNode ? candidatesFor(objectiveRows[focusPly], focusNode) : undefined,
    current: candidatesFor(objectiveRows[currentPly], currentNode),
  }), [objectiveRows, focusNode, focusPly, currentNode, currentPly]);
  const objectiveLane: ObjectiveLane = useMemo(() => ({
    points: objectivePoints,
    pending: lanePending(coordinator),
    keyFor: (node: ReviewNode) => laneKey(node, settingsForNode),
  }), [objectivePoints, nodes, settingsForNode, version, coordinator]);
  const previous = useRef<ReviewQualitiesMemo | null>(null);
  // Memo cache without an effect: the ref carries the last computed memo into
  // the next computation synchronously, so reuse never lags one commit
  // behind. Worst case (abandoned concurrent render) is a recompute — keys
  // are stable content, so correctness never depends on the cache.
  const computed = useMemo(() => {
    const result = computeReviewQualities({ line: timeline, nodes, evaluations, settingsForNode, pending: coordinator.sfPendingKeys(), prev: previous.current, objective: objectiveLane });
    previous.current = result.memo;
    return result;
  }, [timeline, nodes, evaluations, settingsForNode, objectiveLane, version, coordinator]);
  const rarities = useMemo(() => timeline.moves.map((move, ply) => maiaRarity(maiaResults[ply], move)), [timeline, maiaResults]);
  // Best-move rarity per ply: for mistakes, avoidance difficulty is the
  // rarity of the move they had to find, not the one they played. UCI-level
  // only (no SAN plumbing — the engine candidate list already names it), so
  // verdicts stay text-only and badges untouched. Missing best_move or Maia
  // yields undefined, which reads as standard wording.
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
    // Avoidance difficulty is the findability of the objective best move
    // at the displayed (user) level, not the engine best.
    const best = objectivePoints[ply]?.top ?? evaluations[ply]?.best_move;
    const maia = maiaResults[ply];
    return best && maia ? maiaRarity(maia, best) : undefined;
  }), [timeline, evaluations, objectivePoints, maiaResults]);
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
    const mainSf = mainNodes.map(node => coordinator.provisionalSfResult(node, mainlineSettingsForNode(node)));
    const mainMaiaResults = mainNodes.map(node => coordinator.result('maia', node, mainlineSettingsForNode(node)));
    const mainPoints = lanePoints(
      laneRows(mainNodes, { coordinator, sfEvaluations: mainSf }), mainNodes,
    );
    const mainRarities = mainTimeline.moves.map((move, ply) => maiaRarity(mainMaiaResults[ply], move));
    const mainGrades = computeReviewQualities({ line: mainTimeline, nodes: mainNodes, evaluations: mainSf,
      settingsForNode: mainlineSettingsForNode, pending: coordinator.sfPendingKeys(), prev: null,
      objective: {
        points: mainPoints,
        pending: lanePending(coordinator),
        keyFor: (node: ReviewNode) => laneKey(node, mainlineSettingsForNode),
      } });
    return translateReviewQualities({ grades: mainGrades.qualities, nodes: mainNodes, maiaResults: mainMaiaResults,
      rarities: mainRarities, settingsForNode: mainlineSettingsForNode, isMaiaPending: (node, settings) => coordinator.isPending('maia', node, settings) });
  }, [state.analysis.branchFromPly, state.analysis.moves, state.analysis.initialFen, mainlineSettingsForNode, version, coordinator]);
  // Coverage is completeness (badges + sentences), not badge readiness:
  // badges fast-path, but progress stays partial until both Maia lanes land
  // for every non-outcome node: display Maia for the sentence, objective
  // points for the badge. Exact full SF only — fast provisional rows never
  // count toward completeness (the objective-point check additionally
  // requires presence, and SF-sourced points always accompany exact rows
  // through the shared check).
  const laneReady = restore.lane === null || gradePrime?.key === restore.gradeKey;
  const primesReady = prime?.key === primeKey && laneReady;
  const coverage = useMemo(() => active && primesReady ? { total: nodes.length,
    covered: nodes.filter((node, ply) => coordinator.result('sf', node, settingsForNode(node)) && (node.outcome || maiaResults[ply]) && (node.outcome || objectivePoints[ply] !== undefined)).length } : null,
  [active, primesReady, nodes, settingsForNode, maiaResults, objectivePoints, version, coordinator]);
  const recordStatus: RecordStatus = { state: !active || tooLong ? 'none' : prime?.key !== primeKey || !laneReady ? 'checking' : coverage?.covered === coverage?.total ? 'fresh' : 'none' };
  const priorFocus = useRef<MaiaDisplayEntry | null>(null);
  const displayed = selectMaiaDisplay(active ? focusNode : undefined, focusSettings, active ? maiaResults[focusPly] : undefined, priorFocus.current,
    active && !!focusNode && coordinator.isPending('maia', focusNode, focusSettings));
  // Render-phase carry-forward (no effect): the note is fully determined by
  // this render (fresh, same-position reuse, or nothing), so banking it here
  // removes the one-commit lag of the effect version. Read runs first, so
  // the fallback stays yesterday's answer; the position-ID check inside
  // selectMaiaDisplay discards a note from an abandoned concurrent render.
  priorFocus.current = displayed.entry ?? null;
  const maia = displayed.entry?.result;
  // Forward candidates only expose the requested key. The focus panel can
  // retain a same-position previous identity with its explicit stale label.
  const maiaCurrent = active ? maiaResults[currentPly] : undefined;
  const currentError = active ? coordinator.error('sf', currentNode, currentSettings) : undefined;
  const error = currentError || (active && focusNode ? coordinator.error('sf', focusNode, focusSettings) || coordinator.error('maia', focusNode, focusSettings) : undefined)
    || (active ? coordinator.error('maia', currentNode, currentSettings) : undefined)
    || (active ? laneError(coordinator, focusNode) ?? laneError(coordinator, currentNode) : undefined)
    || (prime?.key === primeKey ? prime.error : undefined) || (restore.lane.settings !== null && gradePrime?.key === restore.gradeKey ? gradePrime.error : undefined)
    || batch.error;
  const batchComplete = !!batch.progress && !batch.progress.running && batch.progress.done === batch.progress.total && !batch.progress.failed;
  const coverageComplete = !!(coverage && coverage.covered === coverage.total);
  const reviewState: ReviewState = error || (batch.progress && batch.progress.failed > 0) ? 'failed'
    : batchComplete || coverageComplete ? 'complete'
    : !prime || prime.key !== primeKey || !laneReady || !coverage ? 'loading'
    : 'partial';
  return { timeline, nodes, evaluations, qualities, rarities, bestRarities, mainlineQualities, coverage,
    // Objective lane (provider points per position): the bar, graphs, and
    // score copy read this; move grades already derive from it. The
    // display-Maia results above stay on the selected Elo for rarity and
    // wording; Stockfish evaluations stay for material, mate, and praise.
    objective: objectivePoints,
    objectiveError: (node: ReviewNode | undefined) => laneError(coordinator, node),
    // Objective candidate lists for the panel: the focus list judges the
    // displayed move, the current list describes the root. Always the
    // objective source, never the display Elo.
    objectiveCandidates,
    // Raw engine grades (Critical/Top/Holds intact) for the verdict's
    // only-move fact. Badges and text read the translated `qualities`; this
    // never reaches display directly.
    engineGrades: computed.qualities,
    current: evaluations[currentPly], focus: evaluations[focusPly], focusPly,
    // Display responses for the left candidate list (the human-population
    // view at the selected Elo). The stale-aware focus entry keeps the old
    // list visible under its banner while the new Elo fetches.
    maia, maiaCurrent,
    maiaElo: displayed.entry?.eloMaia ?? focusSettings.eloMaia,
    maiaWantedElo: focusSettings.eloMaia,
    maiaStale: displayed.stale, maiaPending: displayed.pending, maiaLocked: focusIsMaia,
    gameElo: gameForLine?.settings.eloMaia, error, currentError,
    progress: batch.progress, recordStatus, reviewState, scope, lineKey, start: batch.start,
    retry: () => { coordinator.retry(); batch.retry(); if (prime?.error || gradePrime?.error) restore.retryPrime(); }, tooLong };
}

function usePlayRoom(state: State, coordinator: ReviewCoordinator): PlayFeedback {
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
  const scope = useLineScope(lineKey);
  const allNodes = useMemo(() => reviewNodes(timeline), [timeline]);
  // Target set (play): the only foreground work play ever issues is the
  // newest move's endpoints. Outcome and over-long nodes are skipped inside
  // the scheduler's job filter, exactly like the analysis focus fetch.
  const pair = useMemo(() => wantedPlayPair(allNodes, userColor), [allNodes, userColor]);
  const tooLong = timeline.moves.length > 256;
  // Eagerness (play): foreground fetch on move. Latest-wins per engine: a
  // newer move replaces queued older work, and the server batch is out of
  // this path entirely — no per-ply submit, no cancel/resubmit churn, no 409
  // races with ourselves.
  useEffect(() => {
    if (!active || tooLong || !pair.sfNodes.length) return;
    coordinator.ensure(pair.sfNodes, settings, { priority: true, engines: ['sf'], signal: scope.signal });
    if (pair.maiaNode) {
      coordinator.ensure([pair.maiaNode], settings, { priority: true, engines: ['maia'], signal: scope.signal });
      ensureLane(coordinator, pair.sfNodes, scope.signal);
    }
  }, [coordinator, active, tooLong, pair, settings, scope]);
  const nodes = useMemo(() => {
    const all = reviewNodes(timeline);
    const wanted = new Set<ReviewNode>();
    for (let ply = 0; ply < timeline.moves.length && ply < 256; ply++) {
      if (all[ply].turn === userColor) { wanted.add(all[ply]); wanted.add(all[ply + 1]); }
    }
    return [...wanted];
  }, [timeline, userColor]);
  // Cache restore runs independently of foreground work: settled rows grade
  // through the bulk lookup even when fetches fail. Signal-abort is the
  // only cancel path; backgrounding never aborts. Restore errors retry
  // through the same capped bucket as foreground failures below.
  const primeBaseKey = `${lineKey}|${settingsKey}`;
  const restore = useRestorePair({ active, nodes, settings, coordinator, displayKey: primeBaseKey });
  const { prime, gradePrime, retryPrime } = restore;
  // Retry sweeps every user-side endpoint with a recorded failure, not just
  // the newest pair: a failure that lands right before a reply (whose pair
  // no longer covers the failed node) must still heal, or its badge blanks
  // until the next move. Buckets bound the fires; the scheduler skips
  // already-settled keys at the pump, so a sweep re-fetches only misses.
  const retryTargets: { key: string; sf: ReviewNode[]; maia: ReviewNode[]; lane: ReviewNode[]; prime: boolean } = useMemo(() => {
    if (!active || tooLong) return { key: '', sf: [], maia: [], lane: [], prime: false };
    const sf = new Map<string, ReviewNode>();
    for (const node of [...pair.sfNodes, ...nodes]) sf.set(reviewKey('sf', node, settings), node);
    const maia = new Map<string, ReviewNode>();
    if (pair.maiaNode) maia.set(reviewKey('maia', pair.maiaNode, settings), pair.maiaNode);
    for (const node of nodes) maia.set(reviewKey('maia', node, settings), node);
    // Objective-lane failures sweep through the provider module; the
    // Stockfish twin reports none (the main sweep above already covers it).
    const seen = new Set<string>();
    const laneCandidates: ReviewNode[] = [];
    for (const node of [...pair.sfNodes, ...nodes]) {
      const id = `${node.initialFen}|${node.ply}`;
      if (!seen.has(id)) { seen.add(id); laneCandidates.push(node); }
    }
    const laneFailed = laneFailures(laneCandidates, coordinator);
    const sfFailed = [...sf.values()].filter(node => coordinator.error('sf', node, settings));
    const maiaFailed = [...maia.values()].filter(node => coordinator.error('maia', node, settings));
    const primeFailed = (prime?.key === primeBaseKey && !!prime.error) || (restore.lane.settings !== null && gradePrime?.key === restore.gradeKey && !!gradePrime.error);
    const parts = [...sfFailed.map(node => reviewKey('sf', node, settings)), ...maiaFailed.map(node => reviewKey('maia', node, settings)),
      ...laneFailed.map(node => laneKey(node, () => settings))];
    if (primeFailed) parts.push('prime');
    return { key: parts.sort().join('|'), sf: sfFailed, maia: maiaFailed, lane: laneFailed, prime: primeFailed };
  }, [active, tooLong, pair, nodes, settings, version, coordinator, prime, gradePrime, primeBaseKey, restore.gradeKey, restore.lane]);
  const attempts = useRef(new Map<string, number>());
  const [sustainedError, setSustainedError] = useState<string | undefined>(undefined);
  // Deps key on the derived error signature, not the targets object: the key
  // is a pure function of the failed lists, so unrelated renders neither
  // clear the backoff timer nor schedule duplicates.
  // Latest-targets mirror: the timer must read the failed lists from fire
  // time, but the lists rebuild every render — depending on them would
  // reintroduce the version-thrash timer reset the key dep removes.
  const latestRetry = useRef(retryTargets);
  latestRetry.current = retryTargets;
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const latestBucket = useRef(`${lineKey}|${settingsKey}`);
  latestBucket.current = `${lineKey}|${settingsKey}`;
  const { key: retryErrorKey } = retryTargets;
  useEffect(() => {
    if (!active || !retryErrorKey || scope.signal.aborted) {
      if (!retryErrorKey) setSustainedError(undefined);
      return;
    }
    const bucket = `${lineKey}|${settingsKey}`;
    for (const key of [...attempts.current.keys()]) if (key !== bucket) attempts.current.delete(key);
    if (hasExhaustedPlayRetries(attempts.current.get(bucket) ?? 0)) {
      setSustainedError(playExhaustedError(true, attempts.current.get(bucket) ?? 0));
      return;
    }
    // Offline never burns the attempt budget: skip scheduling while the
    // browser reports offline; the `online` listener below resets the bucket
    // and retries once. Transient errors keep the capped backoff as-is.
    if (isOfflineNow()) return;
    // Fresh bucket (line/settings change or online reset) drops a previous
    // line's surfaced failure; transient retries stay silent until the cap.
    setSustainedError(undefined);
    const timer = setTimeout(() => {
      if (scope.signal.aborted || isOfflineNow()) return;
      attempts.current.set(bucket, (attempts.current.get(bucket) ?? 0) + 1);
      // Re-issuing is enough: the scheduler clears failures for desired
      // jobs and skips already-settled ones at the pump.
      const { sf, maia, lane, prime: primeFailed } = latestRetry.current;
      if (!latestRetry.current.key) {
        setSustainedError(undefined);
      } else if (hasExhaustedPlayRetries(attempts.current.get(bucket) ?? 0)) {
        setSustainedError(playExhaustedError(true, attempts.current.get(bucket) ?? 0));
      }
      if (sf.length) coordinator.ensure(sf, settings, { priority: true, engines: ['sf'], signal: scope.signal });
      if (maia.length) coordinator.ensure(maia, settings, { priority: true, engines: ['maia'], signal: scope.signal });
      if (lane.length) ensureLane(coordinator, lane, scope.signal);
      if (primeFailed) retryPrime();
    }, FOREGROUND_RETRY_MS);
    return () => clearTimeout(timer);
  }, [active, retryErrorKey, lineKey, settingsKey, scope, coordinator, settings, retryPrime]);
  // Browser `online` resets the current line's bucket and retries once
  // immediately — the reconnect sweep covers all user-side moves, not just
  // the newest pair. Guarded for non-browser/test envs where window is undefined.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const onOnline = () => {
      const bucket = latestBucket.current;
      attempts.current.delete(bucket);
      setSustainedError(undefined);
      const targets = latestRetry.current;
      if (!targets.key) return;
      const s = latestSettings.current;
      const sc = latestScope.current;
      if (sc.signal.aborted) return;
      if (targets.sf.length) coordinator.ensure(targets.sf, s, { priority: true, engines: ['sf'], signal: sc.signal });
      if (targets.maia.length) coordinator.ensure(targets.maia, s, { priority: true, engines: ['maia'], signal: sc.signal });
      if (targets.lane.length) ensureLane(coordinator, targets.lane, sc.signal);
      if (targets.prime) retryPrime();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [coordinator, retryPrime]);
  const previous = useRef<PlayQualitiesMemo | null>(null);
  const sfPending = coordinator.sfPendingKeys(), maiaPending = coordinator.maiaPendingKeys();
  // Objective lane for the active source, built from full-timeline rows so
  // indexes align with the pure grader's internal nodes below.
  const fullNodes = useMemo(() => reviewNodes(timeline), [timeline]);
  const evaluations = useMemo(() => fullNodes.map(node => coordinator.result('sf', node, settings) as Evaluation | undefined),
    [fullNodes, settings, version, coordinator]);
  const maiaResults = useMemo(() => fullNodes.map(node => coordinator.result('maia', node, settings)),
    [fullNodes, settings, version, coordinator]);
  const lane: ObjectiveLane = useMemo(() => ({
    points: lanePoints(laneRows(fullNodes, { coordinator, sfEvaluations: evaluations }), fullNodes),
    pending: lanePending(coordinator),
    keyFor: (node: ReviewNode) => laneKey(node, () => settings),
  }), [fullNodes, evaluations, settings, version, coordinator]);
  // Same effect-free memo cache as the analysis room: synchronous
  // carry-forward, content-keyed so a speculative cache can only cost a
  // recompute.
  const computed = useMemo(() => {
    const result = active ? computePlayQualities({ gameId, timeline, userColor, settings,
      sfLookup: node => coordinator.result('sf', node, settings), maiaLookup: node => coordinator.result('maia', node, settings),
      objective: lane,
      sfPending, maiaPending, prev: previous.current }) : null;
    previous.current = result?.memo ?? null;
    return result;
  },
  [active, gameId, timeline, userColor, settings, lane, version, coordinator]);
  // Play queues no whole-line work and owns no batch job: the foreground
  // pair above plus the bulk restore are the only evaluation traffic, so
  // there is nothing to prune or cancel beyond the line scope's own abort.
  // Badges settle on the objective lane via computePlayQualities; the
  // coordinator keeps sole ownership of its queues.
  return {
    active, qualities: computed?.qualities ?? [], error: sustainedError,
    timeline, nodes: fullNodes, evaluations, maiaResults,
    objectivePoints: lane.points, engineGrades: computed?.grades ?? [],
    settings,
  };
}

type AnalysisResult = ReturnType<typeof useAnalysisRoom>;

export function useReviewPipeline(state: State, room: 'analysis'): AnalysisResult;
export function useReviewPipeline(state: State, room: 'play'): PlayFeedback;
export function useReviewPipeline(state: State, room: PipelineRoom): AnalysisResult | PlayFeedback {
  const [coordinator] = useState(() => new ReviewCoordinator());
  // Room is static per mount (adapters pass literals), so exactly one room
  // hook runs per lifetime — hook order never varies within a mount.
  if (room === 'play') return usePlayRoom(state, coordinator);
  return useAnalysisRoom(state, coordinator);
}
