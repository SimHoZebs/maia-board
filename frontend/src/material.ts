import { Chess, type Square } from 'chess.js';
import { applyUci } from './domain';
import { createMoveFacts, TACTIC_VALUES, type ForkFacts, type ForkVictim, type MoveFacts, type PinFacts, type SkewerFacts } from './moveFacts';

export type CapturedPiece = 'p' | 'n' | 'b' | 'r' | 'q';
export type MaiaSide = 'white' | 'black';

// Display-side alias of the single tactic value table (moveFacts.ts owns it;
// this re-export keeps existing import sites stable).
export const PIECE_VALUES: Record<CapturedPiece, number> = TACTIC_VALUES;

// Display order: most valuable first, bishops before knights on the 3-point tie.
const SORT_ORDER: Record<CapturedPiece, number> = { q: 0, r: 1, b: 2, n: 3, p: 4 };

const isCapturedPiece = (piece: string): piece is CapturedPiece =>
  piece === 'p' || piece === 'n' || piece === 'b' || piece === 'r' || piece === 'q';

export const sortCaptured = (pieces: CapturedPiece[]): CapturedPiece[] =>
  [...pieces].sort((a, b) => SORT_ORDER[a] - SORT_ORDER[b]);

// Material from the current board only, so custom starts and promotions are
// exact. Kings are worthless for the lead. Diff is White-relative.
export function materialFromFen(fen: string): { white: number; black: number; diff: number } {
  const board = new Chess(fen).board();
  let white = 0, black = 0;
  for (const row of board) for (const square of row) {
    if (!square || square.type === 'k') continue;
    if (!isCapturedPiece(square.type)) continue;
    if (square.color === 'w') white += PIECE_VALUES[square.type];
    else black += PIECE_VALUES[square.type];
  }
  return { white, black, diff: white - black };
}

export function materialLeadFor(diff: number, color: MaiaSide): number {
  return color === 'white' ? diff : -diff;
}

// Captures made during this line, up to (not including) uptoPly. Walking the
// moves keeps custom starts exact: pieces already missing from the initial
// FEN are never reported as captures. Promotions only affect the FEN-derived
// material score, never this list.
export function capturesFromLine(
  initialFen: string,
  moves: string[],
  uptoPly: number = moves.length,
): { white: CapturedPiece[]; black: CapturedPiece[] } {
  const white: CapturedPiece[] = [];
  const black: CapturedPiece[] = [];
  const game = new Chess(initialFen);
  const clamped = Math.max(0, Math.min(uptoPly, moves.length));
  for (let index = 0; index < clamped; index++) {
    const turn = game.turn();
    const applied = applyUci(game, moves[index]);
    const captured = applied.captured?.toLowerCase();
    if (captured && isCapturedPiece(captured)) {
      if (turn === 'w') white.push(captured);
      else black.push(captured);
    }
  }
  return { white: sortCaptured(white), black: sortCaptured(black) };
}

const GLYPHS: Record<MaiaSide, Record<CapturedPiece, string>> = {
  // Captured pieces keep their own color: white's strip shows black pieces.
  white: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' },
  black: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕' },
};

// Glyph for a piece captured BY side (i.e. drawn in the victim's color).
export const capturedGlyph = (by: MaiaSide, piece: CapturedPiece): string => GLYPHS[by === 'white' ? 'white' : 'black'][piece];

const PIECE_NAMES: Record<CapturedPiece, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };

