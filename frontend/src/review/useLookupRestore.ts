import { useEffect, useRef } from 'react';
import {
  ReviewCoordinator,
  type Engine,
  type ReviewNode,
  type SettingsInput,
} from './reviewCoordinator';

// Shared imperative restore: batch progress ticks and lookup restore both
// call the coordinator's single restore entry; only timing differs.
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
    opts.engines !== undefined ? [...opts.engines] : undefined,
    opts.priorityPlies !== undefined && opts.priorityPlies.length > 0
      ? [...opts.priorityPlies]
      : undefined,
  );
}

// Bulk cache restore for pipeline rooms and batch progress. A newer loadKey
// starts a new restore WITHOUT aborting the previous one: rows are
// content-keyed and play lines grow by append, so a stale landing merges
// instead of being discarded. Every restore runs to completion — there is no
// dedup or concurrency cap (the server joins same-key arrivals). Aborts
// happen only on unmount or deactivation. nodes/settings ride refs so
// rebuilt identities cannot refire a key. Backgrounding never aborts.
export function useLookupRestore(args: {
  active: boolean;
  nodes: ReviewNode[];
  settings: SettingsInput;
  coordinator: ReviewCoordinator;
  loadKey: string;
  // Null means the lookup settled clean; a string names the failure.
  // Absent callback (undefined) means nobody listens — not a state.
  onSettled?: (error: string | null) => void;
  // Focus-first restore: node plies to settle before the rest of the line.
  // Rides a ref so an inline literal cannot resubmit every render.
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
  const restoreFlights = useRef(new Map<string, AbortController>());
  const loadKeyRef = useRef(loadKey);
  loadKeyRef.current = loadKey;
  // Deactivation drops everything in flight: an inactive workspace must not
  // keep restoring behind the new mode's back. Aborted flights report nothing;
  // reactivation starts its own lookup below.
  useEffect(() => {
    if (active) return;
    // Copy iteration: aborted flights delete their entries.
    // oxlint-disable-next-line no-useless-spread
    for (const [key, controller] of [...restoreFlights.current]) {
      restoreFlights.current.delete(key);
      controller.abort();
    }
  }, [active]);
  // Unmount-only teardown. The per-key effect below deliberately aborts
  // nothing in its cleanup, so cancellation on teardown lives here alone.
  useEffect(
    () => () => {
      for (const controller of restoreFlights.current.values()) controller.abort();
      restoreFlights.current.clear();
    },
    [],
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    restoreFlights.current.set(loadKey, controller);
    const forget = () => {
      restoreFlights.current.delete(loadKey);
    };
    const task = restoreLookup(
      coordinator,
      nodesRef.current,
      settingsRef.current,
      controller.signal,
      {
        ...(enginesRef.current !== undefined ? { engines: enginesRef.current } : {}),
        ...(priorityRef.current !== undefined && priorityRef.current.length > 0
          ? { priorityPlies: priorityRef.current }
          : {}),
      },
    );
    const settle = (error: string | null) => {
      // Stale restores merged their rows into the shared store on the way
      // out; only the current line's outcome drives retry callers.
      if (loadKeyRef.current !== loadKey) return;
      const settled = settledRef.current;
      if (settled !== undefined) settled(error);
    };
    void Promise.resolve(task).then(
      () => {
        forget();
        settle(null);
      },
      error => {
        forget();
        if (controller.signal.aborted) return;
        settle(error instanceof Error ? error.message : 'Evaluation lookup failed.');
      },
    );
  }, [coordinator, active, loadKey]);
}
