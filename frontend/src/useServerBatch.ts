import { useCallback, useEffect, useRef, useState } from 'react';
import { BatchBusyError, BatchGoneError, buildBatchItems, cancelBatch, clearPersistedBatch, fetchBatchStatus, hashBatchKeys,
  readPersistedBatch, submitBatch, subscribeBatchEvents, writePersistedBatch,
  type BatchItem, type BatchProgress } from './batchReview';
import { subscribeGameDeletes } from './gameRepository';
import type { Engine, LineScope, ReviewCoordinator, ReviewNode, SettingsInput } from './reviewCoordinator';

export type ServerBatchProgress = { total: number; done: number; failed: number; running: boolean };

// Server-batch client: submit(nodes, scope) + progress UI. The scope's
// lineKey owns the job; a scope change or unmount DELETEs the job when its
// scope still matches, and every late SSE/poll/prime callback is ignored by
// a single lineKey guard. Backgrounding never aborts: only scope teardown
// cancels, while a broken stream falls back to polls silently.
// The submitted job id + content hash persist in localStorage so a reload
// reattaches to the still-running server job instead of showing Analyze
// again. A settings change or different line never reattaches (hash/lineKey
// mismatch); resubmitting the same content attaches to the busy job instead
// of cancelling it.
export function useServerBatch(args: {
  active: boolean;
  nodes: ReviewNode[];
  settings: SettingsInput;
  engines?: Engine[];
  coordinator: ReviewCoordinator;
  scope: LineScope | null;
  auto?: boolean;
  fetcher?: typeof fetch;
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
  const jobIdRef = useRef<string | null>(null);
  jobIdRef.current = jobId;
  const jobScopeRef = useRef<string | null>(null);
  jobScopeRef.current = jobScopeKey;

  const start = useCallback(() => {
    const current = scopeRef.current;
    if (!active || !current) return;
    const submittedKey = current.lineKey;
    const batchItems = buildBatchItems(nodesRef.current, settingsRef.current, enginesRef.current);
    itemsRef.current = batchItems;
    const keysHash = hashBatchKeys(batchItems.map(item => item.key));
    coordinator.replaceFailures(new Set(batchItems.map(item => item.key)), new Map());
    setError(undefined);
    setProgress({ total: batchItems.length, done: 0, failed: 0, running: batchItems.length > 0 });
    if (!batchItems.length) { setJobId(null); setJobScopeKey(null); return; }
    void (async () => {
      try {
        let submitted;
        try {
          submitted = await submitBatch(batchItems, fetcher);
        } catch (submitError) {
          // Single-active background: a different line's explicit action
          // replaces the other job once. The same content (reload, second
          // tab, auto resubmit) attaches to the running job instead so no
          // computed work is discarded.
          if (!(submitError instanceof BatchBusyError)) throw submitError;
          const persisted = readPersistedBatch();
          const sameContent = !!persisted && persisted.jobId === submitError.jobId && persisted.lineKey === submittedKey
            && persisted.keysHash === keysHash && persisted.total === batchItems.length;
          // Already attached to this same-content job (reattach won the
          // race): nothing to do. Content is checked too: new settings or a
          // new line must still fall through to cancel + resubmit below.
          if (sameContent && jobIdRef.current === submitError.jobId) {
            if (scopeRef.current?.lineKey !== submittedKey) return;
            return;
          }
          if (sameContent) {
            if (scopeRef.current?.lineKey !== submittedKey) return;
            itemsRef.current = batchItems;
            setError(undefined);
            setJobId(submitError.jobId);
            setJobScopeKey(submittedKey);
            setProgress({ total: submitError.progress.total, done: submitError.progress.done,
              failed: submitError.progress.failed, running: !submitError.progress.finished });
            const errors = new Map<string, string>();
            for (const [index, message] of Object.entries(submitError.progress.errors ?? {})) {
              const item = batchItems[Number(index)];
              if (item) errors.set(item.key, message);
            }
            if (errors.size) coordinator.replaceFailures(new Set(), errors);
            if (submitError.progress.finished) clearPersistedBatch(submitError.jobId);
            return;
          }
          clearPersistedBatch(submitError.jobId);
          await cancelBatch(submitError.jobId, fetcher);
          submitted = await submitBatch(batchItems, fetcher);
        }
        // Stale submit: the line moved while we were submitting. Cancel the
        // orphan and drop optimism we still own so the new line never inherits
        // a running count with no job behind it.
        if (scopeRef.current?.lineKey !== submittedKey) {
          void cancelBatch(submitted.job_id, fetcher).catch(() => undefined);
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
  // Auto-submit on activation, line change, or settings change. Keyed on the
  // stable scopeKey string (not the scope object identity) plus settings, so
  // a parent re-render that rebuilds object identities cannot resubmit.
  // start() itself reads nodes/settings/scope from refs. When the persisted
  // entry already matches this exact content, the reattach effect below owns
  // the mount: starting here too would POST into a 409 race with the GET and
  // the loser could clear/cancel the job the winner just preserved.
  useEffect(() => {
    if (!(auto && active && scopeKey)) return;
    if (!jobIdRef.current || jobIdRef.current === readPersistedBatch()?.jobId) {
      const stored = readPersistedBatch();
      if (stored && stored.lineKey === scopeKey) {
        const currentItems = buildBatchItems(nodesRef.current, settingsRef.current, enginesRef.current);
        if (currentItems.length && currentItems.length === stored.total
          && hashBatchKeys(currentItems.map(item => item.key)) === stored.keysHash) return;
      }
    }
    start();
  }, [auto, active, scopeKey, settings, start]);

  // Reload reattach: the server job survives a refresh on detached contexts,
  // but the new mount has no jobId. If the persisted entry matches this exact
  // line + content, adopt it and subscribe instead of showing Analyze again.
  // Optimistic running progress avoids an Analyze flash before the status
  // fetch lands; mismatches and gone jobs fall back to Analyze.
  useEffect(() => {
    if (!active || !scopeKey || jobId) return;
    const stored = readPersistedBatch();
    if (!stored || stored.lineKey !== scopeKey) return;
    const currentItems = buildBatchItems(nodesRef.current, settingsRef.current, enginesRef.current);
    if (!currentItems.length || currentItems.length !== stored.total) return;
    if (hashBatchKeys(currentItems.map(item => item.key)) !== stored.keysHash) return;
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
        // slot between our read and this GET. Total alone cannot detect it,
        // so re-read and only adopt the job we still own.
        if (readPersistedBatch()?.jobId !== stored.jobId) { clearOwnedOptimism(); return; }
        if (status.total !== stored.total || (status.cancelled && status.finished)) {
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

  // Scope teardown or deactivation drops its own job. Backgrounding the tab
  // does not run this: only a line change, unmount, or active=false cancels.
  // Optimistic reattach progress (scope key set, no id yet) is owned the same
  // way: leaving it behind would stick Analyzing with no job behind it.
  useEffect(() => {
    return () => {
      const id = jobIdRef.current;
      const jobKey = jobScopeRef.current;
      if (id && jobKey && (jobKey === scopeKey || scopeKey === null)) {
        void cancelBatch(id, fetcher).catch(() => undefined);
        clearPersistedBatch(id);
      } else if (!id && jobKey && jobKey === scopeKey) {
        setProgress(null);
        setJobScopeKey(null);
      }
    };
  }, [scopeKey, fetcher]);
  useEffect(() => {
    if (!active && (jobId || jobScopeKey)) {
      if (jobId) {
        void cancelBatch(jobId, fetcher).catch(() => undefined);
        clearPersistedBatch(jobId);
      }
      setJobId(null);
      setJobScopeKey(null);
      setProgress(null);
      setError(undefined);
      itemsRef.current = [];
    }
  }, [active, jobId, jobScopeKey, fetcher]);

  // Game-delete broadcast: any History delete cancels the active batch job.
  // Conservative superset (unrelated deletes also cancel) — settled rows stay
  // cached and a restart is one click; a starved engine slot is worse.
  useEffect(() => {
    return subscribeGameDeletes(() => {
      const id = jobIdRef.current;
      if (id) {
        void cancelBatch(id, fetcher).catch(() => undefined);
        clearPersistedBatch(id);
      }
      jobIdRef.current = null;
      jobScopeRef.current = null;
      setJobId(null);
      setJobScopeKey(null);
      setProgress(null);
    });
  }, [fetcher]);

  // Track progress by stream, falling back to polls; reconcile values by prime.
  // Guarded by one lineKey check: late events for an aborted scope are dropped.
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
      try { await coordinator.ensure(nodesRef.current, settingsRef.current, { signal: primeController.signal }); } catch { /* superseded prime */ }
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
