import type { Chess } from 'chess.js';
import type { MoveResponse } from './api';
import type { DomainOutcome } from './domain';
import type { NoveltyRef, TerminalKind } from './theory';
import { fusePinWithMate, fusePinWithMaterial } from './material';
export const SEARCH_POLICY = 'sf19-n100k-ms750-mpv2-t4-h128-v3';
export const REVIEW_METHOD = 'maia-board-review-v1';
export type Score = { type: 'cp' | 'mate'; value: number; winning_side?: 'white' | 'black' };
export type Evaluation = { engine: 'Stockfish 19'; search_policy: string; depth: number; terminal: null | 'white_win' | 'black_win' | 'draw'; best_move: string | null; score: Score; lines: { move: string; score: Score; depth: number; pv?: string[] }[] };
export type Quality = { label: 'Forced' | 'Allowed mate' | 'Blunder' | 'Mistake' | 'Inaccuracy' | 'Excellent' | 'Great' | 'Best' | 'Good' | 'Alien' | 'Unreviewed'; accuracy: number | null; loss: number | null };
// Engine facts (Stockfish only — no praise, no difficulty). reviewMove speaks
// this vocabulary; the display layer translates it once via
// effectiveQuality, so an engine-Critical is never mistaken for a displayed
// Great and an engine-Top never for a displayed Best:
// - Critical: the engine's only good move (best, clean, wide gap).
// - Top: played the engine's top move, but not critically.
// - Holds: not the top move, yet nothing meaningful lost.
export type EngineGrade = { label: 'Forced' | 'Allowed mate' | 'Blunder' | 'Mistake' | 'Inaccuracy' | 'Critical' | 'Top' | 'Holds' | 'Unreviewed'; accuracy: number | null; loss: number | null };
// Additive Maia difficulty axis, measured against the top move rather than
// 100%: r = prob(played) / prob(top). A 13% move under a 15% top (r = 0.87)
// is the same band as the top itself, while a 12% rank-1 in a wide opening
// is still Expected. Bands are r >= 3/5 (0.6) Expected, r >= 1/3 Uncommon,
// else Rare: Qe3-like 9.5% under a 32% top (r ~= 0.30) reads Rare against
// the majority, while f3-like 14.9% under a 34% top (r ~= 0.44) stays
// Uncommon. Unlisted (outside Maia's top 5) is Absent by
// construction; missing or degraded Maia data is Unknown and renders nothing.
export type Rarity = { label: 'Expected' | 'Uncommon' | 'Rare' | 'Absent' | 'Unknown'; r: number | null; prob: number | null; topProb: number | null };
export function maiaRarity(maia: Pick<MoveResponse, 'top_moves' | 'degraded'> | undefined, played: string): Rarity {
  if (!maia || maia.degraded || !Array.isArray(maia.top_moves) || maia.top_moves.length === 0) return { label: 'Unknown', r: null, prob: null, topProb: null };
  const topProb = maia.top_moves[0].prob;
  if (typeof topProb !== 'number' || !Number.isFinite(topProb) || topProb <= 0) return { label: 'Unknown', r: null, prob: null, topProb: null };
  const found = maia.top_moves.find(candidate => candidate.move === played);
  if (!found || typeof found.prob !== 'number' || !Number.isFinite(found.prob)) return { label: 'Absent', r: null, prob: null, topProb };
  const r = found.prob / topProb;
  return { label: r >= 0.6 ? 'Expected' : r >= 1 / 3 ? 'Uncommon' : 'Rare', r, prob: found.prob, topProb };
}
// The verdict carries only the quality × rarity synthesis as a short head
// ("A sharp find.", "A common mistake."). Grades, scores,
// probabilities, and best lines already live in the badges, charts, and
// candidate lists, so restating them here is repetition. Praise
// (Excellent/Great) meets findability (a critical move nobody's model
// expects is an exceptional find); negative grades meet popularity (a
// blunder the model saw coming is a common blunder). The candidate lists
// below carry the Maia percentages; the verdict never repeats them.
// Praise gating lives in effectiveQuality, not reviewMove (which stays pure
// engine so memo/cache keys never go stale on Maia changes). It translates
// engine facts into displayed judgments:
// - Critical + Absent or Rare-and-tiny (prob<5%) → Excellent (!!).
//   The relative leg (Rare/Absent) blocks wide-opening inflation where the
//   Maia top itself sits under 5% (r=1 there, not a find).
// - Critical + Uncommon/Rare at >=5% → Great (!).
// - Critical + Expected/Unknown → Best; Top → Best; Holds → Good.
// - Excellent + tiny-at-own-Elo + tiny-at-2400 + decisive SF gap → Alien,
//   via alienUpgrade after this translation (it needs the 2400 rarity and
//   the SF top gap, which live outside the grade+rarity pair).
// Unknown is transient/error only — callers hold the spinner while either
// engine is pending, and SF-settled non-critical moves complete without Maia
// (fast path), so the cap never flickers a settled badge.
export const EXCELLENT_MAX_PROB = 0.05;
// Decisive-only-move gap for Alien, in mover-relative whiteWin points.
// Critical needs >= 10 (the engine's only good move); Alien needs >= 30
// (nothing else holds).
export const ALIEN_MIN_GAP = 30;
// Display labels: the engine-fact labels Critical/Top/Holds never reach the
// badge. The predicate proves the fallthrough below only carries shared
// labels instead of asserting the translation.
const QUALITY_LABELS: readonly Quality['label'][] = ['Forced', 'Allowed mate', 'Blunder', 'Mistake', 'Inaccuracy', 'Excellent', 'Great', 'Best', 'Good', 'Alien', 'Unreviewed'];
function isQualityLabel(value: unknown): value is Quality['label'] {
  return QUALITY_LABELS.some(label => label === value);
}
export function effectiveQuality(grade: EngineGrade | undefined, rarity: Rarity | undefined): Quality | undefined {
  if (!grade) return undefined;
  if (grade.label === 'Critical') {
    if (!rarity || rarity.label === 'Expected' || rarity.label === 'Unknown') return { ...grade, label: 'Best' };
    if (rarity.label === 'Absent') return { ...grade, label: 'Excellent' };
    if (rarity.label === 'Rare' && rarity.prob != null && rarity.prob < EXCELLENT_MAX_PROB) return { ...grade, label: 'Excellent' };
    return { ...grade, label: 'Great' };
  }
  if (grade.label === 'Top') return { ...grade, label: 'Best' };
  if (grade.label === 'Holds') return { ...grade, label: 'Good' };
  if (!isQualityLabel(grade.label)) throw new Error(`Unknown engine grade: ${String(grade.label)}`);
  return { ...grade, label: grade.label };
}
// Praise-rarity leg shared by both Elo lanes: Absent, or Rare with an
// absolute share under EXCELLENT_MAX_PROB. Unknown (missing/degraded data)
// never qualifies — absent evidence is not evidence of a find.
export function isTinyRare(rarity: Rarity | undefined | null): boolean {
  if (!rarity) return false;
  if (rarity.label === 'Absent') return true;
  return rarity.label === 'Rare' && rarity.prob != null && rarity.prob < EXCELLENT_MAX_PROB;
}
// Mover-relative gap between Stockfish's top two lines, in whiteWin points.
// Null unless both lines are cp scores (mate lines and single-line positions
// carry no comparable gap). Turn is the mover's color at the before-position.
export function sfTopGap(lines: { score: Score }[] | undefined, turn: 'white' | 'black'): number | null {
  const [first, second] = lines ?? [];
  if (!first || !second || first.score.type !== 'cp' || second.score.type !== 'cp') return null;
  const pov = (score: Score) => turn === 'white' ? whiteWin(score) : 100 - whiteWin(score);
  return pov(first.score) - pov(second.score);
}
// Peak praise upgrade, applied after effectiveQuality in lanes that carry
// both rarities and the SF gap: an Excellent-leg find (tiny at the player's
// own Elo) that is also tiny at 2400 with a decisive engine gap. Everything
// else passes through untouched, so lanes without 2400 data keep current
// behavior exactly.
export function alienUpgrade(quality: Quality | undefined, rarity: Rarity | undefined | null, rarity2400: Rarity | undefined | null, gap: number | null): Quality | undefined {
  if (quality?.label !== 'Excellent' || !isTinyRare(rarity) || !isTinyRare(rarity2400)) return quality;
  if (gap == null || gap < ALIEN_MIN_GAP) return quality;
  return { ...quality, label: 'Alien' };
}
function negativeNoun(quality: Quality): string {
  return quality.label.toLowerCase();
}
// "Allowed mate" can't take a rarity adjective directly ("a common allowed
// mate" stacks the adjective onto the mate, not the move), so the rarity
// modifies the move and the mate reads as a relative clause.
function allowedMateVerdict(rarity: Rarity): string {
  switch (rarity.label) {
    case 'Absent': return `An unlisted move that allows mate.`;
    case 'Expected': return `A common move that allows mate.`;
    case 'Uncommon': return `An uncommon move that allows mate.`;
    default: return `A rare move that allows mate.`;
  }
}
function rarityVerdict(quality: Quality, rarity: Rarity | undefined, bestRarity?: Rarity | null): string | null {
  if (!rarity || rarity.label === 'Unknown') return null;
  const praise = quality.label === 'Excellent' || quality.label === 'Great' || quality.label === 'Best';
  const holds = quality.label === 'Good';
  if (quality.label === 'Allowed mate') return hardToAvoid(bestRarity) ?? allowedMateVerdict(rarity);
  if (quality.label === 'Alien') return `An alien find.`;
  if (rarity.label === 'Absent') {
    if (quality.label === 'Excellent') return `An exceptional find.`;
    if (praise) return `A genuine find.`;
    if (holds) return `An unlisted choice that holds.`;
    return hardToAvoid(bestRarity) ?? `An unlisted ${negativeNoun(quality)}.`;
  }
  if (rarity.label === 'Expected') {
    if (praise || holds) return `The natural choice.`;
    return hardToAvoid(bestRarity) ?? `A common ${negativeNoun(quality)}.`;
  }
  if (rarity.label === 'Uncommon') {
    if (quality.label === 'Excellent') return `An exceptional find.`;
    if (praise) return `A sharp find.`;
    if (holds) return `A meaningful minority that holds.`;
    return hardToAvoid(bestRarity) ?? `An uncommon ${negativeNoun(quality)}.`;
  }
  if (quality.label === 'Excellent') return `An exceptional find.`;
  if (praise) return `A rare find.`;
  if (holds) return `A rarely played choice that holds.`;
  return hardToAvoid(bestRarity) ?? `A rare ${negativeNoun(quality)}.`;
}
// A mistake whose avoidance was itself a rare find at the player's own
// level: the best move sat under 5% (Rare) or outside Maia's top choices
// (Absent), so the error was hard to avoid. Qualified to the player's pool:
// with a second (2400) rarity lane in play, the bare phrase would read as
// universal — the "anyone" upgrade lives in the planned best2400Rarity fact.
// Expected/Uncommon/Unknown best moves leave the standard wording alone.
// Verdict-only: badges still read pure loss. Both Absent and Rare-tiny share
// one short sentence; the "This line …" second sentence plus its clickable
// PV carries the concrete consequence.
function hardToAvoid(bestRarity: Rarity | null | undefined): string | null {
  if (!bestRarity || bestRarity.label === 'Expected' || bestRarity.label === 'Uncommon' || bestRarity.label === 'Unknown') return null;
  if (bestRarity.label === 'Absent') return `Hard to avoid at your level.`;
  if (bestRarity.prob == null || bestRarity.prob >= EXCELLENT_MAX_PROB) return null;
  return `Hard to avoid at your level.`;
}
// Shared upstairs-regularly sentence (second-pool note for negatives,
// bright-spot note for praise): one literal, two rules.
const UPSTAIRS_REGULAR = 'Stronger players play this regularly.';
// Second-pool clause for the played move: what the 2400 lane says about a
// move already described by the own-pool head. Agreement needs no words
// (common/common, uncommon/uncommon stay silent); only contradiction or
// dramatic extension earns a note. Unknown on either side disables it —
// absent evidence is not evidence.
export function secondPoolClause(rarity: Rarity | undefined | null, rarity2400: Rarity | undefined | null): string | null {
  if (!rarity || !rarity2400 || rarity.label === 'Unknown' || rarity2400.label === 'Unknown') return null;
  const own = rarity.label, up = rarity2400.label;
  if (up === 'Expected') {
    if (own === 'Expected') return null;
    return UPSTAIRS_REGULAR;
  }
  if (up === 'Uncommon') return null;
  if (own === 'Absent' && up === 'Absent') return 'Unlisted at every level.';
  if (own === 'Expected' || own === 'Uncommon') return 'Stronger players rarely play this.';
  return 'Rare at every level.';
}
// Exact-agreement fusion: when both pools shun the move under the same word
// (Rare/Rare, Absent/Absent), the head and the every-level clause merge into
// one sentence ("A blunder rare at every level."). Mixed pools keep both
// sentences — no single rarity word fits a disagreement. Null unless the
// second-pool rule already fired (same grades, same clause), so priority
// against material/pawn notes is unchanged: describeMove only consults this
// on a second-pool win.
function fuseEveryLevel(
  quality: Quality | undefined,
  rarity: Rarity | undefined | null,
  rarity2400: Rarity | undefined | null,
): string | null {
  if (!quality || !rarity || !rarity2400) return null;
  const label = quality.label;
  if (label !== 'Blunder' && label !== 'Mistake' && label !== 'Inaccuracy') return null;
  const noun = negativeNoun(quality);
  const article = noun === 'inaccuracy' ? 'An' : 'A';
  if (rarity.label === 'Rare' && rarity2400.label === 'Rare') return `${article} ${noun} rare at every level.`;
  if (rarity.label === 'Absent' && rarity2400.label === 'Absent') return `${article} ${noun} unlisted at every level.`;
  return null;
}
// Decision list for the move verdict. Array order IS the priority: the
// first matching rule wins, so reordering rules reorders the verdict. Each
// rule owns its match and its wording together — add a condition by adding
// one entry, never by editing scattered if-chains. Standalone rules render
// alone with no novelty prefix and no second sentence; when none matches,
// the quality × rarity synthesis below takes a novelty prefix and at most
// one note rule. Returns null when there is nothing additive to say
// (unreviewed, off-book without Maia data, or pre-first-move); the badges
// and charts already carry the grades.
// materialNote is the best-line 3-ply swing supplied by the caller
// (Mistake/Blunder only). pawnNote is the positional fallback when the
// material window is silent (Blunder/Mistake/Inaccuracy only). positiveNote
// is the mirror for praise grades (Best/Great/Excellent/Good only): the
// single strongest why, picked by theory.ts from its own ordered
// candidates. pinClaim is raw pin pressure for the concessive path
// (Blunder/Mistake with a material note, Allowed mate): describeMove fuses
// it with the opponent's reply, and it never renders alone on a negative.
// Neither note ever rescues a quiet verdict: notes append to
// the rarity synthesis only, except pin-allowed-mate which replaces the
// synthesis the way other specific facts outrank sociology.
export type OpeningRef = { eco: string; name: string };
export type VerdictArgs = { san: string; quality?: Quality | undefined; rarity?: Rarity | undefined; opening?: OpeningRef | null; bestRarity?: Rarity | null; materialNote?: string | null; terminal?: TerminalKind | null; matePatternName?: string | null; deadDraw?: boolean; underpromotionAvoids?: boolean; novelty?: NoveltyRef | null; pawnNote?: string | null; positiveNote?: string | null; pinClaim?: string | null;
  // Cross-Elo praise tiers: rarity of the played move at 2400 (from the
  // objective lane; null when that lane is missing/degraded) and whether the
  // raw engine grade was Top (played == Stockfish best with a small gap —
  // translated Quality alone cannot recover it, same as isCritical).
  rarity2400?: Rarity | null; isTop?: boolean | null };
