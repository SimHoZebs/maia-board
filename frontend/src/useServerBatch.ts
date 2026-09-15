import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BatchBusyError, BatchGoneError, buildBatchItems, cancelBatch, fetchBatchStatus, submitBatch, subscribeBatchEvents,
  type BatchItem, type BatchProgress } from './batchReview';
import type { Engine, ReviewCoordinator, ReviewNode, SettingsInput } from './reviewCoordinator';

export type ServerBatchProgress = { total: number; done: number; failed: number; running: boolean };

// One client for server-side batches, shared by whole-game analysis and
// live play feedback. Submit builds the request list (stable index order
// for error mapping); progress events and polls reconcile settled rows
// through the coordinator's bulk prime, so values flow through the same
// validated store as foreground work. A replaced line cancels its batch;
// the next submit skips cached rows server-side.
export function useServerBatch(args: {
  active: boolean;
  submitKey: string | null;
  auto: boolean;
  nodes: ReviewNode[];
  settings: SettingsInput;
  engines?: Engine[];
  coordinator: ReviewCoordinator;
  fetcher?: typeof fetch;
}): { progress: ServerBatchProgress | null; error: string | undefined; start: () => void; retry: () => void } {
  const { active, submitKey, auto, nodes, settings, engines, coordinator, fetcher } = args;
  const [wanted, setWanted] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ServerBatchProgress | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [generation, setGeneration] = useState(0);
  const itemsRef = useRef<BatchItem[]>([]);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const retriedGoneRef = useRef<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  jobIdRef.current = jobId;
  const submitKeyRef = useRef(submitKey);
  submitKeyRef.current = submitKey;

  const reset = useCallback((keys: Set<string>) => {
    setJobId(null);
    setProgress(null);
    setError(undefined);
    coordinator.replaceFailures(keys, new Map());
    itemsRef.current = [];
    // A new intent cycle earns a fresh gone-resubmit budget.
    retriedGoneRef.current = null;
  }, [coordinator]);

  const cancel = useCallback((id: string | null) => {
    if (id) void cancelBatch(id, fetcher).catch(() => undefined);
  }, [fetcher]);

  const items = useMemo(() => buildBatchItems(nodes, settings, engines), [nodes, settings, engines?.join(',')]);
  const start = useCallback(() => {
    setError(undefined);
    retriedGoneRef.current = null;
    setWanted(submitKey);
    setGeneration(generation => generation + 1);
  }, [submitKey]);
  const retry = useCallback(() => { coordinator.retry(); start(); }, [coordinator, start]);

  useEffect(() => { if (auto && submitKey) setWanted(submitKey); }, [auto, submitKey]);
  // Leaving the workspace drops the batch (matching the old suspend
  // discipline); backgrounding the browser tab keeps it computing.
  useEffect(() => () => { cancel(jobIdRef.current); }, [cancel]);
  useEffect(() => {
    if (!active && jobId) {
      cancel(jobId);
      reset(new Set(itemsRef.current.map(item => item.key)));
      setWanted(null);
    }
  }, [active, jobId, cancel, reset]);
  // A replaced line invalidates the running batch; the user restarts
  // explicitly and the resubmit skips cached rows.
  useEffect(() => {
    if (wanted && submitKey && wanted !== submitKey) {
      cancel(jobIdRef.current);
      reset(new Set(itemsRef.current.map(item => item.key)));
      setWanted(null);
    }
  }, [wanted, submitKey, cancel, reset]);

  // Submit whenever a new batch is wanted. A 409 adopts nothing: the other
  // job belongs to a different line or tab, so replace it once — the
  // explicit user action (or newest game move) wins.
  useEffect(() => {
    if (!active || !wanted || !submitKey || wanted !== submitKey) return;
    let cancelled = false;
    const controller = new AbortController();
    // Clear only the previous batch's keys: the new batch overwrites its
    // own keys as errors arrive, while an overlapping foreground failure
    // stays visible until then (batch takes ownership per key on arrival).
    const prev = itemsRef.current;
    itemsRef.current = items;
    coordinator.replaceFailures(new Set(prev.map(item => item.key)), new Map());
    setProgress({ total: items.length, done: 0, failed: 0, running: items.length > 0 });
    void (async () => {
      try {
        try {
          const submitted = await submitBatch(items, fetcher);
          if (cancelled) { void cancelBatch(submitted.job_id, fetcher).catch(() => undefined); return; }
          setError(undefined);
          setJobId(submitted.job_id);
        } catch (submitError) {
          if (!(submitError instanceof BatchBusyError)) throw submitError;
          await cancelBatch(submitError.jobId, fetcher);
          const submitted = await submitBatch(items, fetcher);
          if (cancelled) { void cancelBatch(submitted.job_id, fetcher).catch(() => undefined); return; }
          setError(undefined);
          setJobId(submitted.job_id);
        }
      } catch (submitError) {
        if (cancelled || controller.signal.aborted) return;
        setError(submitError instanceof Error ? submitError.message : 'Review batch failed to start.');
        setProgress(current => current && { ...current, running: false });
      }
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [active, wanted, submitKey, generation, coordinator, fetcher, items]);

  // Track progress by stream, falling back to polls; reconcile values by prime.
  // Tracked by job id only: node/settings identity flows through refs so a
  // re-render (or a resubmit generation bump) never tears down the watch.
  useEffect(() => {
    if (!active || !jobId) return;
    let stopped = false;
    let primeTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPrime = 0;
    const primeController = new AbortController();
    const fail = (message: string) => {
      setError(message);
      setProgress(current => current && { ...current, running: false });
    };
    const prime = () => {
      const now = Date.now();
      if (now - lastPrime < 2000) {
        clearTimeout(primeTimer);
        primeTimer = setTimeout(() => { void primeNow(); }, 2000 - (now - lastPrime));
        return;
      }
      void primeNow();
    };
    const primeNow = async () => {
      lastPrime = Date.now();
      try { await coordinator.ensure(nodesRef.current, settingsRef.current, { signal: primeController.signal }); } catch { /* superseded prime */ }
    };
    const apply = (update: BatchProgress) => {
      if (stopped) return;
      setProgress({ total: update.total, done: update.done, failed: update.failed, running: !update.finished });
      const errors = new Map<string, string>();
      for (const [index, message] of Object.entries(update.errors ?? {})) {
        const item = itemsRef.current[Number(index)];
        if (item) errors.set(item.key, message);
      }
      // Set arrivals only: clearing is scoped to submit/reset so an
      // overlapping foreground failure never flickers mid-batch.
      if (errors.size) coordinator.replaceFailures(new Set(), errors);
      void prime();
    };
    // A resubmit already spent for this line makes this observation stale:
    // never paint `forgot` over a healing batch, and never resubmit-loop
    // against a server that keeps evicting.
    const gone = () => {
      if (jobIdRef.current !== jobId) return;
      const key = submitKeyRef.current;
      if (retriedGoneRef.current !== key) {
        retriedGoneRef.current = key;
        setGeneration(generation => generation + 1);
      } else {
        fail('The review server forgot this batch.');
      }
    };
    const poll = async () => {
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        if (stopped) return;
        try {
          const update = await fetchBatchStatus(jobId, fetcher);
          apply(update);
          if (update.finished) return;
        } catch (pollError) {
          if (stopped) return;
          if (pollError instanceof BatchGoneError) { gone(); return; }
          fail(pollError instanceof Error ? pollError.message : 'Review batch failed.');
          return;
        }
      }
    };
    void (async () => {
      try {
        await subscribeBatchEvents(jobId, apply, primeController.signal, fetcher);
        if (!stopped) void primeNow();
      } catch (streamError) {
        if (stopped || primeController.signal.aborted) return;
        // The server forgot the job (restart/eviction): settled rows remain
        // cached, so one resubmit finishes the remainder.
        if (streamError instanceof BatchGoneError) { gone(); return; }
        // A broken stream is routine (backgrounded tab, proxy timeout):
        // polls take over silently and the next snapshot heals the gap.
        void poll();
      }
    })();
    // Dying with the tab is expected; coming back resumes through the
    // poll fallback (the broken stream throws) while the server kept
    // computing, and the snapshot-first stream heals any missed events.
    const show = () => { void primeNow(); };
    window.addEventListener('online', show);
    return () => {
      stopped = true;
      clearTimeout(primeTimer);
      primeController.abort();
      window.removeEventListener('online', show);
    };
  }, [active, jobId, coordinator, fetcher]);

  return { progress, error, start, retry };
}
