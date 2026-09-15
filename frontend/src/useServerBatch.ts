import { useCallback, useEffect, useRef, useState } from 'react';
import { BatchBusyError, BatchGoneError, buildBatchItems, cancelBatch, fetchBatchStatus, submitBatch, subscribeBatchEvents,
  type BatchItem, type BatchProgress } from './batchReview';
import { subscribeGameDeletes } from './gameRepository';
import type { Engine, LineScope, ReviewCoordinator, ReviewNode, SettingsInput } from './reviewCoordinator';

export type ServerBatchProgress = { total: number; done: number; failed: number; running: boolean };

// Server-batch client: submit(nodes, scope) + progress UI. The scope's
// lineKey owns the job; a scope change or unmount DELETEs the job when its
// scope still matches, and every late SSE/poll/prime callback is ignored by
// a single lineKey guard. Backgrounding never aborts: only scope teardown
// cancels, while a broken stream falls back to polls silently.
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
  const jobIdRef = useRef<string | null>(null);
  jobIdRef.current = jobId;
  const jobScopeRef = useRef<string | null>(null);
  jobScopeRef.current = jobScopeKey;

  const start = useCallback(() => {
    const current = scopeRef.current;
    if (!active || !current) return;
    const submittedKey = current.lineKey;
    const batchItems = buildBatchItems(nodesRef.current, settingsRef.current, engines);
    itemsRef.current = batchItems;
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
          // Single-active background: the explicit action wins, so replace
          // the other job once. Anything else surfaces as a start error.
          if (!(submitError instanceof BatchBusyError)) throw submitError;
          await cancelBatch(submitError.jobId, fetcher);
          submitted = await submitBatch(batchItems, fetcher);
        }
        // Stale submit: the line moved while we were submitting.
        if (scopeRef.current?.lineKey !== submittedKey) { void cancelBatch(submitted.job_id, fetcher).catch(() => undefined); return; }
        setError(undefined);
        setJobId(submitted.job_id);
        setJobScopeKey(submittedKey);
      } catch (submitError) {
        if (scopeRef.current?.lineKey !== submittedKey) return;
        setError(submitError instanceof Error ? submitError.message : 'Review batch failed to start.');
        setProgress(current => current && { ...current, running: false });
      }
    })();
  }, [active, coordinator, engines, fetcher]);

  const retry = useCallback(() => { coordinator.retry(); start(); }, [coordinator, start]);

  useEffect(() => { if (auto && active && scope) start(); }, [auto, active, scope, settings, start]);

  // Scope teardown or deactivation drops its own job. Backgrounding the tab
  // does not run this: only a line change, unmount, or active=false cancels.
  const scopeKey = scope?.lineKey ?? null;
  useEffect(() => {
    return () => {
      const id = jobIdRef.current;
      const jobKey = jobScopeRef.current;
      if (id && jobKey && (jobKey === scopeKey || scopeKey === null)) void cancelBatch(id, fetcher).catch(() => undefined);
    };
  }, [scopeKey, fetcher]);
  useEffect(() => {
    if (!active && jobId) {
      void cancelBatch(jobId, fetcher).catch(() => undefined);
      setJobId(null);
      setJobScopeKey(null);
      setProgress(null);
      setError(undefined);
      itemsRef.current = [];
    }
  }, [active, jobId, fetcher]);

  // Game-delete broadcast: any History delete cancels the active batch job.
  // Conservative superset (unrelated deletes also cancel) — settled rows stay
  // cached and a restart is one click; a starved engine slot is worse.
  useEffect(() => {
    return subscribeGameDeletes(() => {
      const id = jobIdRef.current;
      if (id) void cancelBatch(id, fetcher).catch(() => undefined);
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
      void prime();
    };
    const gone = () => {
      if (stopped || stale() || jobIdRef.current !== jobId) return;
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
