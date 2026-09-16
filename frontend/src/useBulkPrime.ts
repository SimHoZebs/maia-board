import { useEffect, useRef } from 'react';
import { ReviewCoordinator, type ReviewNode, type SettingsInput } from './reviewCoordinator';

// Bulk cache restore, shared by useReview and usePlayFeedback: settle settled
// rows through the lookup path even when no batch runs, with signal-abort as
// the only cancel path (backgrounding never aborts). loadKey restarts the
// lookup (line content, settings, or an explicit retry); nodes/settings ride
// refs so object identities rebuilt by a parent render cannot refire it.
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
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void Promise.resolve(
      coordinator.ensure(nodesRef.current, settingsRef.current, { signal: controller.signal }),
    ).then(
      () => {
        if (!controller.signal.aborted) settledRef.current?.(undefined);
      },
      (error) => {
        if (!controller.signal.aborted) {
          settledRef.current?.(error instanceof Error ? error.message : 'Evaluation lookup failed.');
        }
      },
    );
    return () => controller.abort();
  }, [coordinator, active, loadKey]);
}
