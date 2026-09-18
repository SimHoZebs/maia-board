import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { buildTimeline } from './domain';
import { START_FEN } from './domain';
import {
  castleNote,
  classifyTerminal,
  enPassantNote,
  escapeNote,
  forcesMateIn,
  isKnownDeadDraw,
  matePattern,
  noveltyRef,
  pawnDamageNote,
  parriesMateNote,
  promotionNote,
  underpromotionAvoidsStalemate,
  verdictInputsForPly,
  type VerdictInputs,
} from './theory';
import type { Quality, Rarity } from './reviewMetrics';
import type { OpeningMatch } from './openings';

const quality = (label: Quality['label']): Quality => ({ label, accuracy: 20, loss: 15 });
const rarity = (label: Rarity['label']): Rarity => ({ label, r: 1, prob: 0.4, topProb: 0.4 });
const baseInputs = (overrides: Partial<VerdictInputs> = {}): VerdictInputs => ({
  beforeFen: START_FEN,
  afterFen: START_FEN,
  afterOutcome: null,
  san: 'e4',
  playedUci: 'e2e4',
  ply: 1,
  quality: quality('Best'),
  rarity: rarity('Expected'),
  opening: null,
  openingMatches: [],
  bookFlags: [false],
  initialFen: START_FEN,
  mover: 'white',
  ...overrides,
});

describe('classifyTerminal', () => {
  it('reads checkmate from the history-aware outcome', () => {
    const game = new Chess();
    ['f3', 'e5', 'g4', 'Qh4'].forEach(move => game.move(move));
    expect(classifyTerminal(game.fen(), { kind: 'checkmate', winner: 'black' })).toBe('checkmate');
  });

  it('classifies stalemate, fifty-move, and repetition draws by elimination', () => {
    expect(classifyTerminal('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', { kind: 'draw' })).toBe('stalemate');
    expect(classifyTerminal('4k3/8/8/8/8/8/8/4K2R w K - 100 150', { kind: 'draw' })).toBe('fifty');
    // Ordinary position with a history-aware draw must be repetition: FEN
    // alone cannot establish it, so elimination is the only sound reading.
    expect(classifyTerminal(START_FEN, { kind: 'draw' })).toBe('repetition');
  });

  it('stays silent off-terminal and on inconsistent data, never throws', () => {
    expect(classifyTerminal(START_FEN, null)).toBeNull();
    expect(classifyTerminal('not-a-fen', { kind: 'draw' })).toBeNull();
    expect(classifyTerminal('not-a-fen', { kind: 'checkmate', winner: 'white' })).toBe('checkmate');
  });
});

