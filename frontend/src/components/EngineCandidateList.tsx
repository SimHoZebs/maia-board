import type { ReactNode } from "react";
import { candidateSan } from "../shared/domain";
import { CandidateList } from "./CandidateList";
import { CandidateRow } from "./CandidateRow";

// Shared engine candidate list: both eval columns render the same
// CandidateList + CandidateRow shape. Callers map their own response type
// (display-Elo top_moves with prob% + winrate delta, objective entries with
// expected% plus prob% + delta when the lane supplies probabilities) into
// `{ uci, metric, delta? }` so this component never branches on engine
// source. `headers` adds one compact icon row over the numeric columns (same
// row structure, so icons sit exactly above their column); lists without
// numeric-column ambiguity omit it.
export type EngineCandidateItem = { uci: string; metric: string; delta?: string };
export type EngineCandidateHeaders = { metric: ReactNode; delta?: ReactNode; label: string };

export function EngineCandidateList({ fen, played, hasMove, items, headers, onSelect }: {
  fen: string;
  played?: string;
  hasMove: boolean;
  items: EngineCandidateItem[];
  headers?: EngineCandidateHeaders;
  onSelect: (uci: string) => void;
}) {
  return (
    <CandidateList>
      {headers && (
        <li className="candidate-header">
          <span className="rank" aria-hidden="true" />
          <span className="candidate-reading">
            <strong aria-hidden="true" />
            <span className="visually-hidden">{headers.label}</span>
            <span className="metrics" aria-hidden="true">
              <span className="metric">{headers.metric}</span>
              {headers.delta !== undefined && <span className="delta">{headers.delta}</span>}
            </span>
          </span>
        </li>
      )}
      {items.map((candidate, index) => {
        const san = candidateSan(fen, candidate.uci);
        const isPlayed = candidate.uci === played;
        return (
          <CandidateRow
            key={`${candidate.uci}:${index}`}
            index={index}
            san={san}
            metric={candidate.metric}
            delta={candidate.delta}
            isPlayed={isPlayed}
            action={{
              label: `Explore ${san}${isPlayed ? " (played)" : ""}${hasMove ? " from before this move" : ""}`,
              onSelect: () => onSelect(candidate.uci),
            }}
          />
        );
      })}
    </CandidateList>
  );
}
