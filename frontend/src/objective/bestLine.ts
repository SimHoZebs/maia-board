// Objective best-line walk: the suggestion line for a Mistake/Blunder speaks
// the grading lane (bot-2400 tops), never Stockfish's rank-1 PV. A line that
// starts with a move the badge grades as a mistake is the inconsistency this
// removes: grade and suggestion share one voice.
//
// Stockfish still referees: a walked step that runs into a cached forced
// mate for the opponent is vetoed (excluded), and the walk stops extending
// past positions with no cached Stockfish row. Maia proposes, Stockfish
// disposes — as rows land, the line converges deeper. Missing Maia rows name
// a frontier so the caller can fetch exactly one step ahead; the walk never
// fetches itself, so it stays pure and testable.
import { buildTimeline } from '../shared/domain';
import { isMateFor, type Score } from '../review/reviewMetrics';

// Top move at the position reached by `moves` (from the walk's initialFen):
// - { kind: 'top', uci } — settled row names the objective top.
// - { kind: 'none' } — settled without a top (degraded, failed, terminal,
//   or empty list): stop, never fetch.
// - { kind: 'missing' } — no row yet: stop and name the frontier for fetch.
export type WalkTop = { kind: 'top'; uci: string } | { kind: 'none' } | { kind: 'missing' };
// Cached Stockfish score at the position reached by `moves`: same tri-state.
// 'none' covers failed rows; unknown rows are 'missing', never guessed.
export type WalkScore = { kind: 'score'; score: Score } | { kind: 'none' } | { kind: 'missing' };

export type WalkStop =
  | 'complete' // reached maxPlies with every step verified
  | 'need-maia' // next objective top unfetched (maiaFrontier names it)
  | 'need-sf' // line stands, deeper verification unfetched (sfFrontier names it)
  | 'settled' // lane settled without a top, or Stockfish failed: honest end
  | 'terminal' // a walked step ends the game (mates included, then stop)
  | 'illegal' // a lane top is illegal on this board: trust the board, stop
  | 'vetoed'; // a walked step runs into cached forced mate: excluded, stop

export type ObjectiveWalk = {
  // Reply UCIs rooted at the after-position, longest-verified first.
  // Empty exactly when there is nothing consistent to suggest — callers
  // must never fall back to the Stockfish PV here; that was the bug.
  ucis: string[];
  stop: WalkStop;
  // Move prefixes (from the walk's initialFen) whose rows would extend or
  // verify the walk. Null when no fetch helps.
  maiaFrontier: string[] | null;
  sfFrontier: string[] | null;
};

// Hard display cap mirrors the material window (see material.ts): the walk
// never outruns the note that describes it. Callers pass the same window
// they pass to bestLinePreview so line and note always agree on length.
export const WALK_WINDOW_MIN = 1;
export const WALK_WINDOW_MAX = 5;

export function walkObjectiveLine(args: {
  initialFen: string;
  // Analyzed-line moves up to AND INCLUDING the reviewed move (the walk
  // roots at the after-position). Empty only when there is no reviewed move.
  baseMoves: readonly string[];
  maxPlies: number;
  topAt: (moves: string[]) => WalkTop;
  sfAt: (moves: string[]) => WalkScore;
}): ObjectiveWalk {
  const { initialFen, baseMoves, topAt, sfAt } = args;
  const max = Number.isInteger(args.maxPlies)
    ? Math.max(WALK_WINDOW_MIN, Math.min(WALK_WINDOW_MAX, args.maxPlies))
    : WALK_WINDOW_MIN;
  const ucis: string[] = [];
  let moves = [...baseMoves];
  // The walk extends one verified step per settled render as rows land, so
  // the first step is always available exactly when the Mistake/Blunder
  // grade that triggers the line is settled (settled grades carry a top).
  for (let step = 0; step < max; step++) {
    const top = topAt(moves);
    if (top.kind === 'missing') return { ucis, stop: 'need-maia', maiaFrontier: moves, sfFrontier: null };
    if (top.kind === 'none') return { ucis, stop: 'settled', maiaFrontier: null, sfFrontier: null };
    const child = [...moves, top.uci];
    let turn: 'white' | 'black';
    let outcome: unknown;
    try {
      const row = buildTimeline(initialFen, child).rows[child.length];
      turn = row.turn;
      outcome = row.outcome;
    } catch {
      return { ucis, stop: 'illegal', maiaFrontier: null, sfFrontier: null };
    }
    // A step that ends the game joins the line (a delivered mate is the
    // point), then the walk ends: terminal positions carry no lane rows.
    if (outcome) return { ucis: [...ucis, top.uci], stop: 'terminal', maiaFrontier: null, sfFrontier: null };
    const score = sfAt(child);
    if (score.kind === 'missing') {
      // Optimistic include: the step stands on the objective lane and no
      // referee has objected. Verification follows as the row lands.
      return { ucis: [...ucis, top.uci], stop: 'need-sf', maiaFrontier: null, sfFrontier: child };
    }
    if (score.kind === 'score' && isMateFor(score.score, turn)) {
      // Vetoed: the reply walks into forced mate. Excluded, never suggested.
      return { ucis, stop: 'vetoed', maiaFrontier: null, sfFrontier: null };
    }
    ucis.push(top.uci);
    moves = child;
  }
  return { ucis, stop: 'complete', maiaFrontier: null, sfFrontier: null };
}
