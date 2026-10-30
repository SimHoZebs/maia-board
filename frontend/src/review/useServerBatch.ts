import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BatchGoneError,
  buildBatchItems,
  buildBatchLine,
  clearPersistedBatch,
  fetchBatchStatus,
  hashBatchKeys,
  readPersistedBatch,
  submitBatch,
  subscribeBatchEvents,
  writePersistedBatch,
  type BatchItem,
  type BatchProgress,
  type PersistedBatch,
} from './batchReview';
import type { Engine, ReviewCoordinator, ReviewNode, SettingsInput } from './reviewCoordinator';
import { restoreLookup } from './useLookupRestore';

export type ServerBatchProgress = { total: number; done: number; failed: number; running: boolean };

// Shared resume signal: online, bfcache pageshow, tab-visible. Initial
// pageshow rides the mount refresh, so only persisted restores refetch here.
// Window focus is noise. No-op outside browsers.
export function subscribePageResume(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onSignal = (event: Event) => {
    if (event.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
    if (event.type === 'pageshow' && !(event as PageTransitionEvent).persisted) return;
    listener();
  };
  window.addEventListener('online', onSignal);
  window.addEventListener('pageshow', onSignal);
  document.addEventListener('visibilitychange', onSignal);
  return () => {
    window.removeEventListener('online', onSignal);
    window.removeEventListener('pageshow', onSignal);
    document.removeEventListener('visibilitychange', onSignal);
  };
}

// Server-batch client: submit + progress UI. Nothing cancels: scope-key
// changes, unmounts, and game deletes only drop local references while
// server jobs drain; late callbacks are ignored via the scope-key guard, and
// backgrounding never aborts. EventSource ticks are a pure optimization
// over status ground truth. Job id + content hash persist in localStorage
// so a reload reattaches to the still-running job; a settings change or
// different line never reattaches.
export function useServerBatch(args: {
  active: boolean;
  nodes: ReviewNode[];
  settings: SettingsInput;
  engines?: Engine[];
  // Objective lane: extra per-node entries the active source needs beyond
  // Stockfish, hashed and tracked like the rest of the batch.
  objectiveLane?: SettingsInput | null;
  coordinator: ReviewCoordinator;
  // Line identity for job ownership (no abort: a scope change only drops
  // local optimism while the server job drains).
  scopeKey: string | null;
  auto?: boolean;
  fetcher?: typeof fetch;
  // Focus-first restore: node plies to settle before the rest of the line.
  priorityPlies?: readonly number[];
}): {
  progress: ServerBatchProgress | null;
  error: string | null;
  start: () => void;
  retry: () => void;
} {
  const { active, nodes, settings, engines, coordinator, scopeKey, auto, fetcher } = args;
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobScopeKey, setJobScopeKey] = useState<string | null>(null);
  const [progress, setProgress] = useState<ServerBatchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const itemsRef = useRef<BatchItem[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  // engines arrives as an inline literal at the call sites: mirror it into
  // a ref like nodes/settings/scopeKey, or start() gets a new identity every
  // render and re-submits forever.
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
  // normally; completion then restores under the current settings refs.
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const prevSettingsRef = useRef(settings);
  useEffect(() => {
    if (prevSettingsRef.current === settings) return;
    prevSettingsRef.current = settings;
    if (progressRef.current === null || !progressRef.current.running) {
      setJobId(null);
      setJobScopeKey(null);
      setProgress(null);
      setError(null);
      itemsRef.current = [];
    }
  }, [settings]);

  const start = useCallback(() => {
    const submittedKey = scopeKeyRef.current;
    if (!active || !submittedKey) return;
    const batchItems = buildBatchItems(
      nodesRef.current,
      settingsRef.current,
      enginesRef.current,
      objectiveLaneRef.current,
    );
    itemsRef.current = batchItems;
    const keysHash = hashBatchKeys(batchItems.map(item => item.key));
    coordinator.replaceFailures(new Set(batchItems.map(item => item.key)), new Map());
    setError(null);
    setProgress({ total: batchItems.length, done: 0, failed: 0, running: batchItems.length > 0 });
    if (!batchItems.length) {
      setJobId(null);
      setJobScopeKey(null);
      return;
    }
    void (async () => {
      try {
        const submitted = await submitBatch(batchItems, buildBatchLine(nodesRef.current), fetcher);
        // Stale submit: the line moved while we were submitting. Nothing
        // cancels: drop optimism we still own so the new line never inherits
        // a running count with no job behind it. The orphan drains on the
        // server and vanishes by absence.
        if (scopeKeyRef.current === null || scopeKeyRef.current !== submittedKey) {
          if (!jobIdRef.current && !jobScopeRef.current) setProgress(null);
          return;
        }
        setError(null);
        setJobId(submitted.job_id);
        setJobScopeKey(submittedKey);
        writePersistedBatch({
          jobId: submitted.job_id,
          lineKey: submittedKey,
          keysHash,
          total: batchItems.length,
        });
      } catch (submitError) {
        if (scopeKeyRef.current === null || scopeKeyRef.current !== submittedKey) return;
        setError(
          submitError instanceof Error ? submitError.message : 'Review batch failed to start.',
        );
        setProgress(current => current && { ...current, running: false });
      }
    })();
  }, [active, coordinator, fetcher]);

  const retry = useCallback(() => {
    coordinator.retry();
    start();
  }, [coordinator, start]);

  // Single definition of "the persisted job owns this mount": the stored
  // entry names this exact line and its content hash matches what this line
  // submits now. Returns the entry plus the matching items so adopters reuse
  // the build; submission stands down on non-null. Both effects read through
  // here so the two can never disagree about who owns a mount.
  const persistedItemsFor = useCallback(
    (key: string | null): { stored: PersistedBatch; items: BatchItem[] } | null => {
      if (!key) return null;
      const stored = readPersistedBatch();
      if (!stored || stored.lineKey !== key) return null;
      const currentItems = buildBatchItems(
        nodesRef.current,
        settingsRef.current,
        enginesRef.current,
        objectiveLaneRef.current,
      );
      if (!currentItems.length || currentItems.length !== stored.total) return null;
      if (hashBatchKeys(currentItems.map(item => item.key)) !== stored.keysHash) return null;
      return { stored, items: currentItems };
    },
    [],
  );
  // Change submission. Play-only in practice (the analysis page passes
  // auto: false and submits through its button): on activation, line change,
  // or settings change, submit — unless mount restore owns this
  // scope, in which case adopting the running job is the only correct move
  // and a POST would duplicate the adopter's job. Keyed on the stable
  // scopeKey string (not scope identity) plus settings, so a parent
  // re-render that rebuilds object identities cannot resubmit. start()
  // itself reads nodes/settings/scope from refs.
  useEffect(() => {
    if (!(auto && active && scopeKey)) return;
    // Already attached to the persisted same-content job: nothing to do. A
    // differing jobId means a newer submission owns the hook, so fall
    // through and resubmit. No persisted entry reads as a different job.
    const persistedJobId = readPersistedBatch();
    if (
      (!jobIdRef.current ||
        (persistedJobId !== null && jobIdRef.current === persistedJobId.jobId)) &&
      persistedItemsFor(scopeKey) !== null
    )
      return;
    start();
  }, [auto, active, scopeKey, settings, start, persistedItemsFor]);

  // Mount restore path (both workspaces, including manual auto: false):
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
    // Mount-restore sync: adopting a persisted job seeds state once.
    // oxlint-disable-next-line set-state-in-effect
    setError(null);
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
        if (
          cancelled ||
          scopeKeyRef.current === null ||
          scopeKeyRef.current !== scopeKey ||
          jobIdRef.current
        ) {
          if (cancelled || scopeKeyRef.current === null || scopeKeyRef.current !== scopeKey)
            clearOwnedOptimism();
          return;
        }
        // Torn-read guard: another tab may have replaced the single shared
        // persisted entry between our read and this GET. Total alone cannot
        // detect it, so re-read and only adopt the job we still own. A
        // missing entry is a different job, never ours.
        const reread = readPersistedBatch();
        if (reread === null || reread.jobId !== stored.jobId) {
          clearOwnedOptimism();
          return;
        }
        if (status.total !== stored.total) {
          clearPersistedBatch(stored.jobId);
          clearOwnedOptimism();
          return;
        }
        setJobId(stored.jobId);
        setProgress({
          total: status.total,
          done: status.done,
          failed: status.failed,
          running: !status.finished,
        });
        const errors = new Map<string, string>();
        for (const [index, message] of Object.entries(status.errors ?? {})) {
          const item = currentItems[Number(index)];
          if (item) errors.set(item.key, message);
        }
        if (errors.size) coordinator.replaceFailures(new Set(), errors);
        if (status.finished) clearPersistedBatch(stored.jobId);
      } catch (reattachError) {
        if (
          cancelled ||
          scopeKeyRef.current === null ||
          scopeKeyRef.current !== scopeKey ||
          jobIdRef.current
        ) {
          if (cancelled || scopeKeyRef.current === null || scopeKeyRef.current !== scopeKey)
            clearOwnedOptimism();
          return;
        }
        if (reattachError instanceof BatchGoneError) clearPersistedBatch(stored.jobId);
        clearOwnedOptimism();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, scopeKey, jobId, coordinator, fetcher, persistedItemsFor]);

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
  // Deactivation sync: guarded by active/id ownership, no loop.
  /* oxlint-disable set-state-in-effect */
  useEffect(() => {
    if (!active && (jobId || jobScopeKey)) {
      setJobId(null);
      setJobScopeKey(null);
      setProgress(null);
      setError(null);
      itemsRef.current = [];
    }
  }, [active, jobId, jobScopeKey]);
  /* oxlint-enable set-state-in-effect */

  // Track progress by EventSource ticks against status ground truth,
  // restoring through the shared lookup restore. One scope-key guard drops
  // late events for superseded lines.
  useEffect(() => {
    if (!active || !jobId || !jobScopeKey) return;
    const submittedKey = jobScopeKey;
    const stale = () => scopeKeyRef.current === null || scopeKeyRef.current !== submittedKey;
    let stopped = false;
    let restoreTimer: ReturnType<typeof setTimeout> | undefined;
    let lastRestore = 0;
    const restoreController = new AbortController();
    const fail = (message: string) => {
      if (stopped || stale()) return;
      setError(message);
      setProgress(current => current && { ...current, running: false });
    };
    const restoreNow = async () => {
      if (stopped || stale()) return;
      lastRestore = Date.now();
      // Batch-specific keys ride the shared restore: the visible pair (when
      // the caller names plies) settles first, then the background full-line
      // remainder reuses those rows from cache. Throttling (2s coalescing
      // above) and dedupe (store cache check) are unchanged.
      const priority = priorityRef.current;
      try {
        await restoreLookup(
          coordinator,
          nodesRef.current,
          settingsRef.current,
          restoreController.signal,
          // Conditional field: omitted when no priority plies ride along.
          // oxlint-disable-next-line no-useless-spread
          { ...(priority !== undefined && priority.length > 0 ? { priorityPlies: priority } : {}) },
        );
      } catch {
        /* superseded restore */
      }
      // The objective lane files server-side with the batch; restore it
      // through the same lookup so its badges settle without waiting for a
      // navigation-triggered foreground ask.
      const objective = objectiveLaneRef.current;
      if (objective && !restoreController.signal.aborted) {
        try {
          await restoreLookup(coordinator, nodesRef.current, objective, restoreController.signal, {
            engines: ['maia'],
            ...(priority !== undefined && priority.length > 0 ? { priorityPlies: priority } : {}),
          });
        } catch {
          /* superseded restore */
        }
      }
    };
    const scheduleRestore = () => {
      if (stopped || stale()) return;
      const now = Date.now();
      if (now - lastRestore < 2000) {
        clearTimeout(restoreTimer);
        restoreTimer = setTimeout(
          () => {
            void restoreNow();
          },
          2000 - (now - lastRestore),
        );
        return;
      }
      void restoreNow();
    };
    const apply = (update: BatchProgress) => {
      if (stopped || stale()) return;
      setProgress({
        total: update.total,
        done: update.done,
        failed: update.failed,
        running: !update.finished,
      });
      const errors = new Map<string, string>();
      for (const [index, message] of Object.entries(update.errors ?? {})) {
        const item = itemsRef.current[Number(index)];
        if (item) errors.set(item.key, message);
      }
      if (errors.size) coordinator.replaceFailures(new Set(), errors);
      if (update.finished) clearPersistedBatch(jobId);
      void scheduleRestore();
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
          if (pollError instanceof BatchGoneError) {
            gone();
            return;
          }
          fail(pollError instanceof Error ? pollError.message : 'Review batch failed.');
          return;
        }
      }
    };
    // Ground-truth refresh: status first (gone jobs surface here), then the
    // shared lookup restore rides inside apply. Used on mount, resume signals,
    // and stream error.
    const refreshFromStatus = async () => {
      if (stopped || stale()) return;
      try {
        apply(await fetchBatchStatus(jobId, fetcher));
      } catch (statusError) {
        if (stopped || stale()) return;
        if (statusError instanceof BatchGoneError) {
          gone();
          return;
        }
        fail(statusError instanceof Error ? statusError.message : 'Review batch failed.');
      }
    };
    // Mount restores from ground truth immediately instead of waiting for
    // the first live tick.
    void refreshFromStatus();
    void (async () => {
      try {
        await subscribeBatchEvents(jobId, apply, restoreController.signal);
        if (!stopped && !stale()) void restoreNow();
      } catch {
        if (stopped || stale() || restoreController.signal.aborted) return;
        void refreshFromStatus();
        void poll();
      }
    })();
    const unsubscribeResume = subscribePageResume(() => void refreshFromStatus());
    return () => {
      stopped = true;
      clearTimeout(restoreTimer);
      restoreController.abort();
      unsubscribeResume();
    };
  }, [active, jobId, jobScopeKey, coordinator, fetcher]);

  return { progress, error, start, retry };
}
