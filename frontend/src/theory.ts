import { Chess, type Square } from 'chess.js';
import { applyUci, START_FEN } from './domain';
import type { MaiaSide } from './material';
import { openingAt, type OpeningMatch } from './openings';
import type { DomainOutcome } from './domain';
import type { OpeningRef, Quality, Rarity } from './reviewMetrics';

// Algorithmically detectable chess theory for the move verdict. Every helper
// is pure and never throws: invalid FENs, illegal moves, and out-of-range
// plies yield null/false so the verdict path stays silent instead of
// misfiring. describeMove() owns priority and wording; this module only
// supplies facts.

export type TerminalKind = 'checkmate' | 'stalemate' | 'insufficient' | 'fifty' | 'repetition';
export type NoveltyRef = { priorName: string; priorEco: string };

// History-aware terminal classification. afterOutcome comes from the
// timeline row (history-aware: threefold needs the move list, which a bare
// FEN cannot supply). Draws classify by elimination over FEN-only
// predicates; anything unrecognized stays a generic repetition draw rather
// than claiming a specific rule.
export function classifyTerminal(afterFen: string, afterOutcome: DomainOutcome | null): TerminalKind | null {
  if (!afterOutcome) return null;
  if (afterOutcome.kind === 'checkmate') return 'checkmate';
  let game: Chess;
  try {
    game = new Chess(afterFen);
  } catch {
    return null;
  }
  try {
    if (game.isStalemate()) return 'stalemate';
    if (game.isInsufficientMaterial()) return 'insufficient';
    if (game.isDrawByFiftyMoves()) return 'fifty';
  } catch {
    return null;
  }
  return 'repetition';
}

function kingSquare(game: Chess, color: 'w' | 'b'): Square | null {
  for (const row of game.board()) {
    for (const square of row) {
      if (square && square.type === 'k' && square.color === color) return square.square;
    }
  }
  return null;
}

function neighborSquares(square: Square): Square[] {
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  const out: Square[] = [];
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue;
      const f = file + df;
      const r = rank + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) out.push(`${'abcdefgh'[f]}${r + 1}` as Square);
    }
  }
  return out;
}

// Named mating patterns. Gates are deliberately tight (SAN shape + mover +
// ply bound + board shape) so a coincidental back-rank mate or a late
// Qxf7# never earns a miniature's name. Null covers ordinary mates.
export function matePattern(args: {
  beforeFen: string;
  playedUci: string;
  san: string;
  ply: number;
  afterFen: string;
}): string | null {
  const { beforeFen, playedUci, san, ply, afterFen } = args;
  let before: Chess;
  let after: Chess;
  try {
    before = new Chess(beforeFen);
    after = new Chess(afterFen);
  } catch {
    return null;
  }
  let mated: boolean;
  try {
    mated = after.isCheckmate();
  } catch {
    return null;
  }
  if (!mated) return null;
  const mover = before.turn();
  // Fool's mate: Black mates on h4 within the first five plies against an
  // unmoved White king.
  if (mover === 'b' && san === 'Qh4#' && ply <= 5 && kingSquare(after, 'w') === 'e1') return "Fool's mate";
  // Scholar's mate family: early queen mate on f7/f2/h7/h2.
  if (
    ply <= 9 &&
    ((mover === 'w' && (san === 'Qxf7#' || san === 'Qxh7#')) || (mover === 'b' && (san === 'Qxf2#' || san === 'Qxh2#')))
  ) {
    return "Scholar's mate";
  }
  const to = playedUci.slice(2, 4) as Square;
  const matedColor = after.turn();
  const king = kingSquare(after, matedColor);
  if (!king) return null;
  const piece = san[0];
  // Smothered mate: a knight mates a king whose every flight is off-board
  // or occupied by its own pieces. Attacker-covered-but-empty flights do
  // not count — that is an ordinary mate, not a smother.
  if (piece === 'N') {
    const confined = neighborSquares(king).every(square => {
      const occupant = after.get(square);
      return occupant !== undefined && occupant.color === matedColor;
    });
    if (confined) return 'Smothered mate';
    return null;
  }
  // Back-rank mate: rook or queen mates on the back rank against a king
  // still on its back rank, with the three forward shield squares all held
  // by its own pieces. Without the pawn shield the theme is unsupported.
  if (piece === 'R' || piece === 'Q') {
    const backRank = matedColor === 'b' ? '8' : '1';
    const shieldRank = matedColor === 'b' ? '7' : '2';
    if (king[1] === backRank && to[1] === backRank) {
      const file = king.charCodeAt(0) - 97;
      let shielded = true;
      for (let df = -1; df <= 1; df++) {
        const f = file + df;
        if (f < 0 || f > 7) continue;
        const occupant = after.get(`${'abcdefgh'[f]}${shieldRank}` as Square);
        if (!occupant || occupant.color !== matedColor) {
          shielded = false;
          break;
        }
      }
      if (shielded) return 'Back-rank mate';
    }
  }
  return null;
}

