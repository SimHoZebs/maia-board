import type { TopMove } from './api';
import { botExpected, deltaBaseline, formatWinrateDelta } from './objective/winrate';
import type { ObjectiveCandidates } from './reviewMetrics';

// One row of the Key moves card: a single UCI with the roles it fulfills plus
// the cross-lane numbers behind it. Roles drive the chips; the numbers drive
// the three columns (2400 share, true win delta, your-Elo share).
export type KeyMoveRole = 'sf-best' | 'best-2400' | 'likely-2400' | 'played';
export type KeyMove = {
  uci: string;
  roles: KeyMoveRole[];
  prob2400: number | null;
  expected2400: number | null;
  probMine: number | null;
  // True game-shift delta (bar-vs-bar including the opponent reply) when the
  // child grading row has settled; null while pending/failed (see pending).
  delta: number | null;
  deltaPending: boolean;
  // Prospective fallback while the child row is missing/failed: server delta
  // when attached, else expected-minus-baseline. Null when no expectation.
  prospective: number | null;
};

export type TrueDeltaEntry = { value: number | null; pending: boolean };

// Union of candidate UCIs whose 2400 child rows the pipeline grades for
// true game-shift deltas. Stockfish best leads: it is the card's first row
// yet appears in neither bot list, so without this its delta would never
// settle. The played move is always queued too: on mainlines its child row
// rides the restore/batch (an instant cache hit), while on fresh branches
// this is the only fetch that settles its delta. Capped at 10 child
// fetches, viewed position only.
export function keyUciOrder(args: { sfBest: string | null; played?: string | undefined; displayMoves: string[]; objectiveMoves: string[] }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (uci: string | null | undefined) => {
    if (typeof uci !== 'string' || uci.length === 0 || seen.has(uci)) return;
    seen.add(uci); out.push(uci);
  };
  push(args.sfBest);
  push(args.played);
  for (const uci of args.displayMoves) push(uci);
  for (const uci of args.objectiveMoves) push(uci);
  return out.slice(0, 10);
}

export function formatProb(prob: number | null): string {
  return prob == null ? '—' : `${Math.round(prob * 100)}%`;
}

export function formatKeyDelta(move: Pick<KeyMove, 'delta' | 'deltaPending' | 'prospective'>): string {
  if (move.delta != null) return formatWinrateDelta(move.delta);
  if (move.deltaPending) return '…';
  if (move.prospective != null) return formatWinrateDelta(move.prospective);
  return '—';
}

// Pure builder for the Key moves card: the union of every received move —
// the 2400 policy list as the backbone, the Stockfish best floating above
// it only when 2400 doesn't list it, display-only moves appended in display
// order, the played move appended when listed nowhere. Same UCIs merge into
// one row carrying every role it fulfills. Expectations for the prospective
// fallback prefer the objective lane, then the display lane (both are
// 2400-valued).
export function buildKeyMoves(args: {
  sfBest: string | null;
  objective?: ObjectiveCandidates | undefined;
  displayTopMoves: TopMove[];
  played?: string | undefined;
  beforeExpected: number | null;
  trueDeltaByUci?: Map<string, TrueDeltaEntry> | undefined;
}): KeyMove[] {
  const { sfBest, objective, displayTopMoves, played, beforeExpected, trueDeltaByUci } = args;
  const entries = objective?.entries ?? [];
  const objByUci = new Map(entries.map(entry => [entry.uci, entry]));
  const dispByUci = new Map(displayTopMoves.map(candidate => [candidate.move, candidate]));
  const bestListed = entries.length > 0 ? Math.max(...entries.map(entry => entry.expected)) : null;
  const { baseline } = deltaBaseline(beforeExpected, bestListed);

  const hasProb = entries.length > 0
    && entries.every(entry => typeof entry.prob === 'number' && Number.isFinite(entry.prob));
  const best2400 = entries.length > 0
    ? entries.reduce((a, b) => (b.expected > a.expected ? b : a)).uci
    : null;
  const likely2400 = hasProb
    ? entries.reduce((a, b) => ((b.prob ?? 0) > (a.prob ?? 0) ? b : a)).uci
    : null;

  const ordered: string[] = [];
  const push = (uci: string | null | undefined) => {
    if (typeof uci !== 'string' || uci.length === 0 || ordered.includes(uci)) return;
    ordered.push(uci);
  };
  if (sfBest && !objByUci.has(sfBest)) push(sfBest);
  for (const entry of entries) push(entry.uci);
  for (const candidate of displayTopMoves) push(candidate.move);
  push(played);

  return ordered.map(uci => {
    const obj = objByUci.get(uci);
    const disp = dispByUci.get(uci);
    const roles: KeyMoveRole[] = [];
    if (uci === sfBest) roles.push('sf-best');
    if (best2400 != null && uci === best2400) roles.push('best-2400');
    if (likely2400 != null && uci === likely2400) roles.push('likely-2400');
    if (played != null && uci === played) roles.push('played');
    const prob2400 = typeof obj?.prob === 'number' && Number.isFinite(obj.prob) ? obj.prob : null;
    const dispExpected = disp ? botExpected(disp.wdl) : null;
    const expected2400 = obj?.expected ?? dispExpected;
    const probMine = typeof disp?.prob === 'number' && Number.isFinite(disp.prob) ? disp.prob : null;
    const trueEntry = trueDeltaByUci?.get(uci);
    const delta = trueEntry?.value ?? null;
    const deltaPending = trueEntry ? trueEntry.value == null && trueEntry.pending : false;
    const serverDelta = typeof obj?.delta === 'number' && Number.isFinite(obj.delta) ? obj.delta : null;
    const prospective = serverDelta ?? (expected2400 != null && baseline != null ? expected2400 - baseline : null);
    return { uci, roles, prob2400, expected2400, probMine, delta, deltaPending, prospective };
  });
}
