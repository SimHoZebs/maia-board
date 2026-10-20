import { useEffect, useMemo } from 'react';
import { cancelScope, createAbortScope, type AbortScope } from './reviewCoordinator';

// One abort scope per scope key, shared by both rooms of useReviewPipeline:
// analysis scopes by line, play scopes by game. A key change or unmount
// aborts the previous scope's controller (foreground signal). Batch jobs are
// never cancelled: scope change only drops local optimism.
// Backgrounding never aborts: there are no visibility/suspend listeners.
export function useAbortScope(scopeKey: string): AbortScope {
  const scope = useMemo(() => createAbortScope(scopeKey), [scopeKey]);
  useEffect(() => () => cancelScope(scope), [scope]);
  return scope;
}