// Known theoretical draws the history-aware outcome misses. chess.js
// isInsufficientMaterial already covers bare kings, K+minor vs K, and
// same-color KB vs KB; KNN vs K cannot force mate but reads as
// non-terminal, so it needs this explicit signature. Pawnless, no
// rooks/queens/bishops, exactly one side holding exactly two knights.
export function isKnownDeadDraw(fen: string): boolean {
  let game: Chess;
  try {
    game = new Chess(fen);
  } catch {
    return false;
  }
  let whiteKnights = 0;
  let blackKnights = 0;
  try {
    for (const row of game.board()) {
      for (const square of row) {
        if (!square || square.type === 'k') continue;
        if (square.type !== 'n') return false;
        if (square.color === 'w') whiteKnights++;
        else blackKnights++;
      }
    }
  } catch {
    return false;
  }
  return (whiteKnights === 2 && blackKnights === 0) || (whiteKnights === 0 && blackKnights === 2);
}

// First move out of book. Requires a prior exact hit, so custom starts
// (empty matches, all-false flags) and already-off-book lines never fire,
// and move 1 can never be a novelty in v1. The standard-start gate is
// belt-and-braces on top of the prior-exact requirement.
export function noveltyRef(
  matches: OpeningMatch[],
  bookFlags: boolean[],
  atPly: number,
  initialFen: string,
): NoveltyRef | null {
  if (initialFen !== START_FEN) return null;
  if (atPly < 1 || atPly > bookFlags.length) return null;
  if (bookFlags[atPly - 1] !== false) return null;
  const prior = openingAt(matches, atPly - 1);
  if (!prior || !prior.isExact) return null;
  return { priorName: prior.name, priorEco: prior.eco };
}

// Underpromotion with a proven point: the queen alternative (same
// from/to, queen) is legal and stalemates, while the played
// underpromotion does not. The from/to rewrite covers capture
// promotions (exd8=N) as well as pushes. Both gates live here so a
// caller cannot assert avoidance while holding a stalemating position.
export function underpromotionAvoidsStalemate(beforeFen: string, playedUci: string, afterFen: string): boolean {
  const match = /^([a-h][1-8])([a-h][1-8])([qrbn])$/.exec(playedUci);
  if (!match || match[3] === 'q') return false;
  try {
    const queenGame = new Chess(beforeFen);
    applyUci(queenGame, `${match[1]}${match[2]}q`);
    if (!queenGame.isStalemate()) return false;
    return !new Chess(afterFen).isStalemate();
  } catch {
    return false;
  }
}

function pawnFileCounts(fen: string, color: 'w' | 'b'): number[] | null {
  let game: Chess;
  try {
    game = new Chess(fen);
  } catch {
    return null;
  }
  const counts = Array(8).fill(0);
  try {
    game.board().forEach(row =>
      row.forEach((square, file) => {
        if (square && square.type === 'p' && square.color === color) counts[file]++;
      }),
    );
  } catch {
    return null;
  }
  return counts;
}

