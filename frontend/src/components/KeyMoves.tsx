import { Bot, Fish, TrendingDown, Users } from "lucide-react";
import { candidateSan } from "../shared/domain";
import { formatKeyDelta, formatProb, type KeyMove } from "../review/keyMoves";
import { CandidateList } from "./CandidateList";

// The only marker is the Stockfish fish: best/likely at 2400 already read
// off the 2400 and delta columns, and the green row already says played.
function KeyMark({ move }: { move: KeyMove }) {
  if (!move.roles.includes('sf-best')) return null;
  return (
    <span className="key-roles">
      <span className="key-role key-role--sf-best" title="Stockfish best move">
        <Fish size={12} aria-hidden="true" />
        <span className="visually-hidden">Stockfish best</span>
      </span>
    </span>
  );
}

// Key moves card: one fused row per head move (SF best, 2400 best,
// 2400 most-likely, my likely, played) instead of two parallel 5-row engine
// lists. Each row carries the 2400 policy share, the viewed-Elo share, and
// the true game-shift win delta, so the SF-vs-human and best-vs-likely
// comparisons read off one line. Preview/branch interactions match the
// engine candidate lists exactly (hover previews, click branches).
export function KeyMovesList({ fen, played, hasMove, previewUci, moves, deltaTitle, mineTitle, onPreview, onClear, onSelect }: {
  fen: string;
  played?: string;
  hasMove: boolean;
  previewUci: string | null;
  moves: KeyMove[];
  deltaTitle: string;
  mineTitle: string;
  onPreview: (uci: string | null) => void;
  onClear: () => void;
  onSelect: (uci: string) => void;
}) {
  return (
    <CandidateList>
      <li className="candidate-header key-header">
        <span className="candidate-reading">
          <strong aria-hidden="true" />
          <span className="visually-hidden">{`Share of 2400 play, your share, and ${deltaTitle.charAt(0).toLowerCase()}${deltaTitle.slice(1)}`}</span>
          <span className="metrics key-metrics" aria-hidden="true">
            <span className="metric" title="Share of 2400 play"><Bot size={13} aria-hidden="true" /></span>
            <span className="metric metric--mine" title={mineTitle}><Users size={13} aria-hidden="true" /></span>
            <span className="delta" title={deltaTitle}><TrendingDown size={13} aria-hidden="true" /></span>
          </span>
        </span>
      </li>
      {moves.map((move, index) => {
        const san = candidateSan(fen, move.uci);
        const isPlayed = move.uci === played;
        const label = `Explore ${san}${isPlayed ? " (played)" : ""}${hasMove ? " from before this move" : ""}`;
        return (
          <li key={`${move.uci}:${index}`} className={isPlayed ? 'played' : undefined}>
            <button
              type="button"
              className="candidate-reading"
              aria-label={label}
              aria-pressed={!hasMove && previewUci === move.uci}
              onMouseEnter={() => onPreview(hasMove ? null : move.uci)}
              onFocus={() => onPreview(hasMove ? null : move.uci)}
              onMouseLeave={onClear}
              onBlur={onClear}
              onClick={() => onSelect(move.uci)}
            >
              {isPlayed && <span className="visually-hidden">Played, </span>}
              <span className="key-main">
                <strong>{san}</strong>
                <KeyMark move={move} />
              </span>
              <span className="metrics key-metrics">
                <span className="metric" title={move.prob2400 == null ? "Unlisted at 2400" : "Share of 2400 play"}>{formatProb(move.prob2400)}</span>
                <span className="metric metric--mine" title={mineTitle}>{formatProb(move.probMine)}</span>
                <span className="delta" title={deltaTitle}>{formatKeyDelta(move)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </CandidateList>
  );
}