export function isPraiseLabel(label: Quality['label'] | undefined): boolean {
  return label === 'Best' || label === 'Great' || label === 'Excellent' || label === 'Good' || label === 'Alien';
}
type StandaloneRule = { name: string; match: (facts: VerdictArgs) => boolean; render: (facts: VerdictArgs) => string };
const STANDALONE_RULES: StandaloneRule[] = [
  { name: 'checkmate', match: facts => facts.terminal === 'checkmate',
    render: facts => facts.matePatternName ? `${facts.matePatternName}.` : `Checkmate.` },
  { name: 'stalemate-repetition', match: facts => facts.terminal === 'stalemate' || facts.terminal === 'repetition',
    render: facts => {
      const negative = facts.quality?.label === 'Blunder' || facts.quality?.label === 'Mistake' || facts.quality?.label === 'Inaccuracy';
      const noun = facts.terminal === 'stalemate' ? 'stalemate' : 'a repetition draw';
      return negative ? `${facts.san} allows ${noun}.` : `${facts.san} forces ${noun}.`;
    } },
  { name: 'fifty', match: facts => facts.terminal === 'fifty',
    render: facts => `${facts.san} brings the fifty-move rule.` },
  { name: 'insufficient', match: facts => facts.terminal === 'insufficient',
    render: facts => `${facts.san} leaves insufficient mating material.` },
  { name: 'book', match: facts => !!facts.opening,
    render: facts => `${facts.san} — ${facts.opening!.name} (${facts.opening!.eco}).` },
  { name: 'forced', match: facts => facts.quality?.label === 'Forced',
    render: () => `The only legal move.` },
  { name: 'dead-draw', match: facts => !!facts.deadDraw,
    render: facts => `${facts.san} — known theoretical draw.` },
  { name: 'underpromotion', match: facts => !!facts.underpromotionAvoids,
    render: facts => `${facts.san} underpromotes to avoid stalemate.` },
  // Concessive pin on a mate-allowing move: the tactic is real but the game
  // is over, so it replaces the rarity sociology the way terminals do. The
  // best-move rarity axis survives as a prefix — "Hard to avoid" explains
  // the miss, "common/rare" would just repeat "allows mate".
  { name: 'pin-allowed-mate', match: facts => facts.quality?.label === 'Allowed mate' && !!facts.pinClaim,
    render: facts => {
      const hard = hardToAvoid(facts.bestRarity);
      const fused = fusePinWithMate(facts.pinClaim!);
      return hard ? `${hard} ${fused}` : fused;
    } },
];
// Second-sentence rules for the synthesis branch. First match wins; the
// grade sets are disjoint (negative notes vs praise notes), so order among
// them only documents intent.
type NoteRule = { name: string; match: (facts: VerdictArgs) => boolean; render: (facts: VerdictArgs) => string };
const NOTE_RULES: NoteRule[] = [
  // Concessive pin with a proven reply: real pressure, still lost. Outranks
  // the plain material note it fuses; quiet pins with no material window
  // never reach here (theory leaves pinClaim null), so positional mistakes
  // keep the pawn fallback or the bare head instead of a misleading tactic.
  { name: 'pin-material', match: facts => !!facts.pinClaim && !!facts.materialNote && (facts.quality?.label === 'Mistake' || facts.quality?.label === 'Blunder'),
    render: facts => fusePinWithMaterial(facts.pinClaim!, facts.materialNote!) },
  { name: 'material', match: facts => !!facts.materialNote && (facts.quality?.label === 'Mistake' || facts.quality?.label === 'Blunder'),
    render: facts => facts.materialNote! },
  { name: 'pawn', match: facts => !!facts.pawnNote && (facts.quality?.label === 'Blunder' || facts.quality?.label === 'Mistake' || facts.quality?.label === 'Inaccuracy'),
    render: facts => facts.pawnNote! },
  // Second-pool sociology for the inaccuracy family: the consequence notes
  // above stay first (what happened outranks who plays it). Fires only on
  // contradiction/extension — agreement stays silent per secondPoolClause.
  { name: 'second-pool', match: facts => (facts.quality?.label === 'Blunder' || facts.quality?.label === 'Mistake' || facts.quality?.label === 'Inaccuracy')
      && secondPoolClause(facts.rarity, facts.rarity2400) != null,
    render: facts => secondPoolClause(facts.rarity, facts.rarity2400)! },
  // Praise-tier notes, ordered most-specific first (first match wins, so
  // they outrank the generic positive why below — tier evidence is rarer
  // and more specific than a tactical motif).
  { name: 'only-move', match: facts => facts.quality?.label === 'Alien',
    render: () => `Stockfish sees nothing else that holds.` },
  { name: 'validated', match: facts => facts.quality?.label === 'Best' && facts.isTop === true && isTinyRare(facts.rarity) && isTinyRare(facts.rarity2400),
    render: () => `Stockfish agrees it is best.` },
  { name: 'blind-spot', match: facts => (facts.quality?.label === 'Excellent' || facts.quality?.label === 'Great' || facts.quality?.label === 'Best') && isTinyRare(facts.rarity2400),
    render: () => `Even 2400s rarely play this.` },
  // Bright-spot mirror: praised at own Elo and standard upstairs — the
  // level-up moment. Holds stays quiet by design (no praise for holding).
  { name: 'bright-spot', match: facts => (facts.quality?.label === 'Excellent' || facts.quality?.label === 'Great' || facts.quality?.label === 'Best')
      && !!facts.rarity && facts.rarity.label !== 'Expected' && facts.rarity2400?.label === 'Expected',
    render: () => UPSTAIRS_REGULAR },
  { name: 'positive', match: facts => !!facts.positiveNote && isPraiseLabel(facts.quality?.label),
    render: facts => facts.positiveNote! },
];
export function describeMove(args: VerdictArgs): string | null {
  const standalone = STANDALONE_RULES.find(rule => rule.match(args));
  if (standalone) return standalone.render(args);
  const { quality, rarity, bestRarity, novelty, rarity2400 } = args;
  if (!quality || quality.label === 'Unreviewed') return null;
  const base = rarityVerdict(quality, rarity, bestRarity);
  if (!base) return null;
  const head = novelty ? `Leaves ${novelty.priorName} book. ${base}` : base;
  const noteRule = NOTE_RULES.find(rule => rule.match(args));
  if (noteRule?.name === 'second-pool') {
    const fused = fuseEveryLevel(quality, rarity, rarity2400);
    if (fused) return novelty ? `Leaves ${novelty.priorName} book. ${fused}` : fused;
  }
  return noteRule ? `${head} ${noteRule.render(args)}` : head;
}
// Rule-trace seam for the verdict lab: names the winning standalone and
// note rules without rendering. Mirrors describeMove's priority exactly
// (first match wins); synthesis-branch notes only apply when a head exists.
export function matchedRuleNames(args: VerdictArgs): { standalone: string | null; note: string | null } {
  const standalone = STANDALONE_RULES.find(rule => rule.match(args));
  if (standalone) return { standalone: standalone.name, note: null };
  const { quality, rarity, bestRarity } = args;
  if (!quality || quality.label === 'Unreviewed') return { standalone: null, note: null };
  if (!rarityVerdict(quality, rarity, bestRarity)) return { standalone: null, note: null };
  return { standalone: null, note: NOTE_RULES.find(rule => rule.match(args))?.name ?? null };
}
export function whiteWin(score: Score): number {
  return score.type === 'cp' ? 100 / (1 + Math.exp(-.00368208 * score.value)) : (score.winning_side ?? (score.value > 0 ? 'white' : 'black')) === 'white' ? 100 : 0;
}
// Objective axis: what "best" and "expected score" mean is a provider
// choice, not a model choice. An ObjectivePoint is one position read in the
// provider's units, normalized here: the objective best move (null when the
// provider cannot name one — degraded, missing, or terminal rows) and the
// mover-relative expected score on the shared 0-100 scale (null when the
// provider has no reading). Loss cutoffs (20/10/5) and the moveAccuracy
// curve below operate on these numbers only and never know the source.
// consequence: switching providers changes which fetches feed the points,
// never the grading math.
export type ObjectiveWdl = {
  white: number;
  draw: number;
  black: number;
};
export type ObjectivePoint = {
  top: string | null;
  expected: number | null;
  wdl?: ObjectiveWdl | null;
};
// Ranked candidate entries for one position: the objective list the panel
// renders. Mover-relative expected score per choice, policy/score order,
// plus the model identity behind the list for headings and fallback copy.
// `prob` is the lane's play probability when the provider has one (Maia
// policy share); lanes without one (Stockfish lines) omit it and the panel
// falls back to the single absolute value.
export type ObjectiveCandidates = {
  entries: { uci: string; expected: number; prob?: number | null; delta?: number | null }[];
  degraded: boolean;
  // Server-attached delta baseline for these entries (mirrors the row's
  // delta_baseline). Absent when served without delta context.
  baseline?: { value: number; kind: 'before' | 'best' } | null;
};
// White-relative view of a mover-relative expectation. Callers pass the
// node's turn; no FEN parsing, no model knowledge.
export function whiteExpected(turn: 'white' | 'black', moverExpected: number): number {
  return turn === 'white' ? moverExpected : 100 - moverExpected;
}
// Mover-relative expectation from a terminal outcome, for objective lanes
// whose provider never infers game-over positions: a checkmate after your
// move is always one you delivered; draws split.
export function outcomeExpected(outcome: DomainOutcome | null | undefined): number | null {
  if (!outcome) return null;
  return outcome.kind === 'checkmate' ? 100 : 50;
}
// Grading input for one move, assembled by the caller (which owns node
// lookups and pending keys): the objective point before the move plus the
// mover-relative expectation after it. Pending flags hold the spinner while
// the objective lane is in flight so badges never flash a stale grade.
// The after expectation arrives mover-relative; lane assembly owns the
// opponent-relative inversion and terminal-outcome synthesis, never here.
export type ObjectiveGrade = {
  top: string | null;
  expected: number | null;
  afterExpected: number | null;
  beforePending: boolean;
  afterPending: boolean;
};
export function moveAccuracy(loss: number): number { return loss === 0 ? 100 : Math.max(0, Math.min(100, 103.1668 * Math.exp(-.04354 * loss) - 3.1669)); }
export function classifyLoss(loss: number): 'Blunder' | 'Mistake' | 'Inaccuracy' | null { return loss >= 20 ? 'Blunder' : loss >= 10 ? 'Mistake' : loss >= 5 ? 'Inaccuracy' : null; }
// Mate allowed when avoidable: the mover had no forced mate against them
// (best play survives) but the played move lets the opponent force mate.
// Winner resolution mirrors whiteWin: explicit winning_side, else mate-value
// sign. Checked before classifyLoss, whose win% delta is blind to
// mate-to-mate (0 - 0) and lost-cp-to-mate (< 5) cases. There is no Miss
// label: a missed win that stays alive reads Blunder by loss (>= 20 always
// holds there), matching the engine-measures-loss-only principle.
export function isMateFor(score: Score, side: 'white' | 'black'): boolean {
  if (score.type !== 'mate') return false;
  return (score.winning_side ?? (score.value > 0 ? 'white' : 'black')) === side;
}
export function reviewMove(before: Evaluation | undefined, after: Evaluation | undefined, game: Chess, played: string, objective?: ObjectiveGrade): EngineGrade {
  if (!before || !after) return { label: 'Unreviewed', accuracy: null, loss: null };
  const legal = game.moves().length;
  if (legal === 1) return { label: 'Forced', accuracy: 100, loss: 0 };
  const pov = (score: Score) => game.turn() === 'w' ? whiteWin(score) : 100 - whiteWin(score);
  const loss = Math.max(0, pov(before.score) - pov(after.score));
  const [first, second] = before.lines;
  const best = played === before.best_move;
  const mover = game.turn() === 'w' ? 'white' : 'black';
  const opp = mover === 'white' ? 'black' : 'white';
  if (!best && isMateFor(after.score, opp) && !isMateFor(before.score, opp)) return { label: 'Allowed mate', accuracy: 0, loss };
  const critical = best && loss <= 1 && legal >= 2 && before.score.type === 'cp' && after.score.type === 'cp' && first?.move === played && second?.move !== played && first.score.type === 'cp' && second?.score.type === 'cp' && pov(first.score) - pov(second.score) >= 10;
  if (objective !== undefined) return gradedReviewMove(objective, played, { best, critical, loss });
  return sfGrade({ best, critical, loss, capNegatives: false });
}
// Stockfish-only grade path: mate/forced already returned above. Negative
// labels fire on SF loss; capNegatives (objective lane decided) restricts
// this to the praise/holds vocabulary so an engine dislike can never surface
// as a badge once the objective axis owns negatives.
function sfGrade(args: { best: boolean; critical: boolean; loss: number; capNegatives: boolean }): EngineGrade {
  const { best, critical, loss, capNegatives } = args;
  if (!capNegatives) {
    const negative = classifyLoss(loss);
    if (negative) return { label: negative, accuracy: moveAccuracy(loss), loss };
  }
  return { label: critical ? 'Critical' : best ? 'Top' : 'Holds', accuracy: moveAccuracy(loss), loss };
}
// Objective path. Precedence after mate/forced: a pending objective lane
// holds the spinner (never flash a stale grade the lane then replaces); a
// missing-but-settled lane falls back to pure SF so an objective failure
// degrades to engine behavior instead of blanking badges. Played-top is
// never negative (the objectively best move cannot be an objective
// mistake); other moves classify on objective expected-score loss.
// Whatever remains reads the SF vocabulary with negatives capped,
// preserving Critical/Top/Holds for praise gating and material notes.
function gradedReviewMove(grading: ObjectiveGrade, played: string, sf: { best: boolean; critical: boolean; loss: number }): EngineGrade {
  const settled = grading.top !== null && grading.expected !== null && grading.afterExpected !== null;
  if (!settled) {
    if (grading.beforePending || grading.afterPending) return { label: 'Unreviewed', accuracy: null, loss: null };
    return sfGrade({ ...sf, capNegatives: false });
  }
  if (played !== grading.top) {
    const loss = Math.max(0, grading.expected! - grading.afterExpected!);
    const negative = classifyLoss(loss);
    if (negative) return { label: negative, accuracy: moveAccuracy(loss), loss };
  }
  return sfGrade({ ...sf, capNegatives: true });
}
// Single terminal source of truth. Winner resolution mirrors whiteWin:
// explicit winning_side, else mate-value sign. domain.ts outcome() and both
// Evaluation constructors share these two helpers so repetition/mate/draw
// facts cannot drift.
export function outcomeFromGame(game: Pick<Chess, 'isCheckmate' | 'isDraw' | 'turn'>): DomainOutcome | null {
  return game.isCheckmate() ? { kind: 'checkmate', winner: game.turn() === 'w' ? 'black' : 'white' }
    : game.isDraw() ? { kind: 'draw' } : null;
}
export function evaluationForOutcome(outcome: DomainOutcome | null, search_policy: string): Evaluation | undefined {
  if (!outcome) return;
  const winner = outcome.kind === 'checkmate' ? outcome.winner : null;
  return { engine: 'Stockfish 19', search_policy, depth: 0, terminal: winner ? `${winner}_win` : 'draw', best_move: null, lines: [],
    score: winner ? { type: 'mate', value: 0, winning_side: winner } : { type: 'cp', value: 0 } };
}
export function terminalEvaluation(game: Chess): Evaluation | undefined {
  if (!game.isGameOver()) return;
  return evaluationForOutcome(outcomeFromGame(game), SEARCH_POLICY);
}
export function scoreValueText(score: Score): string {
  // Bare signed numbers: sign is White-relative (+ White, - Black), magnitude
  // is pawns for cp or moves-to-mate for mate. No unit words.
  if (score.type === 'mate') {
    const white = (score.winning_side ?? (score.value > 0 ? 'white' : 'black')) === 'white';
    return `${white ? '+' : '-'}M${Math.abs(score.value)}`;
  }
  return `${score.value >= 0 ? '+' : '-'}${(Math.abs(score.value) / 100).toFixed(2)}`;
}
export function scoreText(result: Evaluation): string { return scoreValueText(result.score); }
