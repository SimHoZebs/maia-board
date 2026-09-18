import { useEffect, useRef } from 'react';
import { ReviewCoordinator, type Engine, type ReviewNode, type SettingsInput } from './reviewCoordinator';

// Upper bound on overlapping restores. Steady state holds 0-1; a newer line
// starts its own lookup while the previous is still landing. Past the cap
// the oldest flight goes — a pathological-churn guard (blitzing faster than
// cache reads return), never the normal path.
const MAX_CONCURRENT_RESTORES = 3;

// Shared imperative restore: batch progress and bulk prime are the same
// operation observed two ways. Both call through here to the coordinator's
// single restore entry (store-owned cache-fill + visible-pair-first); only
// the caller's timing differs (loadKey effect below vs 2s-coalesced progress
// ticks in useServerBatch). Batch-specific bits ride as caller-passed keys:
// engines + priorityPlies select the wanted set, nothing branches here.
export function restoreLookup(
  coordinator: ReviewCoordinator,
  nodes: ReviewNode[],
  settings: SettingsInput,
  signal: AbortSignal,
  opts: { engines?: Engine[]; priorityPlies?: readonly number[] } = {},
): Promise<{ total: number; covered: number }> {
  return coordinator.restore(
    nodes,
    settings,
    signal,
    opts.engines ? [...opts.engines] : undefined,
    opts.priorityPlies?.length ? [...opts.priorityPlies] : undefined,
  );
}

// Bulk cache restore, shared by useReviewPipeline (both rooms) and the batch
// progress reconciler: settle settled rows through the lookup path even when
// no batch runs. A newer loadKey (line content, settings, explicit retry)
// starts a new restore WITHOUT aborting the previous one: lookup rows are
// content-keyed, so a landing stale line can only settle rows the new line
// still wants (play lines grow by append; the shared store merges
// everything). Aborts happen only on unmount, on deactivation, or past the
// concurrency cap. nodes/settings ride refs so object identities rebuilt by
// a parent render cannot refire a key. Backgrounding never aborts.
export function useLookupRestore(args: {
  active: boolean;
  nodes: ReviewNode[];
  settings: SettingsInput;
  coordinator: ReviewCoordinator;
  loadKey: string;
  onSettled?: (error: string | undefined) => void;
  // Focus-first restore: ReviewNode .ply values (e.g. focus/current) to settle
  // before the rest of the line. When provided, the single store restore
  // orders those jobs first in the lookup chunks; the store's existing cache
  // check dedupes, so no duplicate fetch storm occurs. Omitted keeps the
  // single full-line restore. Rides a ref like nodes/settings so an inline
  // literal cannot resubmit every render.
  priorityPlies?: readonly number[];
  engines?: Engine[];
}): void {
  const { active, coordinator, loadKey } = args;
  const nodesRef = useRef(args.nodes);
  nodesRef.current = args.nodes;
  const settingsRef = useRef(args.settings);
  settingsRef.current = args.settings;
  const settledRef = useRef(args.onSettled);
  settledRef.current = args.onSettled;
  const priorityRef = useRef(args.priorityPlies);
  priorityRef.current = args.priorityPlies;
  const enginesRef = useRef(args.engines);
  enginesRef.current = args.engines;
  const flights = useRef(new Map<string, AbortController>());
  const loadKeyRef = useRef(loadKey);
  loadKeyRef.current = loadKey;
  // Deactivation drops everything in flight: an inactive workspace must not
  // keep priming behind the new mode's back. Aborted flights report nothing;
  // reactivation starts its own lookup below.
  useEffect(() => {
    if (active) return;
    for (const [key, controller] of [...flights.current]) {
      flights.current.delete(key);
      controller.abort();
    }
  }, [active]);
  // Unmount-only teardown. The per-key effect below deliberately aborts
  // nothing in its cleanup, so cancellation on teardown lives here alone.
  useEffect(() => () => {
    for (const controller of flights.current.values()) controller.abort();
    flights.current.clear();
  }, []);
  useEffect(() => {
    if (!active) return;
    if (flights.current.has(loadKey)) return;
    while (flights.current.size >= MAX_CONCURRENT_RESTORES) {
      const oldest = flights.current.keys().next().value!;
      flights.current.get(oldest)!.abort();
      flights.current.delete(oldest);
    }
    const controller = new AbortController();
    flights.current.set(loadKey, controller);
    const forget = () => { flights.current.delete(loadKey); };
    const task = restoreLookup(coordinator, nodesRef.current, settingsRef.current, controller.signal, {
      ...(enginesRef.current ? { engines: enginesRef.current } : {}),
      ...(priorityRef.current?.length ? { priorityPlies: priorityRef.current } : {}),
    });
    void Promise.resolve(task).then(
      () => {
        forget();
        // Stale flights merged their rows into the shared store on the way
        // out; only the current line's outcome drives retry callers.
        if (loadKeyRef.current === loadKey) settledRef.current?.(undefined);
      },
      (error) => {
        forget();
        if (controller.signal.aborted) return;
        if (loadKeyRef.current === loadKey) {
          settledRef.current?.(error instanceof Error ? error.message : 'Evaluation lookup failed.');
        }
      },
    );
  }, [coordinator, active, loadKey]);
}
