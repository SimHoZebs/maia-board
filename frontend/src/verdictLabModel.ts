import { Chess } from 'chess.js';
import { START_FEN, type DomainOutcome } from './domain';
import type { MaiaColor } from './api';
import type { MoveResponse } from './api';
import {
  alienUpgrade,
  describeMove,
  effectiveQuality,
  isTinyRare,
  maiaRarity,
  matchedRuleNames,
  reviewMove,
  secondPoolClause,
  sfTopGap,
  type EngineGrade,
  type Evaluation,
  type Quality,
  type Rarity,
  type Score,
  type VerdictArgs,
} from './reviewMetrics';
import { verdictInputsForPly, type VerdictFacts, type VerdictInputs } from './theory';

// Lab knob state for the verdict test page (/dev/verdict-lab). The lab feeds
// RAW engine numbers through the REAL threshold functions — nothing here
// restates a band, grade, or cutoff by hand:
// - Maia probs → maiaRarity (0.6 / 1/3 bands, 5% tiny leg)
// - SF cp scores + best flag + line gap → reviewMove (20/10/5 loss, Critical
//   loss ≤ 1 + gap ≥ 10) → effectiveQuality → alienUpgrade (gap ≥ 30)
// - FENs + outcome → verdictInputsForPly → describeMove
// Note overrides only cover caller-supplied text (material preview) and the
// NOTE_RULES priority order — never a threshold.
export type RarityLaneKnob = {
  mode: 'top' | 'listed' | 'unlisted' | 'unknown';
  topProb: number;
  prob: number;
};
export type ScoreKnob = { kind: 'none' | 'cp' | 'mate'; value: number; winningSide: 'white' | 'black' };
export type NoteMode = 'auto' | 'manual' | 'off';

export type LabState = {
  preset: string;
  // Position context.
  san: string;
  playedUci: string;
  ply: number;
  mover: MaiaColor;
  beforeFen: string;
  afterFen: string;
  initialFen: string;
  bestUci: string;
  afterOutcome: 'none' | 'checkmate' | 'draw';
  mateWinner: 'white' | 'black';
  beforeScore: ScoreKnob;
  afterScore: ScoreKnob;
  // Raw Stockfish inputs. best_move, rank-1/2 lines, and the legal-move count
  // (from beforeFen) drive reviewMove; the lab never names a grade itself.
  playedIsBest: boolean;
  line1Cp: number;
  line2Cp: number;
  singleLine: boolean;
  // Raw Maia lanes. Each lane builds a two-entry policy list (top + played)
  // so maiaRarity computes the real band from prob/topProb.
  ownLane: RarityLaneKnob;
  lane2400: RarityLaneKnob;
  // Rarity of the best reply in the own lane: 'same' reuses the played move,
  // 'tiny' lists bestUci at 3% (Rare + under the 5% leg), 'unlisted' leaves
  // it out of the top 5. Feeds the hard-to-avoid head.
  bestKind: 'same' | 'tiny' | 'unlisted';
  // Sociology lane.
  inBook: boolean;
  bookEco: string;
  bookName: string;
  noveltyName: string;
  noveltyEco: string;
  noveltyOn: boolean;
  // Notes lane. Material has no auto source (the caller supplies the
  // best-line preview), so empty text means off.
  materialNote: string;
  pawnMode: NoteMode;
  pawnManual: string;
  positiveMode: NoteMode;
  positiveManual: string;
  pinMode: NoteMode;
  pinManual: string;
};

