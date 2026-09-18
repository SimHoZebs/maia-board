import { candidateSan } from "../domain";
import { CandidateList } from "./CandidateList";
import { CandidateRow } from "./CandidateRow";

// Shared engine candidate list: both eval columns render the same
// CandidateList + CandidateRow shape. Callers map their own response type
// (display-Elo top_moves with prob%, objective entries with expected%) into
// `{ uci, metric }` so this component never branches on engine source.
export type EngineCandidateItem = { uci: string; metric: string };

export function EngineCandidateList({ fen, played, hasMove, previewUci, items, onPreview, onClear, onSelect }: {
  fen: string;
  played?: string;
  hasMove: boolean;
  previewUci: string | null;
  items: EngineCandidateItem[];
  onPreview: (uci: string | null) => void;
  onClear: () => void;
  onSelect: (uci: string) => void;
}) {
  return (
    <CandidateList>
      {items.map((candidate, index) => {
        const san = candidateSan(fen, candidate.uci);
        const isPlayed = candidate.uci === played;
        return (
          <CandidateRow
            key={`${candidate.uci}:${index}`}
            index={index}
            san={san}
            metric={candidate.metric}
            isPlayed={isPlayed}
            preview={{
              label: `Explore ${san}${isPlayed ? " (played)" : ""}${hasMove ? " from before this move" : ""}`,
              active: !hasMove && previewUci === candidate.uci,
              onPreview: () => onPreview(hasMove ? null : candidate.uci),
              onClear,
              onSelect: () => onSelect(candidate.uci),
            }}
          />
        );
      })}
    </CandidateList>
  );
}
