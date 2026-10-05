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

// Heads of the three received lists: the 2400 best by expected score, the
// 2400 most-likely by policy, and my most-likely (display top-1). Together
// with the Stockfish best and the played move these are the card's rows.
export function keyHeads(objective: ObjectiveCandidates | undefined, displayTopMoves: TopMove[]): {
  best2400: string | null; likely2400: string | null; myLikely: string | null;
} {
  const entries = objective?.entries ?? [];
  const hasProb = entries.length > 0
    && entries.every(entry => typeof entry.prob === 'number' && Number.isFinite(entry.prob));
  return {
    best2400: entries.length > 0 ? entries.reduce((a, b) => (b.expected > a.expected ? b : a)).uci : null,
    likely2400: hasProb ? entries.reduce((a, b) => ((b.prob ?? 0) > (a.prob ?? 0) ? b : a)).uci : null,
    myLikely: displayTopMoves.length > 0 ? displayTopMoves[0].move : null,
  };
}

// Row order: Stockfish best, 2400 best, 2400 likely, my likely, played —
// deduped so shared moves merge into one row carrying every role. Never
// more than five rows.
export function keyRowOrder(args: {
  sfBest: string | null; best2400: string | null; likely2400: string | null;
  myLikely: string | null; played?: string | undefined;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (uci: string | null | undefined) => {
    if (typeof uci !== 'string' || uci.length === 0 || seen.has(uci)) return;
    seen.add(uci); out.push(uci);
  };
  push(args.sfBest);
  push(args.best2400);
  push(args.likely2400);
  push(args.myLikely);
  push(args.played);
  return out;
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

// Pure builder for the Key moves card: the 2400 policy list as the
// backbone, the Stockfish best floating above it only when 2400 doesn't
// list it, the played move appended when listed nowhere. Same UCIs merge
// into one row carrying every role it fulfills; display-only runners-up
// stay out (their only reading would be the You share). The display lane
// still feeds per-row You shares and value expectations. Expectations for
// the prospective fallback prefer the objective lane, then the display lane
// (both are 2400-valued).
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

  const { best2400, likely2400, myLikely } = keyHeads(objective, displayTopMoves);
  const ordered = keyRowOrder({ sfBest, best2400, likely2400, myLikely, played });

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
