import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MoveResponse } from './api';
import { buildTimeline, legalPrefixLength, lineKeyFor, START_FEN, type StoredGame, type Timeline, type TimelineRow } from './domain';
import type { State } from './state/index';
import { ReviewCoordinator, resolveSettings, reviewKey, reviewNodes, subscribeNone, type ReviewNode, type ReviewSettings, type SettingsInput } from './reviewCoordinator';
import { ensureLane, candidatesFor, laneError, laneFailures, laneKey, lanePending, lanePoints, laneRows, restoreDescriptor } from './objective';
import { trueCandidateDelta } from './objective/winrate';
import type { ObjectiveLane } from './qualities';
import { useLineScope } from './useLineScope';
import { useLookupRestore } from './useLookupRestore';
import { useServerBatch } from './useServerBatch';
import { computeLineQualities, type UnifiedMemo } from './qualities';
import { alienUpgrade, effectiveQuality, botRarity, sfTopGap, type EngineGrade, type Evaluation, type ObjectivePoint, type Quality, type Rarity } from './reviewMetrics';
import { selectBotDisplay, type BotDisplayEntry } from './botDisplay';
import { useObjectiveBestLine } from './useObjectiveBestLine';

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
export function isBotPosition(row: Pick<TimelineRow, 'turn' | 'outcome'>, userColor: 'white' | 'black', ownGame: boolean): boolean {
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
  grades: (EngineGrade | undefined)[]; nodes: ReviewNode[]; botResults: (MoveResponse | undefined)[];
  rarities: (ReturnType<typeof botRarity> | undefined)[]; settingsForNode: (node: ReviewNode) => ReviewSettings;
  isBotPending: (node: ReviewNode, settings: ReviewSettings) => boolean;
  // Peak-praise inputs for the Alien upgrade (analysis room only): the
  // played move's rarity at 2400 plus the mover-relative SF top gap per ply.
  // Omitted → pre-Alien behavior exactly (Play room, existing tests).
  alien?: { rarity2400: (Rarity | undefined)[]; sfGap: (number | null)[] };
}): (Quality | undefined)[] {
  const { grades, nodes, botResults, rarities, settingsForNode, isBotPending, alien } = args;
  return grades.map((grade, ply) => {
    const base = (() => {
      if (grade?.label !== 'Critical') return effectiveQuality(grade, undefined);
      const node = nodes[ply];
      const bot = botResults[ply];
      if (!bot) {
        return node && isBotPending(node, settingsForNode(node))
          ? { label: 'Unreviewed' as const, accuracy: null, loss: null }
          : effectiveQuality(grade, { label: 'Unknown', r: null, prob: null, topProb: null });
      }
      return effectiveQuality(grade, rarities[ply]);
    })();
    if (!alien || base?.label !== 'Excellent') return base;
    return alienUpgrade(base, rarities[ply], alien.rarity2400[ply], alien.sfGap[ply] ?? null);
  });
}

export type PlayFeedback = {
  active: boolean;
  qualities: (Quality | undefined)[];
  error?: string;
  timeline: Timeline;
  nodes: ReviewNode[];
  evaluations: (Evaluation | undefined)[];
  botResults: (MoveResponse | undefined)[];
  objectivePoints: (ObjectivePoint | undefined)[];
  engineGrades: (EngineGrade | undefined)[];
  settings: ReviewSettings;
  // Objective best-line UCIs for the viewed move (grading-lane walk with
  // Stockfish veto): PlayVerdict renders them through bestLinePreview.
  objectiveBestLine: string[];
};
export type PlayQualitiesMemo = UnifiedMemo;
export type PlayQualitiesStats = { reviews: number };