export const DEFAULT_STATE: LabState = {
  preset: 'common-mistake',
  san: 'e4',
  playedUci: 'e2e4',
  ply: 1,
  mover: 'white',
  beforeFen: START_FEN,
  afterFen: START_FEN,
  initialFen: START_FEN,
  bestUci: 'd2d4',
  afterOutcome: 'none',
  mateWinner: 'white',
  beforeScore: { kind: 'cp', value: 100, winningSide: 'white' },
  afterScore: { kind: 'cp', value: -60, winningSide: 'white' },
  playedIsBest: false,
  line1Cp: 100,
  line2Cp: 60,
  singleLine: false,
  ownLane: { mode: 'top', topProb: 0.4, prob: 0.4 },
  lane2400: { mode: 'unknown', topProb: 0.4, prob: 0.4 },
  bestKind: 'same',
  inBook: false,
  bookEco: 'C50',
  bookName: 'Italian Game',
  noveltyName: 'French Defense',
  noveltyEco: 'C00',
  noveltyOn: false,
  materialNote: '',
  pawnMode: 'auto',
  pawnManual: '',
  positiveMode: 'auto',
  positiveManual: '',
  pinMode: 'auto',
  pinManual: '',
};

// Placeholder UCI for the non-played side of a synthetic policy list.
// maiaRarity only matches move strings, never legality, so this never needs
// to be a real alternative.
const OTHER_UCI = 'a2a3';
const OTHER_UCI_2 = 'g1f3';

function laneResponse(
  lane: RarityLaneKnob,
  playedUci: string,
  extra: { move: string; prob: number }[] = [],
): Pick<MoveResponse, 'top_moves' | 'degraded'> {
  if (lane.mode === 'unknown') return { top_moves: [], degraded: true };
  // wdl is unused by maiaRarity; a neutral triple keeps the TopMove shape.
  const neutral = { wdl: [0.2, 0.6, 0.2] as [number, number, number] };
  const top_moves = [{ move: lane.mode === 'top' ? playedUci : OTHER_UCI, prob: lane.topProb, ...neutral }];
  if (lane.mode === 'listed') top_moves.push({ move: playedUci, prob: lane.prob, ...neutral });
  for (const entry of extra) {
    if (!top_moves.some(candidate => candidate.move === entry.move)) top_moves.push({ ...entry, ...neutral });
  }
  return { top_moves, degraded: false };
}

function buildScore(knob: ScoreKnob): Score | null {
  if (knob.kind === 'cp') return { type: 'cp', value: knob.value };
  if (knob.kind === 'mate') return { type: 'mate', value: knob.value, winning_side: knob.winningSide };
  return null;
}

function buildOutcome(state: LabState): DomainOutcome | null {
  if (state.afterOutcome === 'checkmate') return { kind: 'checkmate', winner: state.mateWinner };
  if (state.afterOutcome === 'draw') return { kind: 'draw' };
  return null;
}

export type LabVerdict = {
  inputs: VerdictInputs;
  facts: VerdictFacts;
  verdict: string | null;
  rules: { standalone: string | null; note: string | null };
  trace: {
    engineGrade: EngineGrade;
    legalMoves: number | null;
    sfGap: number | null;
    rarity: Rarity;
    rarity2400: Rarity;
    bestRarity: Rarity;
    autoQuality: Quality | undefined;
    finalQuality: Quality | undefined;
    alienApplied: boolean;
    tinyOwn: boolean;
    tiny2400: boolean;
    secondPool: string | null;
    autoPawn: string | null;
    autoPositive: string | null;
    autoPin: string | null;
  };
};

function applyNoteOverride(mode: NoteMode, auto: string | null, manual: string): string | null {
  if (mode === 'off') return null;
  if (mode === 'manual') return manual.trim() ? manual.trim() : null;
  return auto;
}

const UNREVIEWED: EngineGrade = { label: 'Unreviewed', accuracy: null, loss: null };

