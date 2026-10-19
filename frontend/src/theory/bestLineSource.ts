// Best-line source for the material-loss verdict.
//
// The material wording in ./material.ts is provider-neutral: it reads a UCI
// list rooted at the after-FEN and names the captures it proves. Where that
// list comes from is a provider choice owned here, so switching models is a
// one-line change to BEST_LINE_SOURCE instead of edits across rooms.
//
// - 'stockfish': the after-position's rank-1 PV (Evaluation.lines[0].pv).
//   Badge is Stockfish-owned, so the top move can never grade as a mistake —
//   the old Maia-walk inconsistency is gone and no veto walk is needed.
// - 'maia': the grading-lane walk (bot-2400 tops, Stockfish-vetoed) built by
//   useObjectiveBestLine. Kept so the verdict can switch back without
//   re-plumbing callers; rooms should gate the walk fetch on
//   shouldWalkMaia() to avoid wasted traffic while on Stockfish.
import { normalizeBestLineWindow } from './material';
import type { Evaluation } from '../review/reviewMetrics';

export type BestLineSource = 'stockfish' | 'maia';

// Flip this to switch the verdict's material line. Callers resolve through
// resolveBestLineUcis() so both rooms stay in sync.
export const BEST_LINE_SOURCE: BestLineSource = 'stockfish';

export function shouldWalkMaia(source: BestLineSource = BEST_LINE_SOURCE): boolean {
  return source === 'maia';
}

// Stockfish rank-1 PV sliced to the verdict window. Returns undefined when
// there is no usable PV (missing evaluation, no lines, stripped PV, mate or
// terminal rows are gated by callers, not here). bestLinePreview() re-slices
// and validates legality, so this stays a thin projection.
export function stockfishBestLineUcis(
  afterEvaluation: Evaluation | undefined,
  windowPlies: number,
): string[] | undefined {
  const pv = afterEvaluation?.lines[0]?.pv;
  if (!pv || pv.length === 0) return undefined;
  const window = normalizeBestLineWindow(windowPlies);
  const sliced = pv.slice(0, window);
  return sliced.length ? [...sliced] : undefined;
}

// Single resolution point for both rooms. Stockfish wins when selected and
// present; otherwise falls back to the Maia walk when provided (lets the
// line converge as frontier rows land), else undefined (silent verdict).
export function resolveBestLineUcis(args: {
  source?: BestLineSource;
  stockfishUcis: string[] | undefined;
  maiaUcis: string[] | undefined;
}): string[] | undefined {
  const source = args.source ?? BEST_LINE_SOURCE;
  if (source === 'stockfish') {
    if (args.stockfishUcis?.length) return args.stockfishUcis;
    return undefined;
  }
  if (args.maiaUcis?.length) return args.maiaUcis;
  return undefined;
}