export function capturedLabel(by: MaiaSide, pieces: readonly CapturedPiece[], lead: number): string {
  const side = by === 'white' ? 'White' : 'Black';
  if (!pieces.length && lead <= 0) return `${side} has captured nothing`;
  const counts = new Map<CapturedPiece, number>();
  for (const piece of pieces) counts.set(piece, (counts.get(piece) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => SORT_ORDER[a[0]] - SORT_ORDER[b[0]])
    .map(([piece, count]) => `${count} ${PIECE_NAMES[piece]}${count === 1 ? '' : 's'}`);
  const taken = parts.length ? `captured ${parts.join(', ')}` : 'captured nothing';
  return lead > 0 ? `${side} ${taken}, up ${lead} pawn${lead === 1 ? '' : 's'}` : `${side} ${taken}`;
}

// Piece taken by the played move itself (the far side of a
// boundary-crossing exchange), for non-promoting captures only. Null for
// quiet moves, promotions (queening adds up to +8 with no capture, owned by
// the promotion story), and bad data. Lets the best-line window below count
// the mover's own take before claiming a fresh loss.
export function playedCapture(beforeFen: string, playedUci: string): CapturedPiece | null {
  if (typeof playedUci !== 'string' || playedUci.length === 5) return null;
  try {
    const piece = applyUci(new Chess(beforeFen), playedUci).captured?.toLowerCase();
    if (!piece || !isCapturedPiece(piece)) return null;
    return piece;
  } catch { return null; }
}
// Best-line material consequence over the next WINDOW plies of a Stockfish
// rank-1 PV rooted at afterFen (the position after the played mistake).
// Returns a bounded second-sentence note or null when there is nothing
// material to say. Gating rules:
// - Mover must lose at least one pawn unit (|swing| >= 1) along the window;
//   neutral or gaining windows stay silent (positional mistakes).
// - Any promotion in the window silences: queening adds up to +8 with no
//   capture and would read as a false "winning" swing.
// - Illegal PVs silence (stale/short lines), never throw in the verdict path.
// - Wording names captured composition (not diff magnitude: diff 2 is
//   ambiguous between R-for-N and two pawns). The claim is bounded by
//   reference: "This line" always renders alongside its clickable PV, so the
//   window needs no "in the next N" suffix and no net figure — the SAN line
//   shows exactly which moves are claimed.
// - Boundary-crossing trades count the played take: the window starts after
//   the played capture, so an even-or-better trade (Bxe7/Rxe7) goes quiet
//   and a remaining net loss names the played take in the composition
//   ("loses a knight for a pawn"). Proven tactic falls keep their claim.
// - When the punishing reply forks two pieces and the window shows the
//   cheaper one falling, the note names the tactic instead ("Nd4 forks
//   White's bishop and queen, losing the bishop."). Exclusivity: the fork
//   sentence claims exactly one unanswered capture, so it fires only when
//   the window composition matches (opp captures exactly the forked piece,
//   mover captures nothing) — anything else keeps the generic composition.
//   Absolute lead is never stated;
//   the player strip already owns that.
// How far down the rank-1 PV the verdict reads. The backend caps PVs at
// five plies, so windows above five would only ever read padding. A display
// concern only: it never enters review cache keys or engine requests, which
// is why it lives outside StockfishSettings (changing it recomputes verdict
// text locally, never refetches). Client-configurable; three is the default.
export const BEST_LINE_WINDOW_MIN = 1;
export const BEST_LINE_WINDOW_MAX = 5;
export const DEFAULT_BEST_LINE_WINDOW = 3;
export function normalizeBestLineWindow(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= BEST_LINE_WINDOW_MIN && value <= BEST_LINE_WINDOW_MAX
    ? value : DEFAULT_BEST_LINE_WINDOW;
}
const PIECE_ARTICLE: Record<CapturedPiece, string> = { p: 'a pawn', n: 'a knight', b: 'a bishop', r: 'a rook', q: 'a queen' };
function piecesText(pieces: CapturedPiece[]): string {
  const counts = new Map<CapturedPiece, number>();
  for (const piece of sortCaptured(pieces)) counts.set(piece, (counts.get(piece) ?? 0) + 1);
  const parts = [...counts.entries()].map(([piece, count]) =>
    count === 1 ? PIECE_ARTICLE[piece] : `${count} ${PIECE_NAMES[piece]}s`);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
export function bestLineMaterialNote(afterFen: string, pv: readonly string[] | undefined, mover: MaiaSide, windowPlies: number = DEFAULT_BEST_LINE_WINDOW, playedTake: CapturedPiece | null = null): string | null {
  const analyzed = analyzeBestLineWindow(afterFen, pv, mover, windowPlies);
  if (!analyzed) return null;
  return noteFromAnalysis(afterFen, analyzed, mover, playedTake);
}

// Clickable PV for the verdict: the validated window slice the note
// describes, tail-trimmed to its last capture and rendered as numbered SAN
// ("11… Nxd4 12. Nxc2") so the claim "This line" has an exact referent. Null whenever the note is null —
// promotions, illegal PVs, missing lines, and non-material windows never
// offer a branch. The caller spawns these ucis as a branch rooted at
// afterFen, landing on its first move so the punishment is on the board.
export type BestLinePreview = { ucis: string[]; sans: string[]; text: string; note: string };
export function bestLinePreview(afterFen: string, pv: readonly string[] | undefined, mover: MaiaSide, windowPlies: number = DEFAULT_BEST_LINE_WINDOW, playedTake: CapturedPiece | null = null): BestLinePreview | null {
  const analyzed = analyzeBestLineWindow(afterFen, pv, mover, windowPlies);
  if (!analyzed) return null;
  // Even non-tactic windows carry a clickable line but no claim: the note
  // owns silence, and the preview stays in agreement with it.
  const note = noteFromAnalysis(afterFen, analyzed, mover, playedTake);
  if (!note) return null;
  const sans = sansFromWindow(afterFen, analyzed.ucis);
  if (!sans) return null;
  return { ucis: analyzed.ucis, sans, text: formatSanLine(afterFen, sans), note };
}

type BestLineAnalysis = { ucis: string[]; oppCaptures: CapturedPiece[]; moverCaptures: CapturedPiece[]; oppSide: string; evenExchange: boolean };
function noteFromAnalysis(afterFen: string, analyzed: BestLineAnalysis, mover: MaiaSide, playedTake: CapturedPiece | null = null): string | null {
  // Even exchanges stay silent in the generic composition (no newsworthy
  // swing) but still reach the tactic layer, which names proven even
  // fork/skewer swaps. Null propagates: preview and note stay in agreement.
  // Boundary-crossing trades count the played take: the window starts after
  // the played capture, so a lone recapture of equal or lesser value
  // (Bxe7/Rxe7: bishop for knight) is a trade, not a fresh loss, and goes
  // quiet. A remaining net loss is named honestly with the played take in
  // the composition ("loses a knight for a pawn"): the take is the reviewed
  // move itself, already on the board, while the PV button shows the reply.
  // Proven tactic falls keep their claim: the named piece really falls to
  // the fork/skewer inside the window.
  const tactic = tacticNote(afterFen, analyzed, mover);
  if (tactic) return tactic;
  if (analyzed.evenExchange) return null;
  if (playedTake != null) {
    const combined = { ...analyzed, moverCaptures: [playedTake, ...analyzed.moverCaptures] };
    const valueOf = (pieces: CapturedPiece[]): number =>
      pieces.reduce((sum, piece) => sum + PIECE_VALUES[piece], 0);
    if (valueOf(combined.moverCaptures) - valueOf(combined.oppCaptures) >= 0) return null;
    return genericNote(combined);
  }
  return genericNote(analyzed);
}
function genericNote(analyzed: BestLineAnalysis): string {
  const oppText = piecesText(sortCaptured(analyzed.oppCaptures));
  if (!analyzed.moverCaptures.length) return `This line wins ${oppText} for ${analyzed.oppSide}.`;
  const moverText = piecesText(sortCaptured(analyzed.moverCaptures));
  return `This line loses ${oppText} for ${moverText}.`;
}

// Fork nouns live here, not in PIECE_NAMES: victims include the king (which
// is never a capture), and the verdict lists bare nouns ("bishop and queen").
// Geometry (victim discovery, ordering, defended-ness, nets) lives in
// moveFacts.ts so every claimant shares one computation; this module owns
// wording only.
const FORK_NOUNS: Record<ForkVictim, string> = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
const FORK_PLURALS: Record<Exclude<ForkVictim, 'k'>, string> = { q: 'queens', r: 'rooks', b: 'bishops', n: 'knights' };
// Names the tactic when PV move 1 forks or skewers with check and the window
// proves the consequence. Three material shapes per tactic:
// - Free win (victim undefended, capture square holds): "Nd4 forks White's
//   bishop and queen, losing the bishop."
// - Contested (the capture square is attacked, so the recapture sits just
//   outside the window): no fall is claimed — "Nd4 forks White's bishop and
//   queen, but only forces an even exchange."
// - Proven exchange (the window itself holds victim-for-forker): winning
//   nets keep the fall ("losing the rook for the knight"), even nets name it
//   ("only forcing an even bishop-for-knight exchange").
// Explicit conflict: a checking skewer outranks a fork on the same move —
// the forced king evacuation is the stronger story. Detection runs on the
// moved piece only (no discovered-attack attribution). An opening capture is
// never tactic pressure. Illegal positions and bad FENs silence, never throw.
function tacticNote(afterFen: string, analyzed: BestLineAnalysis, mover: MaiaSide): string | null {
  if (analyzed.oppCaptures.length !== 1 || analyzed.moverCaptures.length > 1) return null;
  const firstUci = analyzed.ucis[0];
  if (typeof firstUci !== 'string' || firstUci.length === 5) return null;
  // The tactic belongs to the opponent of the mover (the victim side).
  const forker: MaiaSide = mover === 'white' ? 'black' : 'white';
  const facts = createMoveFacts({ beforeFen: afterFen, playedUci: firstUci, mover: forker });
  if (!facts || facts.captured) return null;
  const victimColor = mover === 'white' ? 'w' : 'b';
  const side = mover === 'white' ? "White's" : "Black's";
  const skewer = facts.skewer();
  if (skewer && !skewer.hanging && analyzed.oppCaptures[0] === skewer.back) {
    if (analyzed.moverCaptures.length === 1 && analyzed.moverCaptures[0] !== skewer.checkerType) return null;
    return skewerWindowNote(facts.san, side, skewer, analyzed, afterFen, victimColor);
  }
  const fork = facts.fork();
  if (!fork || fork.hanging) return null;
  if (analyzed.oppCaptures[0] !== fork.cheapest) return null;
  if (analyzed.moverCaptures.length === 1 && analyzed.moverCaptures[0] !== fork.forkerType) return null;
  return forkWindowNote(facts.san, side, fork, analyzed, afterFen, victimColor);
}
// Shared window tail: free fall vs contested vs proven exchange. The window
// is trimmed to its last capture, so the capture square is the destination
// of the final UCI; attacked means the recapture sits one ply past the
// window and no fall may be claimed.
function windowTail(afterFen: string, analyzed: BestLineAnalysis, victimColor: 'w' | 'b'): boolean | null {
  try {
    const replay = new Chess(afterFen);
    let square: Square | null = null;
    for (const uci of analyzed.ucis) {
      const applied = applyUci(replay, uci);
      if (applied.captured) square = applied.to;
    }
    if (!square) return null;
    return replay.attackers(square, victimColor).length > 0;
  } catch { return null; }
}
function forkWindowNote(san: string, side: string, fork: ForkFacts, analyzed: BestLineAnalysis, afterFen: string, victimColor: 'w' | 'b'): string | null {
  const lead = `${san} forks ${side} ${joinVictims(fork.victims)}`;
  if (analyzed.moverCaptures.length === 1) {
    const back = analyzed.moverCaptures[0];
    if (fork.net === null) return null;
    if (fork.net > 0) return `${lead}, losing the ${FORK_NOUNS[fork.cheapest]} for the ${PIECE_NAMES[back]}.`;
    if (fork.net === 0) return `${lead}, only forcing an even ${FORK_NOUNS[fork.cheapest]}-for-${PIECE_NAMES[back]} exchange.`;
    return null;
  }
  const attacked = windowTail(afterFen, analyzed, victimColor);
  if (attacked === null) return null;
  if (attacked) {
    // A looming recapture only contests the claim when the net does not
    // survive it: a knight given for a defended rook still wins the
    // exchange after the queen takes it back.
    if (fork.net !== null && fork.net > 0) return `${lead}, losing the ${FORK_NOUNS[fork.cheapest]}.`;
    return `${lead}, but only forces an even exchange.`;
  }
  return `${lead}, losing the ${FORK_NOUNS[fork.cheapest]}.`;
}
function skewerWindowNote(san: string, side: string, skewer: SkewerFacts, analyzed: BestLineAnalysis, afterFen: string, victimColor: 'w' | 'b'): string | null {
  const lead = `${san} skewers ${side} ${joinVictims(['k', skewer.back])}`;
  if (analyzed.moverCaptures.length === 1) {
    const back = analyzed.moverCaptures[0];
    if (skewer.net > 0) return `${lead}, losing the ${FORK_NOUNS[skewer.back]} for the ${PIECE_NAMES[back]}.`;
    if (skewer.net === 0) return `${lead}, only forcing an even ${FORK_NOUNS[skewer.back]}-for-${PIECE_NAMES[back]} exchange.`;
    return null;
  }
  const attacked = windowTail(afterFen, analyzed, victimColor);
  if (attacked === null) return null;
  if (attacked) {
    if (skewer.net > 0) return `${lead}, losing the ${FORK_NOUNS[skewer.back]}.`;
    return `${lead}, but only forces an even exchange.`;
  }
  return `${lead}, losing the ${FORK_NOUNS[skewer.back]}.`;
}
// Immediate material won by the played move itself (the mirror of the
// best-line window, which reads the opponent's reply). Requires a capture on
// the move plus a matching before→after swing of at least a pawn, so stale or
// mismatched FENs stay silent. Promotions are excluded: queening adds up to
// +8 with no capture and would read as a false win (the promotion note owns
// that story). The caller gates on praise grades, so a blunder capture that
// hangs a bigger piece never earns this. Never throws.
export function playedMoveGainNote(beforeFen: string, afterFen: string, playedUci: string, mover: MaiaSide): string | null {
  if (typeof playedUci !== 'string' || playedUci.length === 5) return null;
  let captured: CapturedPiece | null = null;
  try {
    const probe = new Chess(beforeFen);
    const piece = applyUci(probe, playedUci).captured?.toLowerCase();
    if (!piece || !isCapturedPiece(piece)) return null;
    captured = piece;
  } catch { return null; }
  let swingMover: number;
  try {
    const swingWhite = materialFromFen(afterFen).diff - materialFromFen(beforeFen).diff;
    swingMover = mover === 'white' ? swingWhite : -swingWhite;
  } catch { return null; }
  if (swingMover < 1) return null;
  return `Wins ${piecesText([captured])}.`;
}

// Names the tactic when the played move itself forks two pieces: "Nd4 forks
// White's bishop and queen." Unlike tacticNote there is no "losing the …"
// clause — the fall of a piece is a future claim the immediate board cannot
// prove. Contested forks (cheapest victim defended, no winning net) qualify
// instead of overclaiming: "…, but only forces an even exchange." A hanging
// forker refutes the tactic outright (the victim simply takes it), so the
// note yields to the next positive candidate. Same tight gates (moved piece
// only, no pawns, no opening capture, no promotions). The caller gates on
// praise grades. Never throws.
export function playedMoveForkNote(beforeFen: string, playedUci: string, mover: MaiaSide): string | null {
  const facts = createMoveFacts({ beforeFen, playedUci, mover });
  if (!facts) return null;
  return forkPlayedClaim(facts, mover);
}
export function forkPlayedClaim(facts: MoveFacts, mover: MaiaSide): string | null {
  const fork = facts.fork();
  if (!fork || fork.hanging) return null;
  const side = mover === 'white' ? "Black's" : "White's";
  const lead = `${facts.san} forks ${side} ${joinVictims(fork.victims)}`;
  // Royal tempo and free or winning victims stay unqualified; contested
  // forks name the pressure without claiming a win.
  if (fork.hasKing || !fork.cheapestDefended) return `${lead}.`;
  if (fork.net !== null && fork.net > 0) return `${lead}.`;
  return `${lead}, but only forces an even exchange.`;
}
// Names a checking skewer: a slider checks the king through to a piece
// behind it ("Re7+ skewers Black's king and rook."). The check forces the
// king off the ray, so the back piece is the story — but blocks of the check
// and captures of the checker by third pieces are not proven here (v1), so
// like the fork there is no fall clause and a hanging checker suppresses.
// Capturing checkers outrank the gain note on purpose: a capturing checking
// slider (Rxe7+) tells the forced-evacuation story, not the fresh-win story —
// the taken piece is never part of the claim, so unlike the fork no opening-
// capture exclusion applies. Same praise-grade gating. Never throws.
export function playedMoveSkewerNote(beforeFen: string, playedUci: string, mover: MaiaSide): string | null {
  const facts = createMoveFacts({ beforeFen, playedUci, mover });
  if (!facts) return null;
  return skewerPlayedClaim(facts, mover);
}
export function skewerPlayedClaim(facts: MoveFacts, mover: MaiaSide): string | null {
  const skewer = facts.skewer();
  if (!skewer || skewer.hanging) return null;
  const side = mover === 'white' ? "Black's" : "White's";
  const lead = `${facts.san} skewers ${side} ${joinVictims(['k', skewer.back])}`;
  if (!skewer.defended) return `${lead}.`;
  if (skewer.net > 0) return `${lead}.`;
  return `${lead}, but only forces an even exchange.`;
}
// Names the pin when the played move itself pins a piece to its king or a
// major piece: "Bd6 pins Black's knight to the rook." Like the fork there is
// no fall clause — a relative pin still lets the front move, so the note
// names only the pressure. A hanging pinner refutes the tactic outright (the
// victim simply takes it), so the note yields to the next positive
// candidate. Same tight gates (moved slider only, no pawns, no opening
// capture, no promotions). The caller gates on praise grades; the negative
// concessive path reuses the same claim through pinClaim. Never throws.
export function playedMovePinNote(beforeFen: string, playedUci: string, mover: MaiaSide): string | null {
  const facts = createMoveFacts({ beforeFen, playedUci, mover });
  if (!facts) return null;
  return pinPlayedClaim(facts, mover);
}
export function pinPlayedClaim(facts: MoveFacts, mover: MaiaSide): string | null {
  const pin = facts.pin();
  if (!pin || pin.hanging) return null;
  const side = mover === 'white' ? "Black's" : "White's";
  return `${facts.san} pins ${side} ${FORK_NOUNS[pin.front]} to the ${FORK_NOUNS[pin.back]}.`;
}
// Concessive fusion for negative grades: the pin is real but the position is
// still lost, so it reads as the first clause and the opponent's reply as
// the second. The material note keeps its exact referent ("this line" still
// points at the clickable PV; tactic SAN leads stay verbatim).
export function fusePinWithMaterial(pinClaim: string, materialNote: string): string {
  const lead = pinClaim.endsWith('.') ? pinClaim.slice(0, -1) : pinClaim;
  const tail = materialNote.startsWith('This ') ? `this ${materialNote.slice(5)}` : materialNote;
  return `${lead}, but ${tail}`;
}
export function fusePinWithMate(pinClaim: string): string {
  const lead = pinClaim.endsWith('.') ? pinClaim.slice(0, -1) : pinClaim;
  return `${lead}, but allows mate.`;
}
// Names a same-square recapture as the exchange it is, instead of a fresh
// win: even ("Takes the knight back."), winning ("Wins a knight for a
// pawn."). Losing recaptures stay silent. v1 requires the two takes to share
// a square and looks one ply back only.
export function playedMoveExchangeNote(thisPiece: CapturedPiece, prevPiece: CapturedPiece): string | null {
  const net = PIECE_VALUES[thisPiece] - PIECE_VALUES[prevPiece];
  if (net < 0) return null;
  if (net > 0) return `Wins ${PIECE_ARTICLE[thisPiece]} for ${PIECE_ARTICLE[prevPiece]}.`;
  return `Takes the ${PIECE_NAMES[thisPiece]} back.`;
}
export function exchangePlayedClaim(facts: MoveFacts): string | null {
  const recapture = facts.recapture();
  if (!recapture || !recapture.sameSquare) return null;
  return playedMoveExchangeNote(recapture.thisPiece, recapture.prevPiece);
}
function joinVictims(victims: ForkVictim[]): string {
  if (victims.length === 2 && victims[0] === victims[1] && victims[0] !== 'k') return `both ${FORK_PLURALS[victims[0]]}`;
  const nouns = victims.map(victim => FORK_NOUNS[victim]);
  if (nouns.length <= 1) return nouns[0] ?? '';
  return `${nouns.slice(0, -1).join(', ')} and ${nouns[nouns.length - 1]}`;
}

function sansFromWindow(afterFen: string, window: readonly string[]): string[] | null {
  let game: Chess;
  try { game = new Chess(afterFen); } catch { return null; }
  const sans: string[] = [];
  for (const uci of window) {
    if (typeof uci !== 'string' || uci.length === 5) return null;
    try {
      sans.push(applyUci(game, uci).san);
    } catch { return null; }
  }
  return sans.length ? sans : null;
}

function formatSanLine(afterFen: string, sans: readonly string[]): string {
  let turn = 'w';
  let fullmove = 1;
  try {
    const parts = afterFen.split(/\s+/);
    turn = parts[1] === 'b' ? 'b' : 'w';
    const parsed = Number(parts[5]);
    if (Number.isInteger(parsed) && parsed > 0) fullmove = parsed;
  } catch { /* Fall through with 1 w. */ }
  let currentTurn = turn;
  let currentNo = fullmove;
  const numbered = sans.map(san => {
    const prefix = currentTurn === 'w' ? `${currentNo}.` : `${currentNo}…`;
    if (currentTurn === 'b') currentNo++;
    currentTurn = currentTurn === 'w' ? 'b' : 'w';
    return `${prefix} ${san}`;
  });
  return numbered.join(' ');
}

function analyzeBestLineWindow(afterFen: string, pv: readonly string[] | undefined, mover: MaiaSide, windowPlies: number = DEFAULT_BEST_LINE_WINDOW): BestLineAnalysis | null {
  if (!pv || pv.length === 0) return null;
  const window = pv.slice(0, normalizeBestLineWindow(windowPlies));
  let game: Chess;
  try { game = new Chess(afterFen); } catch { return null; }
  const opp: MaiaSide = mover === 'white' ? 'black' : 'white';
  const oppCaptures: CapturedPiece[] = [];
  const moverCaptures: CapturedPiece[] = [];
  let startDiff: number;
  try { startDiff = materialFromFen(afterFen).diff; } catch { return null; }
  let lastCapture = -1;
  for (const [ply, uci] of window.entries()) {
    if (typeof uci !== 'string' || uci.length === 5) return null; // promotion: material jump without capture
    let turn: string;
    try { turn = game.turn(); } catch { return null; }
    let applied: { captured?: string };
    try { applied = applyUci(game, uci); } catch { return null; }
    const captured = applied.captured?.toLowerCase();
    if (captured && isCapturedPiece(captured)) {
      lastCapture = ply;
      if (turn === 'w' ? mover === 'white' : mover === 'black') moverCaptures.push(captured);
      else oppCaptures.push(captured);
    }
  }
  if (!window.length) return null;
  let swingMover: number;
  try {
    const swingWhite = materialFromFen(game.fen()).diff - startDiff;
    swingMover = mover === 'white' ? swingWhite : -swingWhite;
  } catch { return null; }
  if (swingMover > -1) {
    // Even exchanges (swing 0 with one take per side) flow through flagged:
    // the generic composition stays silent on them below, but the tactic
    // layer still names a proven even fork/skewer swap.
    if (swingMover !== 0 || oppCaptures.length !== 1 || moverCaptures.length !== 1) return null;
    if (!window.length) return null;
    const oppSide = opp === 'white' ? 'White' : 'Black';
    return { ucis: window.slice(0, lastCapture + 1), oppCaptures, moverCaptures, oppSide, evenExchange: true };
  }
  if (!oppCaptures.length) return null; // non-capture swing (should not happen outside promotions, already excluded)
  const oppSide = opp === 'white' ? 'White' : 'Black';
  // Tail-trim to the last capture: trailing quiet moves add nothing to a
  // material claim (no captures, no promotions by the gates above), so the
  // clickable line ends where the story ends. The head is never trimmed —
  // the branch must root at the current position to stay explorable.
  return { ucis: window.slice(0, lastCapture + 1), oppCaptures, moverCaptures, oppSide, evenExchange: false };
}