// New pawn-structure damage from this move, observed on the mover's own
// pawns: newly doubled files and newly isolated pawns. Observation only —
// no 'no compensation' claim, which a board scan cannot prove.
export function pawnDamageNote(beforeFen: string, afterFen: string, mover: MaiaSide): string | null {
  const color = mover === 'white' ? 'w' : 'b';
  const before = pawnFileCounts(beforeFen, color);
  const after = pawnFileCounts(afterFen, color);
  if (!before || !after) return null;
  const doubled = (counts: number[]): number => counts.filter(count => count >= 2).length;
  const isolated = (counts: number[]): number => {
    let total = 0;
    counts.forEach((count, file) => {
      if (count > 0 && (counts[file - 1] ?? 0) === 0 && (counts[file + 1] ?? 0) === 0) total += count;
    });
    return total;
  };
  const parts: string[] = [];
  const newlyDoubled = doubled(after) - doubled(before);
  const newlyIsolated = isolated(after) - isolated(before);
  if (newlyDoubled > 0) parts.push(newlyDoubled === 1 ? 'Doubles a pawn.' : 'Doubles pawns.');
  if (newlyIsolated > 0) parts.push(newlyIsolated === 1 ? 'Isolates a pawn.' : 'Isolates pawns.');
  return parts.length ? parts.join(' ') : null;
}

export type VerdictInputs = {
  beforeFen: string;
  afterFen: string;
  afterOutcome: DomainOutcome | null;
  san: string;
  playedUci: string;
  ply: number;
  quality: Quality | undefined;
  rarity: Rarity | undefined;
  opening: OpeningRef | null;
  openingMatches: OpeningMatch[];
  bookFlags: boolean[];
  initialFen: string;
  mover: MaiaSide;
  bestRarity?: Rarity | null;
  materialNote?: string | null;
  // Sound-sacrifice detection is cut from v1: a single move never reduces
  // the mover's own material (moves preserve, captures/promotions gain),
  // so a before→after swing gate is vacuous. A real sacrifice detector
  // needs static exchange evaluation on the destination square.
};

export type VerdictFacts = {
  san: string;
  quality: Quality | undefined;
  rarity: Rarity | undefined;
  opening: OpeningRef | null;
  bestRarity?: Rarity | null;
  materialNote?: string | null;
  terminal: TerminalKind | null;
  matePatternName: string | null;
  deadDraw: boolean;
  underpromotionAvoids: boolean;
  novelty: NoveltyRef | null;
  pawnNote: string | null;
};

// Pure wiring from timeline rows and panel state to describeMove args.
// Encodes every gate: before/after selection, terminal-first priority
// inputs, novelty suppression (terminal, dead draw, Forced, Allowed mate,
// Unreviewed, unknown rarity), and the pawn-note fallback (only
// Blunder/Mistake/Inaccuracy with no material note and no terminal).
// bestRarity and materialNote pass through untouched.
export function verdictInputsForPly(inputs: VerdictInputs): VerdictFacts {
  const {
    beforeFen,
    afterFen,
    afterOutcome,
    san,
    playedUci,
    ply,
    quality,
    rarity,
    opening,
    openingMatches,
    bookFlags,
    initialFen,
    mover,
    bestRarity,
    materialNote,
  } = inputs;
  const terminal = classifyTerminal(afterFen, afterOutcome);
  const matePatternName = terminal === 'checkmate' ? matePattern({ beforeFen, playedUci, san, ply, afterFen }) : null;
  const deadDraw = terminal === null && isKnownDeadDraw(afterFen);
  const underpromotionAvoids =
    terminal === null && !deadDraw && underpromotionAvoidsStalemate(beforeFen, playedUci, afterFen);
  const label = quality?.label;
  const suppressNovelty =
    terminal !== null ||
    deadDraw ||
    underpromotionAvoids ||
    !label ||
    label === 'Forced' ||
    label === 'Allowed mate' ||
    label === 'Unreviewed' ||
    !rarity ||
    rarity.label === 'Unknown';
  const novelty = suppressNovelty ? null : noveltyRef(openingMatches, bookFlags, ply, initialFen);
  const pawnNote =
    !terminal && !materialNote && (label === 'Blunder' || label === 'Mistake' || label === 'Inaccuracy')
      ? pawnDamageNote(beforeFen, afterFen, mover)
      : null;
  return {
    san,
    quality,
    rarity,
    opening,
    bestRarity,
    materialNote,
    terminal,
    matePatternName,
    deadDraw,
    underpromotionAvoids,
    novelty,
    pawnNote,
  };
}
