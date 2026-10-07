import type { MoveResponse } from '../eval/api';
import type { ObjectivePoint } from '../review/reviewMetrics';

// Winrate math + candidate-display formatting for bot-model rows. Serves
// the candidate-display responsibility (winrate columns in the panel),
// not the grading role: InsightPanel imports this directly regardless of
// which implementation backs the grader. One position's objective point
// from a bot response lives here too, since it is pure WDL arithmetic.

// One position's objective point. A degraded response still carries an
// expectation (shown, not graded); only a clean top move names the best.
export function botPoint(response: Pick<MoveResponse, 'top_moves' | 'wdl' | 'degraded'> | undefined): ObjectivePoint {
  if (!response) return { top: null, expected: null };
  const top = !response.degraded && typeof response.top_moves?.[0]?.move === 'string' ? response.top_moves[0].move : null;
  return { top, expected: botExpected(response.wdl) };
}

// Expected score from a mover-relative WDL triple [loss, draw, win]. WDL
// compresses extremes relative to engine win%, so identical cutoffs flag
// fewer moves — that leniency is the point, not a bug.
export function botExpected(wdl: MoveResponse['wdl']): number {
  const [loss, draw, win] = wdl;
  return 100 * (win + 0.5 * draw);
}

// White-relative WDL percentages (0-100) from a mover-relative triple
// [loss, draw, win]. Turn decides which side the win/loss belong to; draws
// are side-neutral. The bar renders these three segments; expected score
// stays win + draw/2 for grading.
export function botWhiteWdl(wdl: MoveResponse['wdl'], turn: 'white' | 'black'): { white: number; draw: number; black: number } {
  const [loss, draw, win] = wdl;
  return turn === 'white'
    ? { white: win * 100, draw: draw * 100, black: loss * 100 }
    : { white: loss * 100, draw: draw * 100, black: win * 100 };
}
// Display values for the bot analysis list: policy share plus winrate delta
// vs a caller-supplied baseline. The standard caller passes the objective
// (2400) before-position winrate so every row answers gain-versus-before
// from 2400's perspective; without one the delta falls back to the best
// listed winrate (rank within the list). The winrates arrive
// evaluated at 2400-vs-2400 (display lane) or 2400 throughout (objective
// lane); the delta baseline is the caller's baseline, never the list max.
// Deltas are side-to-move-relative: positive always favors whoever's move
// is being viewed. One decimal keeps
// sub-point gaps visible where integer rounding would collapse them to 0.
// Rendered as two separate columns (prob + delta), never a combined string.
// True game-shift delta for one candidate: how the bar WDL would change
// if this candidate were played, including the opponent best reply.
// beforeExpected is the mover-relative grading point before the move;
// childExpected is the mover-relative grading point of the child board
// (opponent to move); childOutcome synthesizes terminals the bot never
// infers (delivered mate wins, draws split). Null while either endpoint
// is missing. Mover-relative: positive favors whoever is to move now.
// This differs from the prospective candidate-minus-baseline above, which
// compares forward child-direct values within one inference and reads 0.0%
// for the policy top by construction.
export function trueCandidateDelta(
  beforeExpected: number | null,
  childExpected: number | null,
  childOutcome: { kind: string } | null | undefined,
): number | null {
  if (beforeExpected == null || !Number.isFinite(beforeExpected)) return null;
  if (childOutcome) {
    const after = childOutcome.kind === 'checkmate' ? 100 : 50;
    return after - beforeExpected;
  }
  if (childExpected == null || !Number.isFinite(childExpected)) return null;
  return (100 - childExpected) - beforeExpected;
}

export function formatWinrateDelta(delta: number): string {
  if (Math.abs(delta) < 0.05) return '0.0%';
  const rounded = (Math.sign(delta) * Math.round(Math.abs(delta) * 10) / 10).toFixed(1);
  return delta > 0 ? `+${rounded}%` : `${rounded}%`;
}

export function botDisplayParts(topMoves: MoveResponse['top_moves'], baseline?: number | null): { prob: string; delta: string }[] {
  if (topMoves.length === 0) return [];
  const best = baseline ?? Math.max(...topMoves.map(candidate => botExpected(candidate.wdl)));
  return topMoves.map(candidate => ({
    prob: `${Math.round(candidate.prob * 100)}%`,
    delta: formatWinrateDelta(botExpected(candidate.wdl) - best),
  }));
}

// One baseline for every row in a candidate list: the before-position 2400
// point when the objective lane has settled it, else the best listed
// winrate, else null. The signature takes no played move and no orientation:
// by construction no row can special-case the played move and no viewing
// side can flip the sign. Deltas stay side-to-move-relative throughout.
export type DeltaBaseline = { baseline: number | null; kind: 'before' | 'best' | null };
export function deltaBaseline(beforeExpected: number | null, bestListed: number | null): DeltaBaseline {
  if (beforeExpected != null) return { baseline: beforeExpected, kind: 'before' };
  if (bestListed != null) return { baseline: bestListed, kind: 'best' };
  return { baseline: null, kind: null };
}

export function deltaColumnTitle(kind: DeltaBaseline['kind']): string {
  switch (kind) {
    case 'before': return 'Win-rate delta versus position before move';
    case 'best': return 'Win-rate change versus 2400 best';
    default: return 'Win-rate change versus best listed move';
  }
}

// Display parts for one candidate list, preferring server-attached deltas.
// The server pairs each row with its before-position 2400 baseline at read
// time (same arithmetic as below); the local comparison is the fallback for
// rows served without delta context (including mixed-version deploys), kept
// exact by the tests beside deltaBaseline.
export type DeltaRow = { prob: number; expected: number; delta?: number | null };
export function selectDeltaParts(
  rows: DeltaRow[],
  server: { value: number; kind: 'before' | 'best' } | undefined | null,
  beforeExpected: number | null,
  bestListed: number | null,
): { parts: { prob: string; delta: string }[]; baseline: number | null; kind: DeltaBaseline['kind'] } {
  if (server && Number.isFinite(server.value) && (server.kind === 'before' || server.kind === 'best')
    && rows.length > 0 && rows.every(row => typeof row.delta === 'number' && Number.isFinite(row.delta))) {
    return {
      parts: rows.map(row => ({ prob: `${Math.round(row.prob * 100)}%`, delta: formatWinrateDelta(row.delta as number) })),
      baseline: server.value,
      kind: server.kind,
    };
  }
  // Local fallback: identical arithmetic to botDisplayParts, over expected
  // values (objective entries carry no WDL). Kept exact by shared tests.
  if (rows.length === 0) {
    const { baseline, kind } = deltaBaseline(beforeExpected, bestListed);
    return { parts: [], baseline, kind };
  }
  const { baseline, kind } = deltaBaseline(beforeExpected, bestListed);
  const best = baseline ?? Math.max(...rows.map(row => row.expected));
  return {
    parts: rows.map(row => ({ prob: `${Math.round(row.prob * 100)}%`, delta: formatWinrateDelta(row.expected - best) })),
    baseline,
    kind,
  };
}