export function buildLabVerdict(state: LabState): LabVerdict {
  // Maia lanes through the real band math.
  const bestUci = state.bestUci.trim() ? state.bestUci.trim() : state.playedUci;
  const bestExtra = state.bestKind === 'tiny' ? [{ move: bestUci, prob: 0.03 }] : [];
  const ownResponse = laneResponse(state.ownLane, state.playedUci, bestExtra);
  const rarity = maiaRarity(ownResponse, state.playedUci);
  const rarity2400 = maiaRarity(laneResponse(state.lane2400, state.playedUci), state.playedUci);
  const bestRarity = state.bestKind === 'same'
    ? maiaRarity(ownResponse, state.playedUci)
    : maiaRarity(ownResponse, bestUci);

  // Stockfish grade through the real reviewMove. The before-position supplies
  // the legal-move count (Forced needs exactly 1); cp scores supply loss and
  // the rank-1/2 gap. An unparseable FEN holds the spinner like a pending
  // lane instead of throwing.
  let game: Chess | null = null;
  try {
    game = new Chess(state.beforeFen);
  } catch {
    game = null;
  }
  const legalMoves = (() => {
    try {
      return game?.moves().length ?? null;
    } catch {
      return null;
    }
  })();
  const turn = state.mover === 'white' ? 'white' as const : 'black' as const;
  const bestMove = state.playedIsBest
    ? state.playedUci
    : state.playedUci === OTHER_UCI ? OTHER_UCI_2 : OTHER_UCI;
  const line2Move = bestMove === OTHER_UCI_2 ? 'h2h3' : OTHER_UCI_2;
  const beforeScore = buildScore(state.beforeScore) ?? { type: 'cp' as const, value: 0 };
  const afterScore = buildScore(state.afterScore) ?? { type: 'cp' as const, value: 0 };
  const lines: Evaluation['lines'] = state.singleLine
    ? [{ move: bestMove, score: { type: 'cp', value: state.line1Cp }, depth: 20 }]
    : [
      { move: bestMove, score: { type: 'cp', value: state.line1Cp }, depth: 20 },
      { move: line2Move, score: { type: 'cp', value: state.line2Cp }, depth: 20 },
    ];
  const before: Evaluation = {
    engine: 'Stockfish 19', search_policy: 'verdict-lab', depth: 20,
    terminal: null, best_move: bestMove, score: beforeScore, lines,
  };
  const after: Evaluation = {
    engine: 'Stockfish 19', search_policy: 'verdict-lab', depth: 20,
    terminal: null, best_move: null, score: afterScore, lines: [],
  };
  const engineGrade = game ? reviewMove(before, after, game, state.playedUci) : UNREVIEWED;
  const sfGap = sfTopGap(before.lines, turn);
  const autoQuality = alienUpgrade(effectiveQuality(engineGrade, rarity), rarity, rarity2400, sfGap);
  const translated = effectiveQuality(engineGrade, rarity);
  const alienApplied = autoQuality?.label === 'Alien' && translated?.label === 'Excellent';

  // Novelty plumbing mirrors a line that was in book until this ply: the
  // prior position carries the exact hit, this ply leaves it.
  const matches = state.noveltyOn && state.ply >= 1
    ? [{ ply: state.ply - 1, eco: state.noveltyEco, name: state.noveltyName }]
    : [];
  const bookFlags = state.noveltyOn && state.ply >= 1
    ? Array.from({ length: state.ply }, (_, i) => i !== state.ply - 1)
    : [];

  const inputs: VerdictInputs = {
    beforeFen: state.beforeFen,
    afterFen: state.afterFen,
    afterOutcome: buildOutcome(state),
    san: state.san,
    playedUci: state.playedUci,
    ply: state.ply,
    quality: autoQuality,
    rarity,
    opening: state.inBook ? { eco: state.bookEco, name: state.bookName } : null,
    openingMatches: matches,
    bookFlags,
    initialFen: state.initialFen,
    mover: state.mover,
    bestRarity,
    rarity2400,
    isTop: engineGrade.label === 'Top',
    isCritical: engineGrade.label === 'Critical',
    materialNote: state.materialNote.trim() ? state.materialNote.trim() : null,
    bestUci: state.bestUci.trim() ? state.bestUci.trim() : null,
    beforeScore: buildScore(state.beforeScore),
    afterScore: buildScore(state.afterScore),
    prevUci: null,
    prevBeforeFen: null,
  };
  const auto = verdictInputsForPly(inputs);
  const facts: VerdictFacts = {
    ...auto,
    pawnNote: applyNoteOverride(state.pawnMode, auto.pawnNote, state.pawnManual),
    positiveNote: applyNoteOverride(state.positiveMode, auto.positiveNote, state.positiveManual),
    pinClaim: applyNoteOverride(state.pinMode, auto.pinClaim, state.pinManual),
  };
  // describeMove reads VerdictFacts as VerdictArgs: same shape minus the
  // pipeline-only isCritical/bestUci fields.
  const args: VerdictArgs = facts;
  return {
    inputs,
    facts,
    verdict: describeMove(args),
    rules: matchedRuleNames(args),
    trace: {
      engineGrade,
      legalMoves,
      sfGap,
      rarity,
      rarity2400,
      bestRarity,
      autoQuality,
      finalQuality: autoQuality,
      alienApplied,
      tinyOwn: isTinyRare(rarity),
      tiny2400: isTinyRare(rarity2400),
      secondPool: secondPoolClause(rarity, rarity2400),
      autoPawn: auto.pawnNote,
      autoPositive: auto.positiveNote,
      autoPin: auto.pinClaim,
    },
  };
}

