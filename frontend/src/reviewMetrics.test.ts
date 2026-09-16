import { expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { classifyLoss, describeMove, effectiveQuality, isMateFor, maiaRarity, moveAccuracy, reviewMove, SEARCH_POLICY, terminalEvaluation, whiteWin, type EngineGrade, type Evaluation, type Quality, type Rarity } from './reviewMetrics';
const evaluation = (cp: number): Evaluation => ({ engine: 'Stockfish 19', search_policy: SEARCH_POLICY, score: { type: 'cp', value: cp }, depth: 14, best_move: 'e2e4', lines: [], terminal: null });
it('uses canonical white cp and preserves mate winner independent of distance', () => {
  expect(whiteWin({ type: 'cp', value: 0 })).toBe(50);
  expect(whiteWin({ type: 'cp', value: -100 })).toBeLessThan(50);
  expect(whiteWin({ type: 'mate', value: 0, winning_side: 'white' })).toBe(100);
  expect(whiteWin({ type: 'mate', value: -3 })).toBe(0);
});
it('classifies exact boundaries and clamps accuracy', () => {
  expect([4.99, 5, 10, 20].map(classifyLoss)).toEqual([null, 'Inaccuracy', 'Mistake', 'Blunder']);
  expect(moveAccuracy(0)).toBe(100); expect(moveAccuracy(100)).toBe(0);
});
it('measures both scores from the black mover perspective', () => {
  const game = new Chess(); game.move('e4');
  expect(reviewMove(evaluation(-100), evaluation(100), game, 'e7e5').label).toBe('Mistake');
  expect(reviewMove(evaluation(100), evaluation(-100), game, 'e7e5').accuracy).toBe(100);
});
it('requires a strong evaluated alternative gap for Critical and excludes incomplete pairs', () => {
  const before = evaluation(200); before.lines = [{ move: 'e2e4', score: before.score, depth: 14 }, { move: 'd2d4', score: { type: 'cp', value: 0 }, depth: 14 }];
  expect(reviewMove(before, before, new Chess(), 'e2e4').label).toBe('Critical');
  before.lines[1].score = { type: 'mate', value: 3 };
  expect(reviewMove(before, before, new Chess(), 'e2e4').label).toBe('Top');
  expect(reviewMove(before, undefined, new Chess(), 'e2e4').accuracy).toBeNull();
});
it('recognizes full-history repetition as terminal', () => {
  const game = new Chess(); ['Nf3','Nf6','Ng1','Ng8','Nf3','Nf6','Ng1','Ng8'].forEach(move => game.move(move));
  expect(terminalEvaluation(game)?.terminal).toBe('draw');
});
it('includes forced moves at 100 despite engine noise and ignores preserved mate distance', () => {
  const game = new Chess('5Q1k/8/5K2/8/8/8/8/8 b - - 0 1');
  expect(game.moves()).toHaveLength(1);
  expect(reviewMove(evaluation(-900), evaluation(900), game, 'h8h7')).toEqual({ label: 'Forced', accuracy: 100, loss: 0 });
  const before = { ...evaluation(0), score: { type: 'mate' as const, value: 3 } };
  const after = { ...evaluation(0), score: { type: 'mate' as const, value: 8 } };
  expect(reviewMove(before, after, new Chess(), 'e2e4').accuracy).toBe(100);
  expect(reviewMove(before, { ...after, score: { type: 'mate', value: -1 } }, new Chess(), 'e2e4').label).toBe('Blunder');
});
it('flags avoidable mate as Allowed mate with zero accuracy but preserved loss', () => {
  // fxg3-type case: dead lost on cp (~2.5%) but not mated; the played move
  // lets Black force mate while the best move survives. Win% loss alone
  // (< 5) would read Holds — Allowed mate must fire first with accuracy 0.
  const before = evaluation(-1000); before.best_move = 'g1f3';
  const after = { ...evaluation(0), score: { type: 'mate' as const, value: -1, winning_side: 'black' as const } };
  const allowedMate = reviewMove(before, after, new Chess(), 'e2e4');
  expect(allowedMate.label).toBe('Allowed mate');
  expect(allowedMate.accuracy).toBe(0);
  expect(allowedMate.loss).toBeGreaterThan(0);
  expect(allowedMate.loss!).toBeLessThan(5);
  // Black-mover mirror: White mates after Black's move, best avoided it.
  const game = new Chess(); game.move('e4');
  const bBefore = evaluation(1000); bBefore.best_move = 'e7e5';
  const bAfter = { ...evaluation(0), score: { type: 'mate' as const, value: 1, winning_side: 'white' as const } };
  expect(reviewMove(bBefore, bAfter, game, 'd7d5').label).toBe('Allowed mate');
  // Winner falls back to mate-value sign when winning_side is absent.
  expect(isMateFor({ type: 'mate', value: -3 }, 'black')).toBe(true);
  expect(isMateFor({ type: 'mate', value: 3 }, 'black')).toBe(false);
  expect(isMateFor({ type: 'cp', value: -1000 }, 'black')).toBe(false);
});
it('never allows mate on unavoidable or best-played mates, and forced still wins', () => {
  // Mate acceleration (already mated, M5 -> M1) with non-best play: not Allowed mate.
  const mated = { ...evaluation(0), score: { type: 'mate' as const, value: -5, winning_side: 'black' as const }, best_move: 'g1f3' };
  const faster = { ...evaluation(0), score: { type: 'mate' as const, value: -1, winning_side: 'black' as const } };
  expect(reviewMove(mated, faster, new Chess(), 'e2e4').label).not.toBe('Allowed mate');
  // Best move played: never Allowed mate even if the after-position reads as mate.
  const best = evaluation(-1000); best.best_move = 'e2e4';
  const matedAfter = { ...evaluation(0), score: { type: 'mate' as const, value: -1, winning_side: 'black' as const } };
  expect(reviewMove(best, matedAfter, new Chess(), 'e2e4').label).not.toBe('Allowed mate');
  // Single legal move allowing mate stays Forced.
  const forced = new Chess('5Q1k/8/5K2/8/8/8/8/8 b - - 0 1');
  expect(forced.moves()).toHaveLength(1);
  expect(reviewMove(evaluation(-900), matedAfter, forced, 'h8h7').label).toBe('Forced');
});
const maia = (probs: [string, number][], degraded = false) => ({ top_moves: probs.map(([move, prob]) => ({ move, prob })), degraded });
it('reads a missed win that stays alive as Blunder by loss', () => {
  // winB ~90 (cp 600), winA 50 (cp 0): loss ~40 is Blunder damage even
  // though the mover is alive at 50. There is no Miss label: the engine
  // measures loss only.
  const before = evaluation(600); before.best_move = 'g1f3';
  expect(reviewMove(before, evaluation(0), new Chess(), 'e2e4').label).toBe('Blunder');
  // Self-destructed instead (winA ~2): also Blunder.
  expect(reviewMove(before, evaluation(-1000), new Chess(), 'e2e4').label).toBe('Blunder');
  // Still winning afterwards (winA ~90): no damage, just imprecise at most.
  const kept = evaluation(600); kept.best_move = 'g1f3';
  expect(reviewMove(kept, evaluation(600), new Chess(), 'e2e4').label).toBe('Holds');
  // No win on the board (winB ~55): ordinary Mistake.
  const mid = evaluation(60); mid.best_move = 'g1f3';
  expect(reviewMove(mid, evaluation(-60), new Chess(), 'e2e4').label).toBe('Mistake');
  // Played the win: Top.
  expect(reviewMove(before, before, new Chess(), 'g1f3').label).toBe('Top');
});
it('bands Maia rarity by ratio to the top move, not rank or absolute prob', () => {
  // 13% under a 15% top is the same band as the top itself.
  const close = maia([['e2e4', 0.15], ['d2d4', 0.13]]);
  expect(maiaRarity(close, 'e2e4').label).toBe('Expected');
  expect(maiaRarity(close, 'd2d4').label).toBe('Expected');
  // A 12% rank-1 in a wide position is still Expected.
  expect(maiaRarity(maia([['e2e4', 0.12], ['d2d4', 0.05]]), 'e2e4').label).toBe('Expected');
  expect(maiaRarity(maia([['e2e4', 0.4], ['d2d4', 0.15]]), 'd2d4').label).toBe('Uncommon');
  expect(maiaRarity(maia([['e2e4', 0.4], ['d2d4', 0.05]]), 'd2d4').label).toBe('Rare');
  // Qe3-like 9.5% under a 32% top (r ~= 0.30) reads Rare against the
  // majority; f3-like 14.9% under a 34% top (r ~= 0.44) stays Uncommon.
  expect(maiaRarity(maia([['f2f3', 0.32], ['h2h3', 0.28], ['d3d4', 0.11], ['e1e3', 0.095], ['d2f3', 0.08]]), 'e1e3').label).toBe('Rare');
  expect(maiaRarity(maia([['h2h3', 0.34], ['f2f3', 0.149], ['d2f3', 0.14], ['d3d4', 0.13], ['g5f3', 0.06]]), 'f2f3').label).toBe('Uncommon');
  expect(maiaRarity(close, 'g1f3').label).toBe('Absent');
  expect(maiaRarity(maia([]), 'e2e4').label).toBe('Unknown');
  expect(maiaRarity(undefined, 'e2e4').label).toBe('Unknown');
  expect(maiaRarity(maia([['e2e4', 0.5]], true), 'e2e4').label).toBe('Unknown');
});
it('verdicts only the quality-by-rarity synthesis, never the grade', () => {
  const quality = (label: Quality['label'], loss: number | null = 0): Quality => ({ label, accuracy: 100, loss });
  const rarity = (label: Rarity['label']): Rarity => ({ label, r: 1, prob: 0.4, topProb: 0.4 });
  expect(describeMove({ san: 'Nf3', quality: quality('Best'), rarity: rarity('Expected'), elo: 1600 }))
    .toBe('The natural choice — Maia at 1600 predicts 40% for this move.');
  expect(describeMove({ san: 'Nxh7+', quality: quality('Best'), rarity: rarity('Rare'), elo: 1600 }))
    .toBe('A rare find — Maia at 1600 predicts only 40%.');
  expect(describeMove({ san: 'Re8', quality: quality('Great'), rarity: rarity('Rare'), elo: 1400 }))
    .toBe('A rare find — Maia at 1400 predicts only 40%.');
  expect(describeMove({ san: 'Re8', quality: quality('Great'), rarity: rarity('Expected'), elo: 1400 }))
    .toBe('The natural choice — Maia at 1400 predicts 40% for this move.');
  expect(describeMove({ san: 'h3', quality: quality('Good'), rarity: rarity('Uncommon'), elo: 1600 }))
    .toBe('A meaningful minority that holds — Maia at 1600 predicts 40% for this move.');
  expect(describeMove({ san: 'Nxh7+', quality: quality('Excellent'), rarity: rarity('Rare'), elo: 1600 }))
    .toBe('An exceptional find — Maia at 1600 predicts only 40%.');
  expect(describeMove({ san: 'Qh5', quality: quality('Blunder', 25), rarity: rarity('Expected'), elo: 1600 }))
    .toBe('An easy mistake to make — Maia at 1600 predicts 40% for this move.');
  expect(describeMove({ san: 'd5', quality: quality('Mistake', 12), rarity: rarity('Uncommon'), elo: 1600 }))
    .toBe('A tempting sidestep — Maia at 1600 predicts only 40%.');
  expect(describeMove({ san: 'Kd2', quality: quality('Blunder', 40), rarity: rarity('Uncommon'), elo: 1600 }))
    .toBe('A tempting sidestep — Maia at 1600 predicts only 40%.');
  expect(describeMove({ san: 'fxg3', quality: quality('Allowed mate'), rarity: rarity('Expected'), elo: 1600 }))
    .toBe('An easy mistake to make — Maia at 1600 predicts 40% for this move.');
  expect(describeMove({ san: 'fxg3', quality: quality('Allowed mate'), rarity: rarity('Rare'), elo: 1600 }))
    .toBe('An unusual slip — Maia at 1600 predicts only 40%.');
  expect(describeMove({ san: 'Nf3', quality: quality('Best'), rarity: rarity('Unknown'), elo: 1600 })).toBeNull();
  expect(describeMove({ san: 'e4', quality: quality('Forced'), rarity: rarity('Unknown'), elo: 1600 }))
    .toBe('e4 was the only legal move.');
  expect(describeMove({ san: 'e4', quality: quality('Unreviewed'), rarity: rarity('Unknown'), elo: 1600 })).toBeNull();
  expect(describeMove({ san: 'e4', quality: undefined, rarity: undefined, elo: 1600 })).toBeNull();
});
it('reports actual model probability without population or brilliance claims', () => {
  const quality: Quality = { label: 'Blunder', accuracy: 20, loss: 25 };
  const rarity = maiaRarity(maia([['e2e4', .15], ['d2d4', .13]]), 'd2d4');
  const text = describeMove({ san: 'd4', quality, rarity, elo: 1600 });
  expect(text).toContain('predicts 13%');
  expect(text).not.toMatch(/most|nobody|population/i);
  const absent = describeMove({ san: 'Nf3', quality: { ...quality, label: 'Great' }, rarity: maiaRarity(maia([['e2e4', .15]]), 'g1f3'), elo: 1600 });
  expect(absent).toBe("A genuine find — absent from Maia's top choices at 1600.");
  expect(absent).not.toMatch(/brilliant|only good|impossible|nobody/i);
  const absentBlunder = describeMove({ san: 'h4', quality, rarity: maiaRarity(maia([['e2e4', .15]]), 'h2h4'), elo: 1600 });
  expect(absentBlunder).toBe("Worth a second look — absent from Maia's top choices at 1600.");
  const absentExcellent = describeMove({ san: 'Re8', quality: { ...quality, label: 'Excellent' }, rarity: maiaRarity(maia([['e2e4', .15]]), 'e8e7'), elo: 1600 });
  expect(absentExcellent).toBe("An exceptional find — absent from Maia's top choices at 1600.");
  const absentGood = describeMove({ san: 'h3', quality: { ...quality, label: 'Good' }, rarity: maiaRarity(maia([['e2e4', .15]]), 'h2h3'), elo: 1600 });
  expect(absentGood).toBe("Absent from Maia's top choices at 1600, and it holds.");
  expect(describeMove({ san: 'd4', quality, rarity: undefined, elo: 1600 })).toBeNull();
});
it('gates praise on Maia: Excellent needs absent-or-tiny, Expected/Unknown cap at Best', () => {
  const critical: EngineGrade = { label: 'Critical', accuracy: 100, loss: 0 };
  const expected: Rarity = { label: 'Expected', r: 1, prob: 0.542, topProb: 0.542 };
  expect(effectiveQuality(critical, expected)?.label).toBe('Best');
  // Verdict text is identical either way, so only the badge changes.
  expect(describeMove({ san: 'Rxb3+', quality: { ...critical, label: 'Best' }, rarity: expected, elo: 1400 }))
    .toBe(describeMove({ san: 'Rxb3+', quality: { ...critical, label: 'Best' }, rarity: expected, elo: 1400 }));
  const uncommon: Rarity = { label: 'Uncommon', r: 0.4, prob: 0.2, topProb: 0.5 };
  expect(effectiveQuality(critical, uncommon)?.label).toBe('Great');
  // Rare tiny under 5%: exceptional. Rare tiny at/over 5%: great.
  const tiny: Rarity = { label: 'Rare', r: 0.1, prob: 0.03, topProb: 0.3 };
  expect(effectiveQuality(critical, tiny)?.label).toBe('Excellent');
  const listed: Rarity = { label: 'Rare', r: 0.2, prob: 0.1, topProb: 0.5 };
  expect(effectiveQuality(critical, listed)?.label).toBe('Great');
  // Absent from the top 5 counts as 0%: exceptional.
  expect(effectiveQuality(critical, { label: 'Absent', r: null, prob: null, topProb: 0.5 })?.label).toBe('Excellent');
  // No Maia evidence: no praise without a find.
  expect(effectiveQuality(critical, { label: 'Unknown', r: null, prob: null, topProb: null })?.label).toBe('Best');
  expect(effectiveQuality(critical, undefined)?.label).toBe('Best');
  // Top/Holds translate unconditionally: Best needs no difficulty proof.
  expect(effectiveQuality({ ...critical, label: 'Top' }, expected)?.label).toBe('Best');
  expect(effectiveQuality({ ...critical, label: 'Holds' }, expected)?.label).toBe('Good');
  expect(effectiveQuality(undefined, expected)).toBeUndefined();
  // Shifted interval [0.25, 1/3): now Rare, so tiny probs escalate to Excellent.
  const shiftedTiny: Rarity = { label: 'Rare', r: 0.28, prob: 0.04, topProb: 0.143 };
  expect(effectiveQuality(critical, shiftedTiny)?.label).toBe('Excellent');
  const shiftedListed: Rarity = { label: 'Rare', r: 0.28, prob: 0.07, topProb: 0.25 };
  expect(effectiveQuality(critical, shiftedListed)?.label).toBe('Great');
});
it('notes when a mistake was hard to avoid because the best move was rare', () => {
  const blunder: Quality = { label: 'Blunder', accuracy: 20, loss: 25 };
  const expected: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  const rareBest: Rarity = { label: 'Rare', r: 0.1, prob: 0.02, topProb: 0.2 };
  const absentBest: Rarity = { label: 'Absent', r: null, prob: null, topProb: 0.4 };
  // Obvious mistake, elusive best move: forgivable.
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, elo: 1400, bestRarity: rareBest }))
    .toBe('Hard to avoid — Maia at 1400 predicts only 2% for the best move.');
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, elo: 1400, bestRarity: absentBest }))
    .toBe("Hard to avoid — the best move is absent from Maia's top choices at 1400.");
  // Obvious mistake, obvious best move: damning as before.
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, elo: 1400, bestRarity: expected }))
    .toBe('An easy mistake to make — Maia at 1400 predicts 40% for this move.');
  // No best-move evidence: standard wording.
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, elo: 1400 }))
    .toBe('An easy mistake to make — Maia at 1400 predicts 40% for this move.');
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, elo: 1400, bestRarity: { label: 'Unknown', r: null, prob: null, topProb: null } }))
    .toBe('An easy mistake to make — Maia at 1400 predicts 40% for this move.');
  // Overrides every negative temptation sentence, not just Expected.
  const uncommon: Rarity = { label: 'Uncommon', r: 0.4, prob: 0.2, topProb: 0.5 };
  expect(describeMove({ san: 'd5', quality: { ...blunder, label: 'Mistake' }, rarity: uncommon, elo: 1400, bestRarity: rareBest }))
    .toBe('Hard to avoid — Maia at 1400 predicts only 2% for the best move.');
  // Praise and holds never read the best-move axis.
  expect(describeMove({ san: 'Nf3', quality: { ...blunder, label: 'Best' }, rarity: expected, elo: 1400, bestRarity: rareBest }))
    .toBe('The natural choice — Maia at 1400 predicts 40% for this move.');
  expect(describeMove({ san: 'h3', quality: { ...blunder, label: 'Good' }, rarity: uncommon, elo: 1400, bestRarity: rareBest }))
    .toBe('A meaningful minority that holds — Maia at 1400 predicts 20% for this move.');
  // Shifted interval: a best move at r ~= 0.29 with prob < 5% is now Rare-tiny
  // and forgives; the same ratio at prob >= 5% stays standard temptation.
  const shiftedBestTiny: Rarity = { label: 'Rare', r: 0.29, prob: 0.04, topProb: 0.138 };
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, elo: 1400, bestRarity: shiftedBestTiny }))
    .toBe('Hard to avoid — Maia at 1400 predicts only 4% for the best move.');
  const shiftedBestListed: Rarity = { label: 'Rare', r: 0.29, prob: 0.06, topProb: 0.207 };
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, elo: 1400, bestRarity: shiftedBestListed }))
    .toBe('An easy mistake to make — Maia at 1400 predicts 40% for this move.');
  // f3-like Uncommon negative keeps "only": holds alone drops it because a
  // meaningful minority that holds is neutral, while a sidestep stays unusual.
  const f3like: Rarity = { label: 'Uncommon', r: 0.438, prob: 0.149, topProb: 0.34 };
  expect(describeMove({ san: 'f3', quality: { ...blunder, label: 'Mistake' }, rarity: f3like, elo: 1400 }))
    .toBe('A tempting sidestep — Maia at 1400 predicts only 14.9%.');
});
it('appends the material note only for Mistake/Blunder', () => {
  const quality = (label: Quality['label']): Quality => ({ label, accuracy: 20, loss: 15 });
  const rarity: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  const note = 'Best line wins a pawn for Black in the next 1.';
  expect(describeMove({ san: 'Qh5', quality: quality('Blunder'), rarity, elo: 1600, materialNote: note }))
    .toBe(`An easy mistake to make — Maia at 1600 predicts 40% for this move. ${note}`);
  expect(describeMove({ san: 'd5', quality: quality('Mistake'), rarity, elo: 1600, materialNote: note }))
    .toContain(note);
  expect(describeMove({ san: 'd5', quality: quality('Inaccuracy'), rarity, elo: 1600, materialNote: note }))
    .not.toContain('Best line');
  expect(describeMove({ san: 'fxg3', quality: quality('Allowed mate'), rarity, elo: 1600, materialNote: note }))
    .not.toContain('Best line');
  expect(describeMove({ san: 'Nf3', quality: quality('Best'), rarity, elo: 1600, materialNote: note }))
    .not.toContain('Best line');
});