describe('matePattern', () => {
  const after = (moves: string[]): { beforeFen: string; afterFen: string; san: string; ply: number } => {
    const game = new Chess();
    moves.slice(0, -1).forEach(move => game.move(move));
    const beforeFen = game.fen();
    const applied = game.move(moves[moves.length - 1]);
    return { beforeFen, afterFen: game.fen(), san: applied.san, ply: moves.length };
  };

  it('names the four miniatures', () => {
    const fools = after(['f3', 'e5', 'g4', 'Qh4']);
    expect(matePattern({ ...fools, playedUci: 'd8h4' })).toBe("Fool's mate");
    const scholar = after(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7']);
    expect(matePattern({ ...scholar, playedUci: 'h5f7' })).toBe("Scholar's mate");
    expect(
      matePattern({
        beforeFen: '4r1k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1',
        playedUci: 'e8e1',
        san: 'Re1#',
        ply: 40,
        afterFen: '6k1/5ppp/8/8/8/8/5PPP/4r1K1 w - - 1 2',
      }),
    ).toBe('Back-rank mate');
    expect(
      matePattern({
        beforeFen: '6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1',
        playedUci: 'g5f7',
        san: 'Nf7#',
        ply: 42,
        afterFen: '6rk/5Npp/8/8/8/8/8/6K1 b - - 1 1',
      }),
    ).toBe('Smothered mate');
  });

  it('refuses theme names on shape mismatches', () => {
    // Late queen mate on f7 is not Scholar's; Qh4 by White is not Fool's.
    expect(
      matePattern({
        beforeFen: START_FEN,
        playedUci: 'h5f7',
        san: 'Qxf7#',
        ply: 30,
        afterFen: '6rk/5Npp/8/8/8/8/8/6K1 b - - 1 1',
      }),
    ).toBeNull();
    const fools = after(['f3', 'e5', 'g4', 'Qh4']);
    expect(matePattern({ ...fools, san: 'Qh4#', ply: 4, playedUci: 'd8h4' })).toBe("Fool's mate");
    // Knight mate with an empty attacker-covered flight is ordinary mate:
    // Kh1 with own pawns g2/h2, Nxf2# with a rook covering the empty g1.
    expect(
      matePattern({
        beforeFen: 'k7/8/8/8/6n1/8/5PPP/5r1K b - - 0 1',
        playedUci: 'g4f2',
        san: 'Nxf2#',
        ply: 40,
        afterFen: 'k7/8/8/8/8/8/5nPP/5r1K w - - 0 2',
      }),
    ).toBeNull();
    // Back-rank mate with a broken shield is just checkmate delivery:
    // h2 holds a defended Black knight, not White's structure.
    expect(
      matePattern({
        beforeFen: '4r1k1/5ppp/8/8/8/6b1/5PPn/7K b - - 0 1',
        playedUci: 'e8e1',
        san: 'Re1#',
        ply: 40,
        afterFen: '6k1/5ppp/8/8/8/6b1/5PPn/4r2K w - - 1 2',
      }),
    ).toBeNull();
    // Non-mates never name patterns, and bad FENs stay silent.
    expect(matePattern({ beforeFen: START_FEN, playedUci: 'e2e4', san: 'e4', ply: 1, afterFen: START_FEN })).toBeNull();
    expect(matePattern({ beforeFen: 'bad', playedUci: 'e2e4', san: 'e4', ply: 1, afterFen: 'bad' })).toBeNull();
  });

});

describe('isKnownDeadDraw', () => {
  it('flags KNN vs K for either side', () => {
    expect(isKnownDeadDraw('k7/8/nn6/8/8/8/8/K7 w - - 0 1')).toBe(true);
    expect(isKnownDeadDraw('k7/8/8/8/8/8/8/KNN5 w - - 0 1')).toBe(true);
  });

  it('leaves covered and live material alone', () => {
    expect(isKnownDeadDraw(START_FEN)).toBe(false);
    expect(isKnownDeadDraw('k7/8/8/8/8/8/8/K6B w - - 0 1')).toBe(false);
    expect(isKnownDeadDraw('k7/8/8/8/8/8/8/KQ6 w - - 0 1')).toBe(false);
    expect(isKnownDeadDraw('not-a-fen')).toBe(false);
  });
});

describe('noveltyRef', () => {
  const matches: OpeningMatch[] = [
    { ply: 2, eco: 'B12', name: 'Caro-Kann Defense' },
    { ply: 4, eco: 'B12', name: 'Caro-Kann Defense: Advance' },
  ];

  it('names the exited book on the first off-book move', () => {
    expect(noveltyRef(matches, [true, true, true, true, false], 5, START_FEN)).toEqual({
      priorName: 'Caro-Kann Defense: Advance',
      priorEco: 'B12',
    });
  });

  it('never fires in book, without a prior hit, off-start, or off-range', () => {
    expect(noveltyRef(matches, [true, true, true, true, true], 5, START_FEN)).toBeNull();
    expect(noveltyRef([], [false], 1, START_FEN)).toBeNull();
    expect(noveltyRef(matches, [true, true, true, true, false], 5, 'custom')).toBeNull();
    expect(noveltyRef(matches, [true], 0, START_FEN)).toBeNull();
    expect(noveltyRef(matches, [true], 2, START_FEN)).toBeNull();
  });
});

describe('underpromotionAvoidsStalemate', () => {
  const before = '8/P1k5/8/5B2/1NN1N3/8/8/7K w - - 0 1';

  it('proves the queen stalemates while the knight keeps play', () => {
    const queen = new Chess(before);
    queen.move({ from: 'a7', to: 'a8', promotion: 'q' });
    expect(queen.isStalemate()).toBe(true);
    const knight = new Chess(before);
    const san = knight.move({ from: 'a7', to: 'a8', promotion: 'n' }).san;
    expect(san).toBe('a8=N+');
    expect(knight.isStalemate()).toBe(false);
    expect(underpromotionAvoidsStalemate(before, 'a7a8n', knight.fen())).toBe(true);
  });

  it('rejects queen promotions, non-stalemating queens, and bad data', () => {
    const knight = new Chess(before);
    knight.move({ from: 'a7', to: 'a8', promotion: 'n' });
    expect(underpromotionAvoidsStalemate(before, 'a7a8q', knight.fen())).toBe(false);
    expect(underpromotionAvoidsStalemate(START_FEN, 'e2e4', START_FEN)).toBe(false);
    expect(underpromotionAvoidsStalemate('bad', 'a7a8n', 'bad')).toBe(false);
  });
});

describe('pawnDamageNote', () => {
  it('names newly doubled and newly isolated pawns compositionally', () => {
    expect(
      pawnDamageNote(
        'rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2',
        'rnbqkbnr/pppp1ppp/8/3PP3/8/8/PPP1PPPP/RNBQKBNR b KQkq - 0 2',
        'white',
      ),
    ).toBe('Doubles a pawn.');
    expect(
      pawnDamageNote('4k3/8/8/8/8/2p5/PP1PP3/4K3 w - - 0 1', '4k3/8/8/8/8/2P5/P2PP3/4K3 b - - 0 1', 'white'),
    ).toBe('Isolates a pawn.');
    expect(
      pawnDamageNote('4k3/8/8/8/8/2p5/PPPP4/4K3 w - - 0 1', '4k3/8/8/8/8/2P5/P1PP4/4K3 b - - 0 1', 'white'),
    ).toBe('Doubles a pawn. Isolates a pawn.');
  });

  it('stays silent without new damage and on bad FENs', () => {
    expect(pawnDamageNote(START_FEN, START_FEN, 'white')).toBeNull();
    expect(pawnDamageNote('bad', START_FEN, 'white')).toBeNull();
  });
});

describe('positive shape notes', () => {
  it('reads fresh mate forces, never accelerations or unevaluated pairs', () => {
    const cp = { type: 'cp' as const, value: 100 };
    expect(forcesMateIn(cp, { type: 'mate', value: 3, winning_side: 'white' }, 'white')).toBe(3);
    expect(forcesMateIn(cp, { type: 'mate', value: -2, winning_side: 'black' }, 'black')).toBe(2);
    // Already mating: acceleration, not a fresh force.
    expect(forcesMateIn(
      { type: 'mate', value: 5, winning_side: 'white' },
      { type: 'mate', value: 1, winning_side: 'white' },
      'white',
    )).toBeNull();
    // Mate for the wrong side, quiet pairs, and missing scores stay silent.
    expect(forcesMateIn(cp, { type: 'mate', value: 1, winning_side: 'black' }, 'white')).toBeNull();
    expect(forcesMateIn(cp, cp, 'white')).toBeNull();
    expect(forcesMateIn(null, { type: 'mate', value: 1, winning_side: 'white' }, 'white')).toBeNull();
    expect(forcesMateIn(cp, null, 'white')).toBeNull();
  });

  it('names promotions, castling sides, en passant, and escapes', () => {
    const promoFen = '8/P7/7k/8/8/8/8/7K w - - 0 1';
    const castleFen = '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1';
    expect(promotionNote(promoFen, 'a7a8q')).toBe('Promotes to a queen.');
    expect(promotionNote(promoFen, 'a7a8n')).toBe('Promotes to a knight.');
    expect(promotionNote(START_FEN, 'e2e4')).toBeNull();
    // Stale UCI on an inconsistent board stays silent.
    expect(promotionNote(START_FEN, 'a7a8q')).toBeNull();
    expect(promotionNote('bad', 'a7a8q')).toBeNull();
    expect(castleNote(castleFen, 'e1g1', 'O-O')).toBe('Castles kingside.');
    expect(castleNote(castleFen, 'e1c1', 'O-O-O+')).toBe('Castles queenside.');
    expect(castleNote(START_FEN, 'g1f3', 'Nf3')).toBeNull();
    // Stale SAN on an inconsistent board stays silent.
    expect(castleNote(START_FEN, 'e2e4', 'O-O')).toBeNull();
    expect(castleNote(castleFen, 'e1g1', 'O-O-O')).toBeNull();
    expect(enPassantNote('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6')).toBe('Takes en passant.');
    expect(enPassantNote(START_FEN, 'e2e4')).toBeNull();
    expect(enPassantNote('bad', 'e2e4')).toBeNull();
    // Bishop on b4 checks the e1 king down the diagonal.
    expect(escapeNote('4k3/8/8/8/1b6/8/8/4K3 w - - 0 1')).toBe('Gets out of check.');
    expect(escapeNote(START_FEN)).toBeNull();
    expect(escapeNote('bad')).toBeNull();
  });
});

describe('parriesMateNote', () => {
  // 17... g6 position: White's Bh6 + Qg4 battery mates on g7 against all
  // but six Black moves.
  const base = '4rrk1/ppqn1ppp/1bp4B/8/2pP2Q1/2P2N2/PP3PPP/4RRK1 b - - 3 17';
  const cp = { type: 'cp' as const, value: -150 };

  it('names the unanimous mating reply the played move denies', () => {
    expect(parriesMateNote(base, 'g7g6', cp, 'black')).toBe('Parries Qxg7#.');
  });

  it('falls back to the generic sentence on mixed threats', () => {
    // Queen on d4 instead of g4: alternatives hang Qxg7# or Qg7#.
    const mixed = '4rrk1/ppqn1ppp/1bp4B/8/2pQ4/2P2N2/PP3PPP/4RRK1 b - - 3 17';
    expect(parriesMateNote(mixed, 'e8e5', cp, 'black')).toBe('Avoids mate in one.');
  });

  it('stays silent when the played move itself allows mate', () => {
    expect(parriesMateNote(base, 'e8e7', cp, 'black')).toBeNull();
  });

  it('stays silent in quiet positions with no mating witness', () => {
    expect(parriesMateNote(START_FEN, 'e2e4', cp, 'white')).toBeNull();
  });

  it('counts alternatives, not threats: one witness is below the bar', () => {
    // A single alternative hangs two mates (Qxg7#, Bxg7#) — still one
    // witness, so the routine parry Rxf7 earns no note.
    const single = '4rrk1/ppqn1Qpp/1bp4B/8/2pP4/2P2N2/PP3PPP/4RRK1 b - - 3 17';
    expect(parriesMateNote(single, 'f8f7', cp, 'black')).toBeNull();
  });

  it('stays silent when the dodge merely delays a forced mate', () => {
    const mated = { type: 'mate' as const, value: -1, winning_side: 'white' as const };
    expect(parriesMateNote(base, 'g7g6', mated, 'black')).toBeNull();
    // Winner falls back to mate-value sign when winning_side is absent.
    expect(parriesMateNote(base, 'g7g6', { type: 'mate', value: 1 }, 'black')).toBeNull();
  });

  it('stays silent without a score and on bad data, never throws', () => {
    expect(parriesMateNote(base, 'g7g6', null, 'black')).toBeNull();
    expect(parriesMateNote(base, 'g7g6', undefined, 'black')).toBeNull();
    expect(parriesMateNote('bad', 'g7g6', cp, 'black')).toBeNull();
    expect(parriesMateNote(START_FEN, 'e2e5', cp, 'white')).toBeNull();
    expect(parriesMateNote('bad', 'bad', null, 'white')).toBeNull();
  });
});

describe('verdictInputsForPly', () => {
  const matches: OpeningMatch[] = [{ ply: 2, eco: 'B12', name: 'Caro-Kann Defense' }];

  it('selects terminal inputs over book and rarity data', () => {
    const game = new Chess();
    ['f3', 'e5', 'g4'].forEach(move => game.move(move));
    const beforeFen = game.fen();
    game.move('Qh4');
    const facts = verdictInputsForPly(
      baseInputs({
        beforeFen,
        afterFen: game.fen(),
        afterOutcome: { kind: 'checkmate', winner: 'black' },
        san: 'Qh4#',
        playedUci: 'd8h4',
        ply: 4,
        opening: { eco: 'X00', name: 'Collision Book' },
      }),
    );
    expect(facts.terminal).toBe('checkmate');
    expect(facts.matePatternName).toBe("Fool's mate");
    expect(facts.novelty).toBeNull();
    expect(facts.pawnNote).toBeNull();
  });

  it('detects dead draws and suppresses novelty and pawn notes', () => {
    const facts = verdictInputsForPly(
      baseInputs({
        afterFen: 'k7/8/nn6/8/8/8/8/K7 w - - 0 1',
        quality: quality('Blunder'),
      }),
    );
    expect(facts.deadDraw).toBe(true);
    expect(facts.novelty).toBeNull();
    expect(facts.pawnNote).toBeNull();
  });

  it('gates novelty on prior-exact book, known rarity, and reviewable grades', () => {
    const novel = baseInputs({
      ply: 3,
      openingMatches: matches,
      bookFlags: [true, true, false],
      quality: quality('Mistake'),
    });
    expect(verdictInputsForPly(novel).novelty).toEqual({ priorName: 'Caro-Kann Defense', priorEco: 'B12' });
    expect(verdictInputsForPly({ ...novel, quality: quality('Forced') }).novelty).toBeNull();
    expect(verdictInputsForPly({ ...novel, quality: quality('Allowed mate') }).novelty).toBeNull();
    expect(verdictInputsForPly({ ...novel, quality: quality('Unreviewed') }).novelty).toBeNull();
    expect(verdictInputsForPly({ ...novel, rarity: { label: 'Unknown', r: null, prob: null, topProb: null } }).novelty).toBeNull();
    expect(verdictInputsForPly({ ...novel, openingMatches: [] }).novelty).toBeNull();
  });

  it('passes bestRarity and materialNote through for the synthesis branch', () => {
    const bestRarity: Rarity = { label: 'Absent', r: null, prob: null, topProb: 0.4 };
    const facts = verdictInputsForPly(
      baseInputs({ quality: quality('Blunder'), bestRarity, materialNote: 'This line wins a pawn for Black.' }),
    );
    expect(facts.bestRarity).toEqual(bestRarity);
    expect(facts.materialNote).toBe('This line wins a pawn for Black.');
    expect(facts.pawnNote).toBeNull();
  });

  it('derives pawn notes only for damage grades without a material note', () => {
    const doubled = {
      beforeFen: 'rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2',
      afterFen: 'rnbqkbnr/pppp1ppp/8/3PP3/8/8/PPP1PPPP/RNBQKBNR b KQkq - 0 2',
      playedUci: 'd4e5',
      san: 'dxe5',
    };
    expect(verdictInputsForPly(baseInputs({ ...doubled, quality: quality('Mistake') })).pawnNote).toBe('Doubles a pawn.');
    expect(verdictInputsForPly(baseInputs({ ...doubled, quality: quality('Inaccuracy') })).pawnNote).toBe('Doubles a pawn.');
    expect(verdictInputsForPly(baseInputs({ ...doubled, quality: quality('Good') })).pawnNote).toBeNull();
  });

  it('ranks a parrying capture as a gain story, not a parry story', () => {
    // 18... Bxd4 parries Qxg7# (28 witnesses) and wins a pawn: the
    // pre-existing gain note keeps its verdict.
    const cp = { type: 'cp' as const, value: -150 };
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '4rrk1/ppqn1ppp/1bp4B/8/2pP2Q1/2P2N2/PP3PPP/4RRK1 b - - 3 17',
      afterFen: '4rrk1/ppqn1ppp/2p4B/8/2pb2Q1/2P2N2/PP3PPP/4RRK1 w - - 0 18',
      playedUci: 'b6d4',
      san: 'Bxd4',
      ply: 34,
      quality: quality('Best'),
      mover: 'black',
      beforeScore: cp,
      afterScore: cp,
    })).positiveNote).toBe('Wins a pawn.');
  });

  it('ranks the parry above the generic escape out of check', () => {
    // Qg3 blocks the Qg2+ check and parries Qg7# with no capture and no
    // fork (the queen pins itself to the file), so the specific defensive
    // claim wins over "Gets out of check.".
    const cp = { type: 'cp' as const, value: -150 };
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '4rrk1/ppqn1p2/1bp4B/8/2pP4/2P2N2/PP3PQP/4RRK1 b - - 3 17',
      afterFen: '4rrk1/pp1n1p2/1bp4B/8/2pP4/2P2Nq1/PP3PQP/4RRK1 w - - 4 18',
      playedUci: 'c7g3',
      san: 'Qg3',
      ply: 34,
      quality: quality('Best'),
      mover: 'black',
      beforeScore: cp,
      afterScore: cp,
    })).positiveNote).toBe('Parries Qg7#.');
  });

  it('explains praise grades with the single strongest why', () => {
    const cp = { type: 'cp' as const, value: 100 };
    const mate = { type: 'mate' as const, value: 3, winning_side: 'white' as const };
    // Fresh mate force outranks the only-move fact.
    expect(verdictInputsForPly(baseInputs({
      quality: quality('Best'), beforeScore: cp, afterScore: mate, isCritical: true,
    })).positiveNote).toBe('Forces mate in 3.');
    // The only move to hold outranks an immediate win on the same move.
    const capture = {
      beforeFen: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      afterFen: 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2',
      playedUci: 'e4d5',
      san: 'exd5',
    };
    expect(verdictInputsForPly(baseInputs({
      ...capture, quality: quality('Best'), isCritical: true,
    })).positiveNote).toBe('The only move to hold.');
    expect(verdictInputsForPly(baseInputs({
      ...capture, quality: quality('Best'),
    })).positiveNote).toBe('Wins a pawn.');
    // En passant names the mechanism, not the generic pawn.
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1',
      afterFen: '4k3/8/3P4/8/8/8/8/4K3 b - - 0 1',
      playedUci: 'e5d6',
      san: 'exd6',
      quality: quality('Best'),
    })).positiveNote).toBe('Takes en passant.');
    // Shape notes: promotion, castle, fork, escape.
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '8/P7/7k/8/8/8/8/7K w - - 0 1',
      afterFen: 'Q6k/8/8/8/8/8/8/7K b - - 0 1',
      playedUci: 'a7a8q',
      san: 'a8=Q+',
      quality: quality('Best'),
    })).positiveNote).toBe('Promotes to a queen.');
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1',
      afterFen: '4k3/8/8/8/8/8/8/R4RK1 b - - 1 1',
      playedUci: 'e1g1',
      san: 'O-O',
      quality: quality('Best'),
    })).positiveNote).toBe('Castles kingside.');
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '4k3/8/8/5n2/8/1Q6/2B5/4K3 b - - 0 1',
      afterFen: '4k3/8/8/8/3n4/1Q6/2B5/4K3 w - - 1 2',
      playedUci: 'f5d4',
      san: 'Nd4',
      quality: quality('Best'),
      mover: 'black',
    })).positiveNote).toBe("Nd4 forks White's bishop and queen, but only forces an even exchange.");
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '8/2qk4/8/2B5/8/8/5K2/4R3 w - - 0 1',
      afterFen: '8/2qkR3/8/2B5/8/8/5K2/8 b - - 1 1',
      playedUci: 'e1e7',
      san: 'Re7+',
      quality: quality('Best'),
    })).positiveNote).toBe("Re7+ skewers Black's king and queen.");
    // A capturing checker tells the skewer story, not the gain story.
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '8/2qkp3/8/2B5/8/8/5K2/4R3 w - - 0 1',
      afterFen: '8/2qkR3/8/2B5/8/8/5K2/8 b - - 0 1',
      playedUci: 'e1e7',
      san: 'Rxe7+',
      quality: quality('Best'),
    })).positiveNote).toBe("Rxe7+ skewers Black's king and queen.");
    // Skewer-check outranks fork on the same move: the rook also hits the
    // e8 bishop, but the forced evacuation is the stronger story.
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '4b3/2qk4/8/2B5/8/8/5K2/4R3 w - - 0 1',
      afterFen: '4b3/2qkR3/8/2B5/8/8/5K2/8 b - - 1 1',
      playedUci: 'e1e7',
      san: 'Re7+',
      quality: quality('Best'),
    })).positiveNote).toBe("Re7+ skewers Black's king and queen.");
    // Same-square recapture: the take-back is an exchange, never a fresh win.
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '4k3/8/8/8/8/2Q5/2n5/4K3 w - - 0 3',
      afterFen: '4k3/8/8/8/8/8/2Q5/4K3 b - - 0 3',
      playedUci: 'c3c2',
      san: 'Qxc2',
      quality: quality('Best'),
      prevBeforeFen: '4k3/8/8/8/3n4/2Q5/2B5/4K3 b - - 2 2',
      prevUci: 'd4c2',
    })).positiveNote).toBe('Takes the knight back, but only forces an even exchange.');
    // Winning recapture names the net instead.
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '4k3/8/8/4n3/3P4/8/8/4K3 w - - 0 2',
      afterFen: '4k3/8/8/4P3/8/8/8/4K3 b - - 0 2',
      playedUci: 'd4e5',
      san: 'dxe5',
      quality: quality('Best'),
      prevBeforeFen: '4k3/3n4/8/4P3/3P4/8/8/4K3 b - - 0 1',
      prevUci: 'd7e5',
    })).positiveNote).toBe('Wins a knight for a pawn.');
    expect(verdictInputsForPly(baseInputs({
      beforeFen: '4k3/8/8/8/1b6/8/8/4K3 w - - 0 1',
      afterFen: '4k3/8/8/8/1b6/8/8/3K4 b - - 1 1',
      playedUci: 'e1d1',
      san: 'Kd1',
      quality: quality('Good'),
    })).positiveNote).toBe('Gets out of check.');
  });

  it('keeps the positive why off negative grades, terminals, book, and draws', () => {
    const capture = {
      beforeFen: 'rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      afterFen: 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2',
      playedUci: 'e4d5',
      san: 'exd5',
    };
    // A capturing blunder stays a blunder story, never a win story.
    expect(verdictInputsForPly(baseInputs({ ...capture, quality: quality('Blunder') })).positiveNote).toBeNull();
    // Terminal facts, book hits, and dead draws outrank any why.
    expect(verdictInputsForPly(baseInputs({
      ...capture,
      quality: quality('Best'),
      afterOutcome: { kind: 'checkmate' as const, winner: 'white' as const },
    })).positiveNote).toBeNull();
    expect(verdictInputsForPly(baseInputs({
      ...capture, quality: quality('Best'), opening: { eco: 'C50', name: 'Italian Game' },
    })).positiveNote).toBeNull();
    expect(verdictInputsForPly(baseInputs({
      quality: quality('Best'),
      afterFen: 'k7/8/nn6/8/8/8/8/K7 w - - 0 1',
    })).positiveNote).toBeNull();
    // Quiet lines stay quiet: no praise, no why.
    expect(verdictInputsForPly(baseInputs({ quality: quality('Unreviewed') })).positiveNote).toBeNull();
  });

  it('reads branch timelines without re-walking the base line', () => {
    const base = buildTimeline(START_FEN, ['e2e4', 'e7e5']);
    const branch = buildTimeline(START_FEN, ['e2e4', 'e7e5', 'g1f3']);
    expect(base.rows).toHaveLength(3);
    const beforeRow = branch.rows[2];
    const afterRow = branch.rows[3];
    const facts = verdictInputsForPly(
      baseInputs({
        beforeFen: beforeRow.fen,
        afterFen: afterRow.fen,
        san: afterRow.san,
        playedUci: afterRow.uci,
        ply: afterRow.ply,
        initialFen: branch.initialFen,
      }),
    );
    expect(facts.san).toBe('Nf3');
    expect(facts.terminal).toBeNull();
  });
});
