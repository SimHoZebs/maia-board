import { Chess, type Square } from 'chess.js';
import { applyUci, findKingSquare } from './domain';
import type { CapturedPiece, MaiaSide } from './material';

// Shared move facts for the verdict tactic layer. One parse per position:
// the played move is applied once up front, and the expensive geometry
// (fork/skewer/pin scans: move-gen plus attack sets) is computed lazily and
// memoized behind getters, so every claimant reads the same facts without
// replaying the move. Cheap O(board) derivations (material swing) stay with
// their callers in material.ts — sharing them would buy nothing.
//
// Contract mirrors the tactic layer: pure, never throws. Illegal positions,
// illegal UCIs, and move-gen failures yield null facts, and claimants stay
// silent on null.

// Single source for tactic exchange values, re-exported by material.ts as
// PIECE_VALUES for display-side API compatibility (one object, no twin to
// drift). material.ts imports this module at runtime; this module imports
// material.ts as `import type` only, so there is no runtime cycle.
export const TACTIC_VALUES: Record<CapturedPiece, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };

// Fork victims include the king (never a capture); every other victim is a
// capturable non-pawn piece.
export type ForkVictim = 'k' | 'q' | 'r' | 'b' | 'n';
const FORK_RANK: Record<Exclude<ForkVictim, 'k'>, number> = { b: 0, n: 1, r: 2, q: 3 };
const isForkVictim = (piece: string): piece is Exclude<ForkVictim, 'k'> =>
  piece === 'q' || piece === 'r' || piece === 'b' || piece === 'n';

export type ForkFacts = {
  // Ordered victim types, king-first then cheapest-first (bishops before
  // knights on the 3-point tie), for the wording layer.
  victims: ForkVictim[];
  hasKing: boolean;
  cheapest: Exclude<ForkVictim, 'k'>;
  cheapestSquare: Square;
  cheapestDefended: boolean;
  forkerType: string;
  // One-recapture net (cheapest value minus forker value) when the cheapest
  // is defended. Positive stays a winning fork (a knight given for a
  // defended rook wins the exchange); zero or negative is contested (the
  // queen-protects-the-bishop case equalizes). Null when the forker is the
  // king, which can never be sacrificed. Positional factors — developed
  // pieces, activity, who leads on the strip — are out of scope: no static
  // scan prices them, and the strip already owns the lead.
  net: number | null;
  // The victim side legally captures the forker right now while the forker
  // is undefended. The capture leg is pin-aware (legal move-gen, including
  // check-evasion); the defender leg is deliberately raw/pin-blind, matching
  // cheapestDefended below — a defender that is itself pinned is still
  // counted, so a pinned-only defense plus a legal take is a known missed
  // suppression (accepted residual; the note errs toward naming pressure).
  // Covers the king-eats-the-forker case too. A hanging forker refutes the
  // tactic outright — claimants suppress on true.
  hanging: boolean;
};

export type SkewerFacts = {
  back: Exclude<ForkVictim, 'k'>;
  backSquare: Square;
  checkerType: 'r' | 'b' | 'q';
  defended: boolean;
  net: number;
  hanging: boolean;
};

export type PinFacts = {
  front: Exclude<ForkVictim, 'k'>;
  frontSquare: Square;
  back: 'k' | 'q' | 'r';
  backSquare: Square;
  pinnerType: 'r' | 'b' | 'q';
  // The victim side legally captures the pinner right now while the pinner
  // is undefended. Same pin-aware capture leg as fork/skewer hanging: a
  // hanging pinner refutes the tactic outright — claimants suppress on true.
  hanging: boolean;
};

export type RecaptureFacts = {
  prevPiece: CapturedPiece;
  thisPiece: CapturedPiece;
  sameSquare: boolean;
  // This-capture value minus previous-capture value, mover-relative pairing:
  // zero is an even exchange, positive wins, negative loses (callers stay
  // silent on negative — praise grades never own a losing recapture).
  net: number;
};

export type MoveFacts = {
  mover: MaiaSide;
  from: Square;
  to: Square;
  san: string;
  captured: CapturedPiece | null;
  captureSquare: Square | null;
  promotion: string | undefined;
  moverPiece: string;
  givesCheck: boolean;
  fork: () => ForkFacts | null;
  skewer: () => SkewerFacts | null;
  pin: () => PinFacts | null;
  recapture: () => RecaptureFacts | null;
};

// Raw (possibly pinned) attackers of a square. Null when the query itself
// fails, so callers stay silent instead of misfiring.
function rawAttackers(game: Chess, square: Square, by: 'w' | 'b'): Square[] | null {
  try { return game.attackers(square, by); } catch { return null; }
}

type ForkVictimDetail = { victim: ForkVictim; square: Square };

