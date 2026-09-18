import { useCallback, useEffect, useRef, useState } from 'react';
import { BatchGoneError, buildBatchItems, clearPersistedBatch,
  fetchBatchStatus, hashBatchKeys,
  readPersistedBatch, submitBatch, subscribeBatchEvents, writePersistedBatch,
  type BatchItem, type BatchProgress, type PersistedBatch } from './batchReview';
import type { Engine, LineScope, ReviewCoordinator, ReviewNode, SettingsInput } from './reviewCoordinator';

export type ServerBatchProgress = { total: number; done: number; failed: number; running: boolean };

// Server-batch client: submit(nodes, scope) + progress UI. Nothing cancels:
// a scope change, unmount, deactivation, or game delete only drops local
// references while server jobs drain on their own, and every late
// SSE/poll/prime callback is ignored by a single lineKey guard.
// Backgrounding never aborts: a broken stream falls back to polls silently.
// The submitted job id + content hash persist in localStorage so a reload
// reattaches to the still-running server job instead of showing Analyze
// again. A settings change or different line never reattaches (hash/lineKey
// mismatch). Concurrent submits coexist; over-cap 429s wait once per
// Retry-After inside submitBatch, then surface engine-busy.
export function useServerBatch(args: {
  active: boolean;
  nodes: ReviewNode[];
  settings: SettingsInput;
  engines?: Engine[];
  // Objective lane: extra per-node entries the active source needs beyond
  // Stockfish, hashed and tracked exactly like the rest of the batch.
  // Module-singleton identity expected; rides a ref like settings.
  objectiveLane?: SettingsInput | null;
  coordinator: ReviewCoordinator;
  scope: LineScope | null;
  auto?: boolean;
  fetcher?: typeof fetch;
  // Focus-first reconciliation: ReviewNode .ply values to settle before the
  // rest of the line when reconciling batch progress via the lookup path.
  // Forwarded to the coordinator's priority prime; the existing 2s throttle
  // below and the store's cache check still apply (no duplicate storm).
  // Rides a ref so an inline literal cannot resubmit.
  priorityPlies?: readonly number[];
}): { progress: ServerBatchProgress | null; error: string | undefined; start: () => void; retry: () => void } {
  const { active, nodes, settings, engines, coordinator, scope, auto, fetcher } = args;
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobScopeKey, setJobScopeKey] = useState<string | null>(null);
  const [progress, setProgress] = useState<ServerBatchProgress | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const itemsRef = useRef<BatchItem[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // engines arrives as an inline literal at the call sites: mirror it into a
  // ref like nodes/settings/scope. Otherwise `start` (and the auto-start
  // effect below, which depends on it) gets a new identity every render and
  // re-submits forever: start() → setProgress → render → new array → start().
  // That is React error #185 the moment auto && active (play + feedback on).
  const enginesRef = useRef(engines);
  enginesRef.current = engines;
  const objectiveLaneRef = useRef(args.objectiveLane);
  objectiveLaneRef.current = args.objectiveLane;
  const priorityRef = useRef(args.priorityPlies);
  priorityRef.current = args.priorityPlies;
  const jobIdRef = useRef<string | null>(null);
  jobIdRef.current = jobId;
  const jobScopeRef = useRef<string | null>(null);
  jobScopeRef.current = jobScopeKey;
  // Batch state is scoped to the settings it was submitted under (both call
  // sites pass memo-stable settings objects, so identity change means a real
  // settings edit). A settings change retires settled progress: its
  // completion says nothing about the new settings, so without this the
  // button would linger on "Analyzed" while coverage correctly reports the
  // new settings as missing. A running job keeps its progress and settles
  // normally; completion then primes under the current settings refs.
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const prevSettingsRef = useRef(settings);
  useEffect(() => {
    if (prevSettingsRef.current === settings) return;
    prevSettingsRef.current = settings;
    if (!progressRef.current?.running) {
      setJobId(null);
      setJobScopeKey(null);
      setProgress(null);
      setError(undefined);
      itemsRef.current = [];
    }
  }, [settings]);

  const start = useCallback(() => {
    const current = scopeRef.current;
    if (!active || !current) return;
    const submittedKey = current.lineKey;
    const batchItems = buildBatchItems(nodesRef.current, settingsRef.current, enginesRef.current, objectiveLaneRef.current);
    itemsRef.current = batchItems;
    const keysHash = hashBatchKeys(batchItems.map(item => item.key));
    coordinator.replaceFailures(new Set(batchItems.map(item => item.key)), new Map());
    setError(undefined);
    setProgress({ total: batchItems.length, done: 0, failed: 0, running: batchItems.length > 0 });
    if (!batchItems.length) { setJobId(null); setJobScopeKey(null); return; }
    void (async () => {
      try {
        const submitted = await submitBatch(batchItems, fetcher);
        // Stale submit: the line moved while we were submitting. Nothing
        // cancels: drop optimism we still own so the new line never inherits
        // a running count with no job behind it. The orphan drains on the
        // server and vanishes by absence.
        if (scopeRef.current?.lineKey !== submittedKey) {
          if (!jobIdRef.current && !jobScopeRef.current) setProgress(null);
          return;
        }
        setError(undefined);
        setJobId(submitted.job_id);
        setJobScopeKey(submittedKey);
        writePersistedBatch({ jobId: submitted.job_id, lineKey: submittedKey, keysHash, total: batchItems.length });
      } catch (submitError) {
        if (scopeRef.current?.lineKey !== submittedKey) return;
        setError(submitError instanceof Error ? submitError.message : 'Review batch failed to start.');
        setProgress(current => current && { ...current, running: false });
      }
    })();
  }, [active, coordinator, fetcher]);

  const retry = useCallback(() => { coordinator.retry(); start(); }, [coordinator, start]);

  const scopeKey = scope?.lineKey ?? null;
  // Single definition of "the persisted job owns this mount": the stored
  // entry names this exact line and its content hash matches what this line
  // submits now. Returns the entry plus the matching items so adopters reuse
  // the build; submission stands down on non-null. Both effects read through
  // here so the two can never disagree about who owns a mount.
  const persistedItemsFor = useCallback((key: string | null): { stored: PersistedBatch; items: BatchItem[] } | null => {
    if (!key) return null;
    const stored = readPersistedBatch();
    if (!stored || stored.lineKey !== key) return null;
    const currentItems = buildBatchItems(nodesRef.current, settingsRef.current, enginesRef.current, objectiveLaneRef.current);
    if (!currentItems.length || currentItems.length !== stored.total) return null;
    if (hashBatchKeys(currentItems.map(item => item.key)) !== stored.keysHash) return null;
    return { stored, items: currentItems };
  }, []);
  // Change submission. Play-only in practice (the analysis page passes
  // auto: false and submits through its button): on activation, line change,
  // or settings change, submit — unless mount reconciliation owns this
  // scope, in which case adopting the running job is the only correct move
  // and a POST would duplicate the adopter's job. Keyed on the stable
  // scopeKey string (not scope identity) plus settings, so a parent
  // re-render that rebuilds object identities cannot resubmit. start()
  // itself reads nodes/settings/scope from refs.
  useEffect(() => {
    if (!(auto && active && scopeKey)) return;
    // Already attached to the persisted same-content job: nothing to do. A
    // differing jobId means a newer submission owns the hook, so fall
    // through and resubmit.
    if ((!jobIdRef.current || jobIdRef.current === readPersistedBatch()?.jobId) && persistedItemsFor(scopeKey) !== null) return;
    start();
  }, [auto, active, scopeKey, settings, start, persistedItemsFor]);

  // Mount reconciliation (both workspaces, including manual auto: false):
  // the server job survives a refresh on detached contexts, but the new
  // mount has no jobId. If the persisted entry matches this exact line +
  // content, adopt it and subscribe instead of showing Analyze again.
  // Optimistic running progress avoids an Analyze flash before the status
  // fetch lands; mismatches and gone jobs fall back to Analyze.
  useEffect(() => {
    if (!active || !scopeKey || jobId) return;
    const owned = persistedItemsFor(scopeKey);
    if (!owned) return;
    const { stored, items: currentItems } = owned;
    itemsRef.current = currentItems;
    coordinator.replaceFailures(new Set(currentItems.map(item => item.key)), new Map());
    setError(undefined);
    setProgress({ total: stored.total, done: 0, failed: 0, running: true });
    setJobScopeKey(scopeKey);
    // Drop optimism only while we still own it (no job attached yet and the
    // scope key still ours), so abandoning this GET never wipes a newer
    // scope's own optimistic progress.
    const clearOwnedOptimism = () => {
      if (!jobIdRef.current && jobScopeRef.current === scopeKey) {
        setProgress(null);
        setJobScopeKey(null);
      }
    };
    let cancelled = false;
    void (async () => {
      try {
        const status = await fetchBatchStatus(stored.jobId, fetcher);
        if (cancelled || scopeRef.current?.lineKey !== scopeKey || jobIdRef.current) {
          if (cancelled || scopeRef.current?.lineKey !== scopeKey) clearOwnedOptimism();
          return;
        }
        // Torn-read guard: another tab may have replaced the single shared
        // persisted entry between our read and this GET. Total alone cannot
        // detect it, so re-read and only adopt the job we still own.
        if (readPersistedBatch()?.jobId !== stored.jobId) { clearOwnedOptimism(); return; }
        if (status.total !== stored.total) {
          clearPersistedBatch(stored.jobId);
          clearOwnedOptimism();
          return;
        }
        setJobId(stored.jobId);
        setProgress({ total: status.total, done: status.done, failed: status.failed, running: !status.finished });
        const errors = new Map<string, string>();
        for (const [index, message] of Object.entries(status.errors ?? {})) {
          const item = currentItems[Number(index)];
          if (item) errors.set(item.key, message);
        }
        if (errors.size) coordinator.replaceFailures(new Set(), errors);
        if (status.finished) clearPersistedBatch(stored.jobId);
      } catch (reattachError) {
        if (cancelled || scopeRef.current?.lineKey !== scopeKey || jobIdRef.current) {
          if (cancelled || scopeRef.current?.lineKey !== scopeKey) clearOwnedOptimism();
          return;
        }
        if (reattachError instanceof BatchGoneError) clearPersistedBatch(stored.jobId);
        clearOwnedOptimism();
      }
    })();
    return () => { cancelled = true; };
  }, [active, scopeKey, jobId, coordinator, fetcher]);

  // Scope teardown drops local references only. Nothing cancels: server jobs
  // drain on their own and orphans vanish by absence, so the persisted entry
  // stays for a later reattach. Optimistic reattach progress (scope key set,
  // no id yet) is owned the same way: leaving it behind would stick Analyzing
  // with no job behind it. Finished progress resets too: it belongs to the
  // previous line, and leaving it would linger "Analyzed" over a line that
  // still needs a batch.
  useEffect(() => {
    return () => {
      const id = jobIdRef.current;
      const jobKey = jobScopeRef.current;
      if (id && jobKey && (jobKey === scopeKey || scopeKey === null)) {
        jobIdRef.current = null;
        jobScopeRef.current = null;
        setJobId(null);
        setJobScopeKey(null);
        setProgress(null);
      } else if (!id && jobKey && jobKey === scopeKey) {
        setProgress(null);
        setJobScopeKey(null);
      }
    };
  }, [scopeKey]);
  // Deactivation drops local references only. Nothing cancels: the server job
  // keeps draining and the persisted entry stays for reattach on reactivation.
  useEffect(() => {
    if (!active && (jobId || jobScopeKey)) {
      setJobId(null);
      setJobScopeKey(null);
      setProgress(null);
      setError(undefined);
      itemsRef.current = [];
    }
  }, [active, jobId, jobScopeKey]);

  // Track progress by stream, falling back to polls; reconcile values by prime.
  // Guarded by one lineKey check: late events for a superseded scope are dropped.
  useEffect(() => {
    if (!active || !jobId || !jobScopeKey) return;
    const submittedKey = jobScopeKey;
    const stale = () => scopeRef.current?.lineKey !== submittedKey;
    let stopped = false;
    let primeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPrime = 0;
    const primeController = new AbortController();
    const fail = (message: string) => {
      if (stopped || stale()) return;
      setError(message);
      setProgress(current => current && { ...current, running: false });
    };
    const primeNow = async () => {
      if (stopped || stale()) return;
      lastPrime = Date.now();
      // Focus-first reconciliation when the caller names plies: the visible
      // pair settles in its own small lookup, then the background full-line
      // prime reuses those rows from cache. Throttling (2s coalescing above)
      // and dedupe (store cache check) are unchanged.
      const priority = priorityRef.current;
      try {
        if (priority?.length) await coordinator.primeWithPriority(nodesRef.current, settingsRef.current, primeController.signal, priority);
        else await coordinator.ensure(nodesRef.current, settingsRef.current, { signal: primeController.signal });
      } catch { /* superseded prime */ }
      // The objective lane files server-side with the batch; reconcile it
      // through the same lookup so its badges settle without waiting for a
      // navigation-triggered foreground fetch.
      const objective = objectiveLaneRef.current;
      if (objective && !primeController.signal.aborted) {
        try {
          if (priority?.length) await coordinator.primeWithPriority(nodesRef.current, objective, primeController.signal, priority, ['maia']);
          else await coordinator.ensure(nodesRef.current, objective, { signal: primeController.signal, engines: ['maia'] });
        } catch { /* superseded prime */ }
      }
    };
    const prime = () => {
      if (stopped || stale()) return;
      const now = Date.now();
      if (now - lastPrime < 2000) {
        clearTimeout(primeTimer);
        primeTimer = setTimeout(() => { void primeNow(); }, 2000 - (now - lastPrime));
        return;
      }
      void primeNow();
    };
    const apply = (update: BatchProgress) => {
      if (stopped || stale()) return;
      setProgress({ total: update.total, done: update.done, failed: update.failed, running: !update.finished });
      const errors = new Map<string, string>();
      for (const [index, message] of Object.entries(update.errors ?? {})) {
        const item = itemsRef.current[Number(index)];
        if (item) errors.set(item.key, message);
      }
      if (errors.size) coordinator.replaceFailures(new Set(), errors);
      if (update.finished) clearPersistedBatch(jobId);
      void prime();
    };
    const gone = () => {
      if (stopped || stale() || jobIdRef.current !== jobId) return;
      clearPersistedBatch(jobId);
      fail('The review server forgot this batch.');
    };
    const poll = async () => {
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (stopped || stale()) return;
        try {
          const update = await fetchBatchStatus(jobId, fetcher);
          apply(update);
          if (update.finished) return;
        } catch (pollError) {
          if (stopped || stale()) return;
          if (pollError instanceof BatchGoneError) { gone(); return; }
          fail(pollError instanceof Error ? pollError.message : 'Review batch failed.');
          return;
        }
      }
    };
    void (async () => {
      try {
        await subscribeBatchEvents(jobId, apply, primeController.signal, fetcher);
        if (!stopped && !stale()) void primeNow();
      } catch (streamError) {
        if (stopped || stale() || primeController.signal.aborted) return;
        if (streamError instanceof BatchGoneError) { gone(); return; }
        void poll();
      }
    })();
    const show = () => { void primeNow(); };
    window.addEventListener('online', show);
    return () => {
      stopped = true;
      clearTimeout(primeTimer);
      primeController.abort();
      window.removeEventListener('online', show);
    };
  }, [active, jobId, jobScopeKey, coordinator, fetcher]);

  return { progress, error, start, retry };
}