// Newest move's grading endpoints. Stockfish needs the before/after pair;
// the bot only ever translates the mover's node (pass 2 below), and only
// user-side moves display, so opponent movers skip the bot fetch.
export function wantedPlayPair(nodes: ReviewNode[], userColor: 'white' | 'black'): { sfNodes: ReviewNode[]; botNode: ReviewNode | null } {
  // No moves yet means nothing to grade: the first move's own pair fetch
  // covers the root, so starting empty keeps the lane free for the bot's reply.
  if (nodes.length < 2) return { sfNodes: [], botNode: null };
  const after = nodes[nodes.length - 1];
  const before = nodes[nodes.length - 2];
  return {
    sfNodes: before !== after ? [before, after] : [after],
    botNode: before.turn === userColor ? before : null,
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
  sfLookup: (node: ReviewNode) => Evaluation | undefined; botLookup: (node: ReviewNode) => MoveResponse | undefined;
  objective?: ObjectiveLane;
  sfPending: Set<string>; botPending: Set<string>; prev: PlayQualitiesMemo | null; stats?: PlayQualitiesStats;
}): { qualities: (Quality | undefined)[]; memo: PlayQualitiesMemo; grades: (EngineGrade | undefined)[] } {
  const { gameId, timeline, userColor, settings, sfLookup, botLookup, objective, sfPending, botPending, prev, stats } = args;
  const nodes = reviewNodes(timeline);
  // Pass 1 stays engine-fact grading (memo-safe: keys never see objective
  // identity): negatives read the objective lane, praise still translates
  // engine-Critical below. Pass 2 translates only engine-Critical into
  // displayed praise; everything else settles the badge on the objective
  // lane and reads the display bot for its sentence only when cheap.
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
    const bot = node ? botLookup(node) : undefined;
    if (!bot) {
      return node && botPending.has(reviewKey('maia', node, settings))
        ? { ...PRAISE_PENDING }
        : effectiveQuality(grade, { label: 'Unknown', r: null, prob: null, topProb: null });
    }
    return effectiveQuality(grade, botRarity(bot, move));
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
  restore: { key: string; error?: string } | null;
  gradeRestore: { key: string; error?: string } | null;
  gradeKey: string;
  lane: ReturnType<typeof restoreDescriptor>;
  laneReady: boolean;
  retryRestore: () => void;
} {
  const { active, nodes, settings, coordinator, displayKey, priorityPlies } = args;
  const lane = useMemo(() => restoreDescriptor(), []);
  const [restore, setRestore] = useState<{ key: string; error?: string } | null>(null);
  const [gradeRestore, setGradeRestore] = useState<{ key: string; error?: string } | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);
  // Stable across renders so room retry/online effects can depend on it
  // without rescheduling every render.
  const retryRestore = useCallback(() => setRestoreAttempt(attempt => attempt + 1), []);
  const gradeKey = `${displayKey}|${lane?.suffix ?? 'nolane'}`;
  useLookupRestore({ active, nodes, settings, coordinator,
    loadKey: `${displayKey}|${restoreAttempt}`, priorityPlies,
    onSettled: (error) => setRestore({ key: displayKey, error }) });
  useLookupRestore({ active: active && lane.settings !== null, nodes, settings: lane?.settings ?? settings, engines: lane?.engines ?? [], coordinator,
    loadKey: `${gradeKey}|${restoreAttempt}`, priorityPlies,
    onSettled: (error) => setGradeRestore({ key: gradeKey, error }) });
  const laneReady = lane === null || gradeRestore?.key === gradeKey;
  return { restore, gradeRestore, gradeKey, lane, laneReady, retryRestore };
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
  const settingsKey = JSON.stringify([state.analysisSettings.botElo, state.analysisSettings.model, state.stockfish]);
  // Display lane: policy at the selected Elo, values at 2400-vs-2400 so the
  // left move list shows what X would play with 2400-level winrates.
  // settingsHash/evaluationRequest normalize explicit-equal values away, so
  // a 2400 selection dedups with the grading lane.
  const settings: ReviewSettings = useMemo(() => ({ botElo: state.analysisSettings.botElo, userElo: state.analysisSettings.botElo,
    valueBotElo: 2400, valueUserElo: 2400, model: state.analysisSettings.model, stockfish: state.stockfish }), [settingsKey]);
  const mainLine = state.analysis.branchFromPly === null;
  const ownGame = state.analysis.ownGame && mainLine;
  const gameForLine = ownGame ? gameIdentityFor(state.analysisSourceId, state.saved, state.play) : null;
  const pinnedKey = gameForLine ? JSON.stringify([gameForLine.settings.botElo, gameForLine.settings.userElo, gameForLine.settings.model, gameForLine.settings.userColor]) : '';
  const userColor = gameForLine?.settings.userColor;
  // On own-game mainlines, bot positions retain the saved game identity for
  // policy (what was actually played) but share the 2400 value anchor so all
  // displayed winrates stay comparable. User positions and explored branches
  // use adjustable analysis settings.
  const settingsForNode = useMemo(() => {
    const pinned = gameForLine ? { botElo: gameForLine.settings.botElo, userElo: gameForLine.settings.userElo,
      valueBotElo: 2400, valueUserElo: 2400, model: gameForLine.settings.model, stockfish: state.stockfish } : null;
    return (node: ReviewNode): ReviewSettings => pinned && userColor && isBotPosition(node, userColor, ownGame) ? pinned : settings;
  }, [settings, pinnedKey, userColor, ownGame]);
  // Mainline game identity for the continuation pass, gated on the line
  // instead of the view: ownGame flips false inside a branch, which would
  // unpin saved-game bot settings and cap Critical continuation badges at
  // Best instead of the bot-aware badge the mainline showed. Keep the
  // resolver below in sync with settingsForNode above.
  const mainGameForLine = state.analysis.ownGame ? gameIdentityFor(state.analysisSourceId, state.saved, state.play) : null;
  const mainPinnedKey = mainGameForLine ? JSON.stringify([mainGameForLine.settings.botElo, mainGameForLine.settings.userElo, mainGameForLine.settings.model, mainGameForLine.settings.userColor]) : '';
  const mainUserColor = mainGameForLine?.settings.userColor;
  const mainlineSettingsForNode = useMemo(() => {
    const pinned = mainGameForLine ? { botElo: mainGameForLine.settings.botElo, userElo: mainGameForLine.settings.userElo,
      valueBotElo: 2400, valueUserElo: 2400, model: mainGameForLine.settings.model, stockfish: state.stockfish } : null;
    const mainOwnGame = state.analysis.ownGame;
    return (node: ReviewNode): ReviewSettings => pinned && mainUserColor && isBotPosition(node, mainUserColor, mainOwnGame) ? pinned : settings;
  }, [settings, mainPinnedKey, mainUserColor, state.analysis.ownGame]);
  const combinedKey = `${settingsKey}|${pinnedKey}|${ownGame}`;
  const currentPly = Math.max(0, Math.min(state.analysis.index, nodes.length - 1));
  const focusPly = currentPly - 1;
  const currentNode = nodes[currentPly], focusNode = nodes[focusPly];
  const currentSettings = settingsForNode(currentNode);
  const focusSettings = focusNode ? settingsForNode(focusNode) : settings;
  const focusIsBot = !!focusNode && !!userColor && isBotPosition(focusNode, userColor, ownGame);
  const tooLong = timeline.moves.length > 256;

  // Eagerness (analysis): debounce + batch-wait. Current and previous
  // Stockfish grade the displayed move. The bot's focus grades that move;
  // the current-position bot supplies forward candidates. Signal-abort is the
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
  const restoreKey = `${lineKey}|${combinedKey}`;
  const priorityPlies = focusNode ? [focusPly, currentPly] : [currentPly];
  const restorePair = useRestorePair({ active: active && !tooLong, nodes, settings: settingsForNode, coordinator,
    displayKey: restoreKey, priorityPlies });
  const { restore: displayRestore, gradeRestore } = restorePair;
  const batch = useServerBatch({ active: active && !tooLong, nodes, settings: settingsForNode, objectiveLane: restorePair.lane?.settings ?? null, coordinator, scope: active ? scope : null, auto: false, priorityPlies });

  // Display evaluations accept the fast MPV1 row provisionally: mate
  // detection and the material-note gating need only rank-1, so they render
  // from fast while the full MPV2 refines in the background. Coverage below
  // stays exact-full (completeness, not readiness) so a fast-only pair never
  // marks the line complete.
  // Known transient: a 1-line provisional can understate Critical (gap needs
  // before.lines[1]) and converge to Critical/Excellent/Great on full refine.
  const evaluations = useMemo(() => nodes.map(node => coordinator.provisionalSfResult(node, settingsForNode(node))), [nodes, settingsForNode, version, coordinator]);
  const botResults = useMemo(() => nodes.map(node => coordinator.result('maia', node, settingsForNode(node))), [nodes, settingsForNode, version, coordinator]);
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
  // True game-shift deltas: for the viewed before-position (focus, else
  // current at the root), fetch the 2400 grading row of each candidate
  // child and compare bar-vs-bar: P(child) vs P(before), mover-relative.
  // The played child already rides the mainline restore/batch; only the
  // 4 unplayed children cost extra foreground fetches, viewed-position
  // only (never the whole line). Terminal children synthesize (mate 100,
  // draw 50) with no fetch.
  const trueTargetNode = focusNode ?? currentNode;
  const trueTargetPly = focusNode ? focusPly : currentPly;
  const trueUcis = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (uci: string) => {
      if (typeof uci !== 'string' || seen.has(uci)) return;
      seen.add(uci); out.push(uci);
    };
    const displayMoves = (focusNode ? botResults[focusPly] : botResults[currentPly])?.top_moves.map(candidate => candidate.move) ?? [];
    for (const uci of displayMoves) push(uci);
    const objectiveMoves = (focusNode ? objectiveCandidates.focus : objectiveCandidates.current)?.entries.map(entry => entry.uci) ?? [];
    for (const uci of objectiveMoves) push(uci);
    return out.slice(0, 10);
  }, [focusNode, focusPly, currentPly, botResults, objectiveCandidates]);
  const trueUciKey = trueUcis.join(',');
  const trueChildNodes = useMemo(() => {
    if (!trueTargetNode || trueUcis.length === 0) return [];
    const base = timeline.moves.slice(0, trueTargetPly);
    const out: { uci: string; node: ReviewNode }[] = [];
    for (const uci of trueUcis) {
      try {
        const childTimeline = buildTimeline(timeline.initialFen, [...base, uci]);
        const row = childTimeline.rows[childTimeline.rows.length - 1];
        out.push({ uci, node: Object.freeze({ ...row, timeline: childTimeline, initialFen: childTimeline.initialFen }) });
      } catch { /* Illegal candidate: skip, panel falls back. */ }
    }
    return out;
  }, [timeline, trueTargetPly, trueUciKey]);
  useEffect(() => {
    if (!active || tooLong || trueChildNodes.length === 0) return;
    const targets = trueChildNodes.map(entry => entry.node).filter(node => !node.outcome);
    if (targets.length === 0) return;
    ensureLane(coordinator, targets, scope.signal);
  }, [coordinator, active, tooLong, scope, trueChildNodes]);
  const trueChildPoints = useMemo(() => {
    const rows = trueChildNodes.map(entry => laneRows([entry.node], { coordinator, sfEvaluations: [undefined] })[0]);
    return lanePoints(rows, trueChildNodes.map(entry => entry.node));
  }, [trueChildNodes, version, coordinator]);
  const trueDeltaByUci = useMemo(() => {
    const map = new Map<string, { value: number | null; pending: boolean }>();
    const beforeExpected = (focusNode ? objectivePoints[focusPly] : objectivePoints[currentPly])?.expected ?? null;
    // Without a settled baseline there is nothing true to converge to:
    // fall back to the prospective comparison instead of spinning forever
    // (the focus row itself is still loading or failed).
    if (beforeExpected == null) return map;
    trueChildNodes.forEach((entry, index) => {
      const point = trueChildPoints[index];
      const value = trueCandidateDelta(beforeExpected, point?.expected ?? null, entry.node.outcome);
      const failed = !entry.node.outcome && value === null && laneError(coordinator, entry.node) !== undefined;
      map.set(entry.uci, { value, pending: value === null && !entry.node.outcome && !failed });
    });
    return map;
  }, [trueChildNodes, trueChildPoints, objectivePoints, focusNode, focusPly, currentPly, version, coordinator]);
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
  const rarities = useMemo(() => timeline.moves.map((move, ply) => botRarity(botResults[ply], move)), [timeline, botResults]);
  // Played-move rarity at 2400 (objective lane policy): the second praise
  // axis. Missing/degraded objective rows yield undefined → Unknown downstream,
  // which never qualifies for tiers (absent evidence is not evidence).
  const rarity2400 = useMemo(() => timeline.moves.map((move, ply) => {
    const row = objectiveRows[ply];
    return row ? botRarity(row, move) : undefined;
  }), [timeline, objectiveRows]);
  // Mover-relative Stockfish top gap per ply, for the Alien upgrade only.
  const sfGap = useMemo(() => nodes.map((node, ply) => sfTopGap(evaluations[ply]?.lines, node.turn)),
    [nodes, evaluations]);
  // Best-move rarity per ply: for mistakes, avoidance difficulty is the
  // rarity of the move they had to find, not the one they played. UCI-level
  // only (no SAN plumbing — the engine candidate list already names it), so
  // verdicts stay text-only and badges untouched. Missing best_move or bot
  // yields undefined, which reads as standard wording.
  // Badges show the bot-aware judgment translated from engine facts
  // (Critical/Top/Holds → Excellent/Great/Best/Good). Praise needs hard-find
  // evidence; Expected/Unknown cap at Best. Engine-critical praise with the bot
  // still in flight holds the spinner instead of flashing a provisional
  // Best; SF-settled non-critical moves complete without the bot (fast path).
  // (The translated array is fresh per call; raw memo reuse underneath is
  // what avoids recompute.)
  const qualities = useMemo(() => translateReviewQualities({ grades: computed.qualities, nodes, botResults, rarities,
    settingsForNode, isBotPending: (node, settings) => coordinator.isPending('maia', node, settings),
    alien: { rarity2400, sfGap } }),
  [computed.qualities, rarities, rarity2400, sfGap, botResults, nodes, settingsForNode, version, coordinator]);
  const bestRarities = useMemo(() => timeline.moves.map((_move, ply) => {
    // Avoidance difficulty is the findability of the objective best move
    // at the displayed (user) level, not the engine best.
    const best = objectivePoints[ply]?.top ?? evaluations[ply]?.best_move;
    const bot = botResults[ply];
    return best && bot ? botRarity(bot, best) : undefined;
  }), [timeline, evaluations, objectivePoints, botResults]);
  // Objective best line for the viewed move: the suggestion walks the
  // grading lane (bot-2400 tops, reply by reply) with Stockfish as veto
  // only — never the Stockfish rank-1 PV, whose first move the badge can
  // grade as a mistake. Gated exactly like the material note (minus the
  // book hit, which InsightPanel owns); the walk deepens as frontier rows
  // land through ensureWalkFrontier below.
  const walkQuality = focusPly >= 0 ? qualities[focusPly] : undefined;
  const walkEnabled = active && !tooLong && focusPly >= 0
    && (walkQuality?.label === 'Mistake' || walkQuality?.label === 'Blunder')
    && evaluations[focusPly]?.score.type === 'cp' && evaluations[currentPly]?.score.type === 'cp'
    && !evaluations[focusPly]?.terminal && !evaluations[currentPly]?.terminal;
  const ensureWalkFrontier = useCallback((maia: ReviewNode | null, sf: ReviewNode | null) => {
    if (maia) ensureLane(coordinator, [maia], scope.signal);
    if (sf) coordinator.ensure([sf], settingsForNode, { priority: true, engines: ['sf'], signal: scope.signal });
  }, [coordinator, scope, settingsForNode]);
  const objectiveBestLine = useObjectiveBestLine({ coordinator, initialFen: timeline.initialFen, lineMoves: timeline.moves,
    reviewedPly: currentPly, enabled: walkEnabled, window: state.bestLineWindow, sfSettingsFor: settingsForNode,
    ensureFrontier: ensureWalkFrontier, version });
  // Mainline display qualities for the original-line continuation rendered
  // under an explored branch. MovesPanel draws that continuation from the
  // mainline while review.qualities aligns with the branch timeline, so
  // without this the badges those moves showed on the mainline vanish on
  // branching. Position-keyed coordinator results make it a cache-read-only
  // second pass (no fetches, no memo retention); skipped on mainlines.
  // Mainline memo carried across coordinator bumps, mirroring `previous`
  // above: reuse is content-keyed (posKey + fen + move + eval identity), so
  // settled prefix verdicts skip `reviewMove` while late-landing rows still
  // recompute. Without this the unchanged mainline regrades fully on every
  // branch-settle bump. Separate ref from the branch timeline: the node sets
  // differ, so sharing would only ever miss.
  const mainlinePrevious = useRef<ReviewQualitiesMemo | null>(null);
  const mainlineQualities = useMemo(() => {
    if (state.analysis.branchFromPly === null) { mainlinePrevious.current = null; return undefined; }
    const mainTimeline = buildTimeline(state.analysis.initialFen, state.analysis.moves);
    const mainNodes = reviewNodes(mainTimeline);
    const mainSf = mainNodes.map(node => coordinator.provisionalSfResult(node, mainlineSettingsForNode(node)));
    const mainBotResults = mainNodes.map(node => coordinator.result('maia', node, mainlineSettingsForNode(node)));
    const mainObjectiveRows = laneRows(mainNodes, { coordinator, sfEvaluations: mainSf });
    const mainPoints = lanePoints(mainObjectiveRows, mainNodes);
    const mainRarities = mainTimeline.moves.map((move, ply) => botRarity(mainBotResults[ply], move));
    const mainRarity2400 = mainTimeline.moves.map((move, ply) => {
      const row = mainObjectiveRows[ply];
      return row ? botRarity(row, move) : undefined;
    });
    const mainSfGap = mainNodes.map((node, ply) => sfTopGap(mainSf[ply]?.lines, node.turn));
    const mainGrades = computeReviewQualities({ line: mainTimeline, nodes: mainNodes, evaluations: mainSf,
      settingsForNode: mainlineSettingsForNode, pending: coordinator.sfPendingKeys(), prev: mainlinePrevious.current,
      objective: {
        points: mainPoints,
        pending: lanePending(coordinator),
        keyFor: (node: ReviewNode) => laneKey(node, mainlineSettingsForNode),
      } });
    mainlinePrevious.current = mainGrades.memo;
    return translateReviewQualities({ grades: mainGrades.qualities, nodes: mainNodes, botResults: mainBotResults,
      rarities: mainRarities, settingsForNode: mainlineSettingsForNode, isBotPending: (node, settings) => coordinator.isPending('maia', node, settings),
      alien: { rarity2400: mainRarity2400, sfGap: mainSfGap } });
  }, [state.analysis.branchFromPly, state.analysis.moves, state.analysis.initialFen, mainlineSettingsForNode, version, coordinator]);
  // Coverage is completeness (badges + sentences), not badge readiness:
  // badges fast-path, but progress stays partial until both bot lanes land
  // for every non-outcome node: the display bot for the sentence, objective
  // points for the badge. Exact full SF only — fast provisional rows never
  // count toward completeness (the objective-point check additionally
  // requires presence, and SF-sourced points always accompany exact rows
  // through the shared check).
  const laneReady = restorePair.lane === null || gradeRestore?.key === restorePair.gradeKey;
  const restoresReady = displayRestore?.key === restoreKey && laneReady;
  const coverage = useMemo(() => active && restoresReady ? { total: nodes.length,
    covered: nodes.filter((node, ply) => coordinator.result('sf', node, settingsForNode(node)) && (node.outcome || botResults[ply]) && (node.outcome || objectivePoints[ply] !== undefined)).length } : null,
  [active, restoresReady, nodes, settingsForNode, botResults, objectivePoints, version, coordinator]);
  const recordStatus: RecordStatus = { state: !active || tooLong ? 'none' : displayRestore?.key !== restoreKey || !laneReady ? 'checking' : coverage?.covered === coverage?.total ? 'fresh' : 'none' };
  const priorFocus = useRef<BotDisplayEntry | null>(null);
  const displayed = selectBotDisplay(active ? focusNode : undefined, focusSettings, active ? botResults[focusPly] : undefined, priorFocus.current,
    active && !!focusNode && coordinator.isPending('maia', focusNode, focusSettings));
  // Render-phase carry-forward (no effect): the note is fully determined by
  // this render (fresh, same-position reuse, or nothing), so banking it here
  // removes the one-commit lag of the effect version. Read runs first, so
  // the fallback stays yesterday's answer; the position-ID check inside
  // selectBotDisplay discards a note from an abandoned concurrent render.
  priorFocus.current = displayed.entry ?? null;
  const bot = displayed.entry?.result;
  // Forward candidates only expose the requested key. The focus panel can
  // retain a same-position previous identity with its explicit stale label.
  const botCurrent = active ? botResults[currentPly] : undefined;
  const currentError = active ? coordinator.error('sf', currentNode, currentSettings) : undefined;
  const error = currentError || (active && focusNode ? coordinator.error('sf', focusNode, focusSettings) || coordinator.error('maia', focusNode, focusSettings) : undefined)
    || (active ? coordinator.error('maia', currentNode, currentSettings) : undefined)
    || (active ? laneError(coordinator, focusNode) ?? laneError(coordinator, currentNode) : undefined)
    || (displayRestore?.key === restoreKey ? displayRestore.error : undefined) || (restorePair.lane.settings !== null && gradeRestore?.key === restorePair.gradeKey ? gradeRestore.error : undefined)
    || batch.error;
  const batchComplete = !!batch.progress && !batch.progress.running && batch.progress.done === batch.progress.total && !batch.progress.failed;
  const coverageComplete = !!(coverage && coverage.covered === coverage.total);
  const reviewState: ReviewState = error || (batch.progress && batch.progress.failed > 0) ? 'failed'
    : batchComplete || coverageComplete ? 'complete'
    : !displayRestore || displayRestore.key !== restoreKey || !laneReady || !coverage ? 'loading'
    : 'partial';
  return { timeline, nodes, evaluations, qualities, rarities, rarity2400, bestRarities, mainlineQualities, coverage,
    // Objective best-line UCIs for the viewed move (grading-lane walk, see
    // above): InsightPanel renders them through bestLinePreview instead of
    // the Stockfish rank-1 PV.
    objectiveBestLine,
    // Objective lane (provider points per position): the bar, graphs, and
    // score copy read this; move grades already derive from it. The
    // display-bot results above stay on the selected Elo for rarity and
    // wording; Stockfish evaluations stay for mate, praise, and the
    // best-line veto.
    objective: objectivePoints,
    objectiveError: (node: ReviewNode | undefined) => laneError(coordinator, node),
    // Objective candidate lists for the panel: the focus list judges the
    // displayed move, the current list describes the root. Always the
    // objective source, never the display Elo.
    objectiveCandidates,
    // True game-shift deltas by candidate UCI for the viewed before-position
    // (focus, else current at the root): bar-vs-bar including the opponent
    // reply. Value null with pending true means child grading is in flight
    // (panel shows an ellipsis); null with pending false means failed or
    // unsettled baseline (panel falls back to the prospective delta).
    trueDeltaByUci,
    // Raw engine grades (Critical/Top/Holds intact) for the verdict's
    // only-move fact. Badges and text read the translated `qualities`; this
    // never reaches display directly.
    engineGrades: computed.qualities,
    current: evaluations[currentPly], focus: evaluations[focusPly], focusPly,
    // Display responses for the left candidate list (the human-population
    // view at the selected Elo). The stale-aware focus entry keeps the old
    // list visible under its banner while the new Elo fetches.
    bot, botCurrent,
    botElo: displayed.entry?.botElo ?? focusSettings.botElo,
    botWantedElo: focusSettings.botElo,
    botStale: displayed.stale, botPending: displayed.pending, botLocked: focusIsBot,
    gameElo: gameForLine?.settings.botElo, error, currentError,
    progress: batch.progress, recordStatus, reviewState, scope, lineKey, start: batch.start,
    retry: () => { coordinator.retry(); batch.retry(); if (displayRestore?.error || gradeRestore?.error) restorePair.retryRestore(); }, tooLong };
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
  const settings: ReviewSettings = useMemo(() => ({ botElo: playSettings.botElo, userElo: playSettings.userElo, model: playSettings.model, stockfish: state.stockfish }), [settingsKey, playSettings.botElo, playSettings.userElo, playSettings.model]);
  const userColor = playSettings.userColor;
  const gameId = state.play.id;
  const lineKey = useMemo(() => lineKeyFor(START_FEN, moves), [movesKey]);
  const scope = useLineScope(lineKey);
  const allNodes = useMemo(() => reviewNodes(timeline), [timeline]);
  // Target set (play): the only foreground work play ever issues is the
  // newest move's endpoints. Outcome and over-long nodes are skipped inside
  // the coordinator's job filter, exactly like the analysis focus fetch.
  const pair = useMemo(() => wantedPlayPair(allNodes, userColor), [allNodes, userColor]);
  const tooLong = timeline.moves.length > 256;
  // Eagerness (play): foreground fetch on move. Latest-wins per engine: a
  // newer move replaces queued older work, and the server batch is out of
  // this path entirely — no per-ply submit, no cancel/resubmit churn, no 409
  // races with ourselves. Play (POST /move → Play lane) and bot analysis
  // (POST /move/analysis → Focus lane) queue on the shared slot with Play
  // priority instead of superseding each other.
  useEffect(() => {
    if (!active || tooLong || !pair.sfNodes.length) return;
    coordinator.ensure(pair.sfNodes, settings, { priority: true, engines: ['sf'], signal: scope.signal });
    if (pair.botNode) {
      coordinator.ensure([pair.botNode], settings, { priority: true, engines: ['maia'], signal: scope.signal });
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
  const restoreBaseKey = `${lineKey}|${settingsKey}`;
  const restorePair = useRestorePair({ active, nodes, settings, coordinator, displayKey: restoreBaseKey });
  const { restore: displayRestore, gradeRestore, retryRestore } = restorePair;
  // Retry sweeps every user-side endpoint with a recorded failure, not just
  // the newest pair: a failure that lands right before a reply (whose pair
  // no longer covers the failed node) must still heal, or its badge blanks
  // until the next move. Buckets bound the fires; the coordinator skips
  // already-settled keys at the pump, so a sweep re-fetches only misses.
  const retryTargets: { key: string; sf: ReviewNode[]; bot: ReviewNode[]; lane: ReviewNode[]; restore: boolean } = useMemo(() => {
    if (!active || tooLong) return { key: '', sf: [], bot: [], lane: [], restore: false };
    const sf = new Map<string, ReviewNode>();
    for (const node of [...pair.sfNodes, ...nodes]) sf.set(reviewKey('sf', node, settings), node);
    const bot = new Map<string, ReviewNode>();
    if (pair.botNode) bot.set(reviewKey('maia', pair.botNode, settings), pair.botNode);
    for (const node of nodes) bot.set(reviewKey('maia', node, settings), node);
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
    const botFailed = [...bot.values()].filter(node => coordinator.error('maia', node, settings));
    const restoreFailed = (displayRestore?.key === restoreBaseKey && !!displayRestore.error) || (restorePair.lane.settings !== null && gradeRestore?.key === restorePair.gradeKey && !!gradeRestore.error);
    const parts = [...sfFailed.map(node => reviewKey('sf', node, settings)), ...botFailed.map(node => reviewKey('maia', node, settings)),
      ...laneFailed.map(node => laneKey(node, () => settings))];
    if (restoreFailed) parts.push('restore');
    return { key: parts.sort().join('|'), sf: sfFailed, bot: botFailed, lane: laneFailed, restore: restoreFailed };
  }, [active, tooLong, pair, nodes, settings, version, coordinator, displayRestore, gradeRestore, restoreBaseKey, restorePair.gradeKey, restorePair.lane]);
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
      // Re-issuing is enough: the coordinator clears failures for desired
      // jobs and skips already-settled ones at the pump.
      const { sf, bot, lane, restore: restoreFailed } = latestRetry.current;
      if (!latestRetry.current.key) {
        setSustainedError(undefined);
      } else if (hasExhaustedPlayRetries(attempts.current.get(bucket) ?? 0)) {
        setSustainedError(playExhaustedError(true, attempts.current.get(bucket) ?? 0));
      }
      if (sf.length) coordinator.ensure(sf, settings, { priority: true, engines: ['sf'], signal: scope.signal });
      if (bot.length) coordinator.ensure(bot, settings, { priority: true, engines: ['maia'], signal: scope.signal });
      if (lane.length) ensureLane(coordinator, lane, scope.signal);
      if (restoreFailed) retryRestore();
    }, FOREGROUND_RETRY_MS);
    return () => clearTimeout(timer);
  }, [active, retryErrorKey, lineKey, settingsKey, scope, coordinator, settings, retryRestore]);
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
      if (targets.bot.length) coordinator.ensure(targets.bot, s, { priority: true, engines: ['maia'], signal: sc.signal });
      if (targets.lane.length) ensureLane(coordinator, targets.lane, sc.signal);
      if (targets.restore) retryRestore();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [coordinator, retryRestore]);
  const previous = useRef<PlayQualitiesMemo | null>(null);
  const sfPending = coordinator.sfPendingKeys(), botPending = coordinator.botPendingKeys();
  // Objective lane for the active source, built from full-timeline rows so
  // indexes align with the pure grader's internal nodes below.
  const fullNodes = useMemo(() => reviewNodes(timeline), [timeline]);
  const evaluations = useMemo(() => fullNodes.map(node => coordinator.result('sf', node, settings) as Evaluation | undefined),
    [fullNodes, settings, version, coordinator]);
  const botResults = useMemo(() => fullNodes.map(node => coordinator.result('maia', node, settings)),
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
      sfLookup: node => coordinator.result('sf', node, settings), botLookup: node => coordinator.result('maia', node, settings),
      objective: lane,
      sfPending, botPending, prev: previous.current }) : null;
    previous.current = result?.memo ?? null;
    return result;
  },
  [active, gameId, timeline, userColor, settings, lane, version, coordinator]);
  // Objective best line for the viewed user move: same grading-lane walk
  // as the analysis room, so the suggestion never starts with a move the
  // badge grades as a mistake. Play issues no speculative whole-line work:
  // the walk extends only through rows the pair fetch, restore, and retry
  // sweeps already settle, and the frontier fetch below covers one viewed
  // mistake at a time.
  const viewedPly = Math.max(0, Math.min(state.viewedPly ?? timeline.moves.length, timeline.moves.length));
  const viewFocus = viewedPly - 1;
  const playWalkGrade = viewFocus >= 0 ? computed?.qualities[viewFocus] : undefined;
  const playWalkEnabled = active && !tooLong && viewFocus >= 0
    && (playWalkGrade?.label === 'Mistake' || playWalkGrade?.label === 'Blunder')
    && evaluations[viewFocus]?.score.type === 'cp' && evaluations[viewedPly]?.score.type === 'cp'
    && !evaluations[viewFocus]?.terminal && !evaluations[viewedPly]?.terminal;
  const playSfSettingsFor = useCallback(() => settings, [settings]);
  const ensurePlayWalkFrontier = useCallback((maia: ReviewNode | null, sf: ReviewNode | null) => {
    if (maia) ensureLane(coordinator, [maia], scope.signal);
    if (sf) coordinator.ensure([sf], settings, { priority: true, engines: ['sf'], signal: scope.signal });
  }, [coordinator, scope, settings]);
  const objectiveBestLine = useObjectiveBestLine({ coordinator, initialFen: START_FEN, lineMoves: timeline.moves,
    reviewedPly: viewedPly, enabled: playWalkEnabled, window: state.bestLineWindow, sfSettingsFor: playSfSettingsFor,
    ensureFrontier: ensurePlayWalkFrontier, version });
  // Play queues no whole-line work and owns no batch job: the foreground
  // pair above plus the bulk restore are the only evaluation traffic, so
  // there is nothing to prune or cancel beyond the line scope's own abort.
  // Badges settle on the objective lane via computePlayQualities; the
  // coordinator keeps sole ownership of its queues.
  return {
    active, qualities: computed?.qualities ?? [], error: sustainedError,
    timeline, nodes: fullNodes, evaluations, botResults,
    objectivePoints: lane.points, engineGrades: computed?.grades ?? [],
    settings, objectiveBestLine,
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