// Victims attacked by the piece now on `to`: non-pawns from its legal
// captures in a flipped-turn copy (only the turn field is swapped), plus the
// king iff the destination attacks the king square. Null on failure.
function collectForkVictimDetails(postMoveGame: Chess, to: Square, victimColor: 'w' | 'b', beneficiaryColor: 'w' | 'b'): ForkVictimDetail[] | null {
  try {
    const parts = postMoveGame.fen().split(/\s+/);
    parts[1] = beneficiaryColor;
    const probe = new Chess(parts.join(' '));
    const details: ForkVictimDetail[] = probe.moves({ square: to, verbose: true })
      .filter(move => move.captured && isForkVictim(move.captured.toLowerCase()))
      .map(move => ({ victim: move.captured!.toLowerCase() as Exclude<ForkVictim, 'k'>, square: move.to }));
    const kingSquare = findKingSquare(probe, victimColor);
    if (kingSquare && probe.attackers(kingSquare, beneficiaryColor).includes(to)) details.push({ victim: 'k', square: kingSquare });
    return details;
  } catch { return null; }
}

function orderForkVictimDetails(details: ForkVictimDetail[]): ForkVictimDetail[] | null {
  if (details.length < 2) return null;
  const rest = details.filter((detail): detail is ForkVictimDetail & { victim: Exclude<ForkVictim, 'k'> } => detail.victim !== 'k')
    .sort((a, b) => FORK_RANK[a.victim] - FORK_RANK[b.victim]);
  if (rest.length === 0) return null;
  const king = details.find(detail => detail.victim === 'k');
  return [...(king ? [king] : []), ...rest];
}

function buildForkFacts(postMoveGame: Chess, to: Square, victimColor: 'w' | 'b', beneficiaryColor: 'w' | 'b', forkerType: string): ForkFacts | null {
  const details = collectForkVictimDetails(postMoveGame, to, victimColor, beneficiaryColor);
  if (!details) return null;
  const ordered = orderForkVictimDetails(details);
  if (!ordered) return null;
  const rest = ordered.filter((detail): detail is ForkVictimDetail & { victim: Exclude<ForkVictim, 'k'> } => detail.victim !== 'k');
  const cheapest = rest[0];
  const defended = rawAttackers(postMoveGame, cheapest.square, victimColor);
  if (defended === null) return null;
  const forkerDefenders = rawAttackers(postMoveGame, to, beneficiaryColor);
  if (forkerDefenders === null) return null;
  let takesForker: boolean;
  try {
    takesForker = postMoveGame.moves({ verbose: true }).some(move => move.to === to);
  } catch { return null; }
  const net = forkerType === 'k' ? null : TACTIC_VALUES[cheapest.victim] - (TACTIC_VALUES[forkerType as CapturedPiece] ?? 3);
  return {
    victims: ordered.map(detail => detail.victim),
    hasKing: ordered.some(detail => detail.victim === 'k'),
    cheapest: cheapest.victim,
    cheapestSquare: cheapest.square,
    cheapestDefended: defended.length > 0,
    forkerType,
    net,
    hanging: takesForker && forkerDefenders.length === 0,
  };
}

const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

