import { useEffect, useRef } from 'react';
import { ReviewCoordinator, type ReviewNode, type SettingsInput } from './reviewCoordinator';

// Upper bound on overlapping restores. Steady state holds 0-1; a newer line
// starts its own lookup while the previous is still landing. Past the cap
// the oldest flight goes — a pathological-churn guard (blitzing faster than
// cache reads return), never the normal path.
const MAX_CONCURRENT_RESTORES = 3;

// Bulk cache restore, shared by useReview and usePlayFeedback: settle settled
// rows through the lookup path even when no batch runs. A newer loadKey
// (line content, settings, explicit retry) starts a new restore WITHOUT
// aborting the previous one: lookup rows are content-keyed, so a landing
// stale line can only settle rows the new line still wants (play lines grow
// by append; the shared store merges everything). Aborts happen only on
// unmount, on deactivation, or past the concurrency cap. nodes/settings ride
// refs so object identities rebuilt by a parent render cannot refire a key.
// Backgrounding never aborts.
export function useBulkPrime(args: {
  active: boolean;
  nodes: ReviewNode[];
  settings: SettingsInput;
  coordinator: ReviewCoordinator;
  loadKey: string;
  onSettled?: (error: string | undefined) => void;
}): void {
  const { active, coordinator, loadKey } = args;
  const nodesRef = useRef(args.nodes);
  nodesRef.current = args.nodes;
  const settingsRef = useRef(args.settings);
  settingsRef.current = args.settings;
  const settledRef = useRef(args.onSettled);
  settledRef.current = args.onSettled;
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
    void Promise.resolve(
      coordinator.ensure(nodesRef.current, settingsRef.current, { signal: controller.signal }),
    ).then(
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
