import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { buildTimeline, legalPrefixLength, lineKeyFor, START_FEN, type Timeline } from './domain';
import { ReviewCoordinator, reviewKey, reviewNodes, subscribeNone, type ReviewNode, type ReviewSettings } from './reviewCoordinator';
import { useLineScope } from './useLineScope';
import { useBulkPrime } from './useBulkPrime';
import { computeLineQualities, type UnifiedMemo } from './qualities';
import { effectiveQuality, maiaRarity, type Evaluation, type Quality } from './reviewMetrics';
import type { MoveResponse } from './api';
import type { State } from './state';

export type PlayFeedback = { active: boolean; qualities: (Quality | undefined)[]; error?: string };
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
  const scope = useLineScope(lineKey);
  const allNodes = useMemo(() => reviewNodes(timeline), [timeline]);
  // The only foreground work play ever issues: the newest move's endpoints.
  // Outcome and over-long nodes are skipped inside the scheduler's job
  // filter, exactly like the analysis focus fetch.
  const pair = useMemo(() => wantedPlayPair(allNodes, userColor), [allNodes, userColor]);
  const tooLong = timeline.moves.length > 256;
  useEffect(() => {
    if (!active || tooLong || !pair.sfNodes.length) return;
    // Latest-wins per engine: a newer move replaces queued older work, and
    // the server batch is out of this path entirely — no per-ply submit,
    // no cancel/resubmit churn, no 409 races with ourselves.
    coordinator.ensure(pair.sfNodes, settings, { priority: true, engines: ['sf'], signal: scope.signal });
    if (pair.maiaNode) coordinator.ensure([pair.maiaNode], settings, { priority: true, engines: ['maia'], signal: scope.signal });
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
  const [primeAttempt, setPrimeAttempt] = useState(0);
  const [prime, setPrime] = useState<{ key: string; error?: string } | null>(null);
  const primeBaseKey = `${lineKey}|${settingsKey}`;
  useBulkPrime({ active, nodes, settings, coordinator, loadKey: `${primeBaseKey}|${primeAttempt}`,
    onSettled: error => setPrime({ key: primeBaseKey, error }) });
  // Retry sweeps every user-side endpoint with a recorded failure, not just
  // the newest pair: a failure that lands right before a reply (whose pair
  // no longer covers the failed node) must still heal, or its badge blanks
  // until the next move. Buckets bound the fires; the scheduler skips
  // already-settled keys at the pump, so a sweep re-fetches only misses.
  const retryTargets: { key: string; sf: ReviewNode[]; maia: ReviewNode[]; prime: boolean } = useMemo(() => {
    if (!active || tooLong) return { key: '', sf: [], maia: [], prime: false };
    const sf = new Map<string, ReviewNode>();
    for (const node of [...pair.sfNodes, ...nodes]) sf.set(reviewKey('sf', node, settings), node);
    const maia = new Map<string, ReviewNode>();
    if (pair.maiaNode) maia.set(reviewKey('maia', pair.maiaNode, settings), pair.maiaNode);
    for (const node of nodes) maia.set(reviewKey('maia', node, settings), node);
    const sfFailed = [...sf.values()].filter(node => coordinator.error('sf', node, settings));
    const maiaFailed = [...maia.values()].filter(node => coordinator.error('maia', node, settings));
    const primeFailed = prime?.key === primeBaseKey && !!prime.error;
    const parts = [...sfFailed.map(node => reviewKey('sf', node, settings)), ...maiaFailed.map(node => reviewKey('maia', node, settings))];
    if (primeFailed) parts.push('prime');
    return { key: parts.sort().join('|'), sf: sfFailed, maia: maiaFailed, prime: primeFailed };
  }, [active, tooLong, pair, nodes, settings, version, coordinator, prime, primeBaseKey]);
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
      const { sf, maia, prime: primeFailed } = latestRetry.current;
      if (!latestRetry.current.key) {
        setSustainedError(undefined);
      } else if (hasExhaustedPlayRetries(attempts.current.get(bucket) ?? 0)) {
        setSustainedError(playExhaustedError(true, attempts.current.get(bucket) ?? 0));
      }
      if (sf.length) coordinator.ensure(sf, settings, { priority: true, engines: ['sf'], signal: scope.signal });
      if (maia.length) coordinator.ensure(maia, settings, { priority: true, engines: ['maia'], signal: scope.signal });
      if (primeFailed) setPrimeAttempt(count => count + 1);
    }, FOREGROUND_RETRY_MS);
    return () => clearTimeout(timer);
  }, [active, retryErrorKey, lineKey, settingsKey, scope, coordinator, settings]);
  // Browser `online` resets the current line's bucket and retries once
  // immediately. Guarded for non-browser/test envs where window is undefined.
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
      if (targets.prime) setPrimeAttempt(count => count + 1);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [coordinator]);
  const previous = useRef<PlayQualitiesMemo | null>(null);
  const sfPending = coordinator.sfPendingKeys(), maiaPending = coordinator.maiaPendingKeys();
  // Same effect-free memo cache as useReview: synchronous carry-forward,
  // content-keyed so a speculative cache can only cost a recompute.
  const computed = useMemo(() => {
    const result = active ? computePlayQualities({ gameId, timeline, userColor, settings,
      sfLookup: node => coordinator.result('sf', node, settings), maiaLookup: node => coordinator.result('maia', node, settings),
      sfPending, maiaPending, prev: previous.current }) : null;
    previous.current = result?.memo ?? null;
    return result;
  },
  [active, gameId, timeline, userColor, settings, version, coordinator]);
  // Play queues no whole-line work and owns no batch job: the foreground
  // pair above plus the bulk restore are the only evaluation traffic, so
  // there is nothing to prune or cancel beyond the line scope's own abort.
  // Badges settle on SF alone via computePlayQualities; the coordinator
  // keeps sole ownership of its queues.
  return { active, qualities: computed?.qualities ?? [], error: sustainedError };
}
