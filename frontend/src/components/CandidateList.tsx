import type { ReactNode } from 'react';

// The `ol.candidate-list` plus the "Played X" fallback shown when the played
// move falls outside the listed candidates. The caller computes `playedSan`
// (null when the played move is listed or absent) so the guard reads the same
// at every call site.
export function CandidateList({ playedSan, children }: { playedSan?: string | null; children: ReactNode }) {
  return <>
    <ol className="candidate-list">{children}</ol>
    {playedSan && <p>Played {playedSan}</p>}
  </>;
}