export type LabPreset = { id: string; name: string; blurb: string; patch: Partial<LabState> };

const SCHOLARS_BEFORE = 'r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
const SCHOLARS_AFTER = 'r1bqkb1r/pppp1Qpp/2n2n2/4p3/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 0 4';
const FORCED_BEFORE = '8/8/8/8/8/k7/n7/K7 w - - 0 1';
const FORCED_AFTER = '8/8/8/8/8/k7/n7/1K6 b - - 1 1';

export const PRESETS: LabPreset[] = [
  {
    id: 'common-mistake',
    name: 'Common mistake',
    blurb: '14.6-point loss (100→−60cp) the whole pool plays.',
    patch: {},
  },
  {
    id: 'rare-find',
    name: 'Exceptional find',
    blurb: 'Zero-loss best with a 20-point gap, unlisted at home, 3%-listed at 2400.',
    patch: {
      san: 'Nf3', playedUci: 'g1f3', playedIsBest: true,
      beforeScore: { kind: 'cp', value: 50, winningSide: 'white' },
      afterScore: { kind: 'cp', value: 50, winningSide: 'white' },
      line1Cp: 120, line2Cp: -100,
      ownLane: { mode: 'unlisted', topProb: 0.4, prob: 0.4 },
      lane2400: { mode: 'listed', topProb: 0.4, prob: 0.03 },
    },
  },
  {
    id: 'alien',
    name: 'Alien find',
    blurb: 'Unlisted at both pools with a 35-point gap (200/−200cp lines).',
    patch: {
      san: 'Qg4', playedUci: 'd1g4', playedIsBest: true,
      beforeScore: { kind: 'cp', value: 50, winningSide: 'white' },
      afterScore: { kind: 'cp', value: 50, winningSide: 'white' },
      line1Cp: 200, line2Cp: -200,
      ownLane: { mode: 'unlisted', topProb: 0.4, prob: 0.4 },
      lane2400: { mode: 'unlisted', topProb: 0.4, prob: 0.4 },
    },
  },
  {
    id: 'allowed-mate-pin',
    name: 'Allowed mate with a pin',
    blurb: 'Mate allowed with a real pin; the best reply was unlisted.',
    patch: {
      san: 'Qe2', playedUci: 'd1e2', playedIsBest: false,
      beforeScore: { kind: 'cp', value: 100, winningSide: 'white' },
      afterScore: { kind: 'mate', value: 3, winningSide: 'black' },
      bestKind: 'unlisted',
      pinMode: 'manual', pinManual: 'Pins the queen to the king.',
    },
  },
  {
    id: 'book-hit',
    name: 'Book hit',
    blurb: 'Named theory outranks every grade.',
    patch: {
      san: 'Bc4', playedUci: 'f1c4', playedIsBest: true,
      beforeScore: { kind: 'cp', value: 50, winningSide: 'white' },
      afterScore: { kind: 'cp', value: 50, winningSide: 'white' },
      line1Cp: 100, line2Cp: 60, inBook: true,
    },
  },
  {
    id: 'novelty-bright-spot',
    name: 'Novelty bright-spot',
    blurb: 'Leaves French Defense book with a 15%-under-35% find 2400s play.',
    patch: {
      san: 'c4', playedUci: 'c2c4', ply: 2, playedIsBest: true,
      beforeScore: { kind: 'cp', value: 50, winningSide: 'white' },
      afterScore: { kind: 'cp', value: 50, winningSide: 'white' },
      line1Cp: 120, line2Cp: -100,
      ownLane: { mode: 'listed', topProb: 0.35, prob: 0.15 },
      lane2400: { mode: 'top', topProb: 0.35, prob: 0.35 },
      noveltyOn: true,
    },
  },
  {
    id: 'scholars-mate',
    name: "Scholar's mate",
    blurb: 'Terminal facts outrank even the book: named miniature.',
    patch: {
      san: 'Qxf7#', playedUci: 'h5f7', ply: 7,
      beforeFen: SCHOLARS_BEFORE, afterFen: SCHOLARS_AFTER,
      afterOutcome: 'checkmate', mateWinner: 'white', mover: 'white',
      playedIsBest: true,
      beforeScore: { kind: 'cp', value: 200, winningSide: 'white' },
      afterScore: { kind: 'mate', value: 0, winningSide: 'white' },
    },
  },
  {
    id: 'hard-to-avoid',
    name: 'Hard to avoid',
    blurb: 'A 26.9-point blunder whose best reply was unlisted at your level.',
    patch: {
      playedIsBest: false,
      beforeScore: { kind: 'cp', value: 150, winningSide: 'white' },
      afterScore: { kind: 'cp', value: -150, winningSide: 'white' },
      bestKind: 'unlisted',
    },
  },
  {
    id: 'underpromotion',
    name: 'Underpromotion avoids stalemate',
    blurb: 'b7b8=N where the queen promotion stalemates.',
    patch: {
      san: 'b8=N', playedUci: 'b7b8n', ply: 30, mover: 'white',
      beforeFen: '8/1P6/8/8/8/K7/8/k7 w - - 0 1',
      afterFen: '1N6/8/8/8/8/K7/8/k7 b - - 0 1',
      playedIsBest: true,
      beforeScore: { kind: 'cp', value: 30, winningSide: 'white' },
      afterScore: { kind: 'cp', value: 30, winningSide: 'white' },
    },
  },
  {
    id: 'dead-draw',
    name: 'Known dead draw',
    blurb: 'KNN vs K reads as theoretical, no mate needed.',
    patch: {
      san: 'Nb8', playedUci: 'a6b8', ply: 64, mover: 'white',
      afterFen: 'k7/8/1N6/8/8/8/8/KN6 w - - 0 1',
      playedIsBest: false,
      beforeScore: { kind: 'cp', value: 20, winningSide: 'white' },
      afterScore: { kind: 'cp', value: 20, winningSide: 'white' },
    },
  },
  {
    id: 'forced-move',
    name: 'Only legal move',
    blurb: 'Kb1 is the single legal move in a Ka1 corner box.',
    patch: {
      san: 'Kb1', playedUci: 'a1b1', ply: 40, mover: 'white',
      beforeFen: FORCED_BEFORE, afterFen: FORCED_AFTER,
      playedIsBest: true,
      beforeScore: { kind: 'cp', value: 20, winningSide: 'white' },
      afterScore: { kind: 'cp', value: 20, winningSide: 'white' },
    },
  },
];

export function applyPreset(base: LabState, id: string): LabState {
  const preset = PRESETS.find(entry => entry.id === id);
  if (!preset) return base;
  // Presets start from defaults so FENs, modes, and toggles from another
  // preset never leak in (e.g. a checkmate outcome surviving into a
  // sociology preset). User tweaks apply after selecting.
  return { ...DEFAULT_STATE, ...preset.patch, preset: id };
}
