import { useEffect, useMemo } from 'react';
import { cancelScope, createLineScope, type LineScope } from './reviewCoordinator';

// One abort scope per line, shared by useReview and usePlayFeedback.
// A line change or unmount aborts the previous scope's controller
// (foreground signal); the batch hook DELETEs its job on scope match.
// Backgrounding never aborts: there are no visibility/suspend listeners.
export function useLineScope(lineKey: string): LineScope {
  const scope = useMemo(() => createLineScope(lineKey), [lineKey]);
  useEffect(() => () => cancelScope(scope), [scope]);
  return scope;
}
