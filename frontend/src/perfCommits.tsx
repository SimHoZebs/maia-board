import { Profiler, type ReactNode } from 'react';

export type PerfCommit = {
  id: string; phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number; baseDuration: number; startTime: number; commitTime: number;
};

declare global {
  interface Window { __perfCommits?: PerfCommit[] }
}

const MAX_COMMITS = 50_000;

// Opt-in React commit recorder for the perf client sim. It only activates
// when the harness pre-arms `window.__perfCommits` via an init script, so
// normal runs (and the default browser suite) render exactly as before with
// one extra property check per root render. The sim runs on the profiling
// bundle (`npm run test:perf`), where commit counts and per-commit durations
// are both live; in a production build onRender never fires and the log
// stays empty.
export function CommitRecorder({ children }: { children: ReactNode }) {
  if (typeof window === 'undefined' || !window.__perfCommits) return <>{children}</>;
  return (
    <Profiler
      id="maia-board"
      onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) => {
        record(id, phase, actualDuration, baseDuration, startTime, commitTime);
      }}
    >
      {children}
    </Profiler>
  );
}

function record(id: string, phase: 'mount' | 'update' | 'nested-update', actualDuration: number, baseDuration: number, startTime: number, commitTime: number) {
  const log = window.__perfCommits;
  if (log && log.length < MAX_COMMITS) {
    log.push({ id, phase, actualDuration, baseDuration, startTime, commitTime });
  }
}

// Region attribution for the same harness: wrap a subtree to learn whether
// it re-rendered in a commit and at what cost. Durations of nested profilers
// overlap (a board-stage commit is part of its root commit), so compare
// regions against each other, never sum them.
export function RegionRecorder({ id, children }: { id: string; children: ReactNode }) {
  if (typeof window === 'undefined' || !window.__perfCommits) return <>{children}</>;
  return (
    <Profiler
      id={id}
      onRender={(got, phase, actualDuration, baseDuration, startTime, commitTime) => {
        record(got, phase, actualDuration, baseDuration, startTime, commitTime);
      }}
    >
      {children}
    </Profiler>
  );
}