function squareAt(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${'abcdefgh'[file]}${rank + 1}` as Square;
}

// Checking-skewer geometry: the checker sits on a ray whose first enemy
// piece is the king and whose second is a capturable non-pawn piece —
// the king shields the back piece, and the check forces it off the ray.
// Own pieces block; any other first contact ends the ray. Null when no ray
// qualifies or the position is unreadable. Blocks of the check and captures
// of the checker by third pieces are NOT proven here (v1): the played note
// names only the attack, and the best-line window proves the fall.
function detectSkewerRay(postMoveGame: Chess, to: Square, checkerType: 'r' | 'b' | 'q', victimColor: 'w' | 'b'): { back: Exclude<ForkVictim, 'k'>; backSquare: Square } | null {
  let board: ReturnType<Chess['board']>;
  try { board = postMoveGame.board(); } catch { return null; }
  const at = (square: Square) => {
    const file = square.charCodeAt(0) - 97;
    const rank = square.charCodeAt(1) - 49;
    return board[7 - rank][file];
  };
  const file = to.charCodeAt(0) - 97;
  const rank = to.charCodeAt(1) - 49;
  const dirs = checkerType === 'r' ? ROOK_DIRS : checkerType === 'b' ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
  for (const [df, dr] of dirs) {
    let sawKing = false;
    for (let step = 1; step < 8; step++) {
      const square = squareAt(file + df * step, rank + dr * step);
      if (!square) break;
      let occupant: ReturnType<typeof at>;
      try { occupant = at(square); } catch { return null; }
      if (!occupant) continue;
      if (occupant.color !== victimColor) break;
      if (!sawKing) {
        if (occupant.type !== 'k') break;
        sawKing = true;
        continue;
      }
      const back = occupant.type.toLowerCase();
      return isForkVictim(back) ? { back, backSquare: square } : null;
    }
  }
  return null;
}

function buildSkewerFacts(postMoveGame: Chess, to: Square, victimColor: 'w' | 'b', beneficiaryColor: 'w' | 'b', moverPiece: string, givesCheck: boolean, promotion: string | undefined): SkewerFacts | null {
  // O(1) gates before any scan: direct check by a non-promoting slider.
  if (!givesCheck || promotion) return null;
  if (moverPiece !== 'r' && moverPiece !== 'b' && moverPiece !== 'q') return null;
  const ray = detectSkewerRay(postMoveGame, to, moverPiece, victimColor);
  if (!ray) return null;
  const defended = rawAttackers(postMoveGame, ray.backSquare, victimColor);
  if (defended === null) return null;
  const checkerDefenders = rawAttackers(postMoveGame, to, beneficiaryColor);
  if (checkerDefenders === null) return null;
  let takesChecker: boolean;
  try {
    takesChecker = postMoveGame.moves({ verbose: true }).some(move => move.to === to);
  } catch { return null; }
  return {
    back: ray.back,
    backSquare: ray.backSquare,
    checkerType: moverPiece,
    defended: defended.length > 0,
    net: TACTIC_VALUES[ray.back] - TACTIC_VALUES[moverPiece],
    hanging: takesChecker && checkerDefenders.length === 0,
  };
}

// Pin geometry: the moved slider sits on a ray whose first enemy contact is
// a capturable non-pawn piece (the front) and whose second enemy contact is
// the king or a major piece (the back) — the front shields the back, so it
// cannot move off the ray without exposing the higher value behind it.
// Own pieces block; pawns and kings never count as fronts (pawn pins are
// noise, a king front is a check owned by the skewer story). Null when no
// ray qualifies or the position is unreadable. Like the fork there is no
// fall clause downstream: a relative pin still lets the front move (Ne7
// keeps Nc8/Ng6/Nf5), so the note names only the pressure.
const PIN_BACK_RANK: Record<PinFacts['back'], number> = { k: 0, q: 1, r: 2 };
function detectPinRay(postMoveGame: Chess, to: Square, pinnerType: 'r' | 'b' | 'q', victimColor: 'w' | 'b'): { front: Exclude<ForkVictim, 'k'>; frontSquare: Square; back: 'k' | 'q' | 'r'; backSquare: Square } | null {
  let board: ReturnType<Chess['board']>;
  try { board = postMoveGame.board(); } catch { return null; }
  const at = (square: Square) => {
    const file = square.charCodeAt(0) - 97;
    const rank = square.charCodeAt(1) - 49;
    return board[7 - rank][file];
  };
  const file = to.charCodeAt(0) - 97;
  const rank = to.charCodeAt(1) - 49;
  const dirs = pinnerType === 'r' ? ROOK_DIRS : pinnerType === 'b' ? BISHOP_DIRS : [...ROOK_DIRS, ...BISHOP_DIRS];
  let best: { front: Exclude<ForkVictim, 'k'>; frontSquare: Square; back: 'k' | 'q' | 'r'; backSquare: Square } | null = null;
  for (const [df, dr] of dirs) {
    let front: { piece: Exclude<ForkVictim, 'k'>; square: Square } | null = null;
    for (let step = 1; step < 8; step++) {
      const square = squareAt(file + df * step, rank + dr * step);
      if (!square) break;
      let occupant: ReturnType<typeof at>;
      try { occupant = at(square); } catch { return null; }
      if (!occupant) continue;
      if (occupant.color !== victimColor) break;
      if (!front) {
        const piece = occupant.type.toLowerCase();
        if (!isForkVictim(piece)) break;
        front = { piece, square };
        continue;
      }
      const back = occupant.type.toLowerCase();
      if (back !== 'k' && back !== 'q' && back !== 'r') break;
      const candidate = { front: front.piece, frontSquare: front.square, back: back as 'k' | 'q' | 'r', backSquare: square };
      if (!best || PIN_BACK_RANK[candidate.back] < PIN_BACK_RANK[best.back]) {
        best = candidate;
        if (best.back === 'k') return best;
      }
      break;
    }
  }
  return best;
}

function buildPinFacts(postMoveGame: Chess, to: Square, victimColor: 'w' | 'b', beneficiaryColor: 'w' | 'b', moverPiece: string): PinFacts | null {
  if (moverPiece !== 'r' && moverPiece !== 'b' && moverPiece !== 'q') return null;
  const ray = detectPinRay(postMoveGame, to, moverPiece, victimColor);
  if (!ray) return null;
  const pinnerDefenders = rawAttackers(postMoveGame, to, beneficiaryColor);
  if (pinnerDefenders === null) return null;
  let takesPinner: boolean;
  try {
    takesPinner = postMoveGame.moves({ verbose: true }).some(move => move.to === to);
  } catch { return null; }
  return {
    front: ray.front,
    frontSquare: ray.frontSquare,
    back: ray.back,
    backSquare: ray.backSquare,
    pinnerType: moverPiece,
    hanging: takesPinner && pinnerDefenders.length === 0,
  };
}

const isCapturedPiece = (piece: string): piece is CapturedPiece =>
  piece === 'p' || piece === 'n' || piece === 'b' || piece === 'r' || piece === 'q';

function captureOf(beforeFen: string, uci: string): { piece: CapturedPiece; square: Square } | null {
  try {
    const probe = new Chess(beforeFen);
    const applied = applyUci(probe, uci);
    const piece = applied.captured?.toLowerCase();
    if (!piece || !isCapturedPiece(piece)) return null;
    return { piece, square: applied.to };
  } catch { return null; }
}

export function createMoveFacts(args: {
  beforeFen: string;
  playedUci: string;
  mover: MaiaSide;
  prevBeforeFen?: string | null;
  prevUci?: string | null;
}): MoveFacts | null {
  const { beforeFen, playedUci, mover, prevBeforeFen, prevUci } = args;
  if (typeof playedUci !== 'string' || playedUci.length === 5) return null;
  let postMoveGame: Chess;
  let from: Square;
  let to: Square;
  let san: string;
  let captured: CapturedPiece | null;
  let promotion: string | undefined;
  let moverPiece: string;
  let givesCheck: boolean;
  try {
    postMoveGame = new Chess(beforeFen);
    const applied = applyUci(postMoveGame, playedUci);
    from = applied.from;
    to = applied.to;
    san = applied.san;
    const taken = applied.captured?.toLowerCase();
    captured = taken && isCapturedPiece(taken) ? taken : null;
    promotion = applied.promotion;
    moverPiece = postMoveGame.get(to)?.type?.toLowerCase() ?? '';
    givesCheck = postMoveGame.inCheck();
  } catch { return null; }
  if (!moverPiece) return null;
  const victimColor = mover === 'white' ? 'b' : 'w';
  const beneficiaryColor = mover === 'white' ? 'w' : 'b';
  // One shared post-move game per fact: each builder clones before probing
  // so memoization never observes another fact's mutations. Chess has no
  // clone API — replay the UCI onto a fresh instance (one move, O(1)).
  const freshPostMove = (): Chess | null => {
    try {
      const game = new Chess(beforeFen);
      applyUci(game, playedUci);
      return game;
    } catch { return null; }
  };
  let forkCache: ForkFacts | null | undefined;
  let skewerCache: SkewerFacts | null | undefined;
  let pinCache: PinFacts | null | undefined;
  return {
    mover,
    from,
    to,
    san,
    captured,
    captureSquare: captured ? to : null,
    promotion,
    moverPiece,
    givesCheck,
    fork: () => {
      if (forkCache !== undefined) return forkCache;
      // An opening capture is never fork pressure: a piece taken on the
      // fork move itself must not seed a fork story.
      if (captured || promotion) {
        forkCache = null;
        return forkCache;
      }
      const game = freshPostMove();
      forkCache = game ? buildForkFacts(game, to, victimColor, beneficiaryColor, moverPiece) : null;
      return forkCache;
    },
    skewer: () => {
      if (skewerCache !== undefined) return skewerCache;
      const game = freshPostMove();
      skewerCache = game ? buildSkewerFacts(game, to, victimColor, beneficiaryColor, moverPiece, givesCheck, promotion) : null;
      return skewerCache;
    },
    pin: () => {
      if (pinCache !== undefined) return pinCache;
      // An opening capture is never pin pressure: the taken piece sat on
      // the pinner square itself, and the gain/exchange story owns captures.
      if (captured || promotion) {
        pinCache = null;
        return pinCache;
      }
      const game = freshPostMove();
      pinCache = game ? buildPinFacts(game, to, victimColor, beneficiaryColor, moverPiece) : null;
      return pinCache;
    },
    recapture: () => {
      if (!captured || !prevBeforeFen || !prevUci) return null;
      const prev = captureOf(prevBeforeFen, prevUci);
      if (!prev) return null;
      return {
        prevPiece: prev.piece,
        thisPiece: captured,
        sameSquare: prev.square === to,
        net: TACTIC_VALUES[captured] - TACTIC_VALUES[prev.piece],
      };
    },
  };
}
