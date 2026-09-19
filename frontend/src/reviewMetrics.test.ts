import { expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { classifyLoss, describeMove, effectiveQuality, isMateFor, maiaRarity, moveAccuracy, outcomeExpected, reviewMove, SEARCH_POLICY, terminalEvaluation, whiteExpected, whiteWin, type EngineGrade, type Evaluation, type ObjectiveGrade, type Quality, type Rarity } from './reviewMetrics';
import { maiaExpected } from './objective/maia';
const evaluation = (cp: number): Evaluation => ({ engine: 'Stockfish 19', search_policy: SEARCH_POLICY, score: { type: 'cp', value: cp }, depth: 14, best_move: 'e2e4', lines: [], terminal: null });
const grading = (top: string | null, wdl: [number, number, number], afterExpected: number | null): ObjectiveGrade => ({
  top, expected: maiaExpected(wdl), afterExpected, beforePending: false, afterPending: false,
});
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
const maia = (probs: [string, number][], degraded = false) => ({ top_moves: probs.map(([move, prob]) => ({ move, prob, wdl: [0.2, 0.3, 0.5] as [number, number, number] })), degraded });
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
it('reads terminal outcomes and White-relative views provider-neutrally', () => {
  expect(maiaExpected([0.2, 0.3, 0.5])).toBeCloseTo(65, 9);
  expect(outcomeExpected({ kind: 'checkmate', winner: 'white' })).toBe(100);
  expect(outcomeExpected({ kind: 'draw' })).toBe(50);
  expect(outcomeExpected(null)).toBeNull();
  expect(whiteExpected('white', 65)).toBe(65);
  expect(whiteExpected('black', 65)).toBe(35);
});
it('grades objective top play as Top even when Stockfish disagrees', () => {
  // SF sees a self-destruction (600 -> -1000); the objective top plays it and hold.
  const before = evaluation(600); before.best_move = 'e2e4';
  const grade = reviewMove(before, evaluation(-1000), new Chess(), 'e2e4', grading('e2e4', [0.1, 0.2, 0.7], 80));
  expect(grade.label).toBe('Top');
});
it('flags objective expected-score drops with shared cutoffs', () => {
  // Flat SF pair (no engine loss) isolates the Maia axis: 80 -> 50.
  const grade = reviewMove(evaluation(0), evaluation(0), new Chess(), 'd2d4', grading('e2e4', [0.1, 0.2, 0.7], 50));
  expect(grade.label).toBe('Blunder');
  expect(grade.loss).toBeCloseTo(30, 9);
  expect(grade.accuracy).toBe(moveAccuracy(30));
  const mistake = reviewMove(evaluation(0), evaluation(0), new Chess(), 'd2d4', grading('e2e4', [0.1, 0.2, 0.7], 68));
  expect(mistake.label).toBe('Mistake');
  const holds = reviewMove(evaluation(0), evaluation(0), new Chess(), 'd2d4', grading('e2e4', [0.1, 0.2, 0.7], 78));
  expect(holds.label).toBe('Holds');
});
it('caps Stockfish negatives once the objective lane settles without finding loss', () => {
  // SF alone reads Mistake (60 -> -60); objective holds (loss 2) with another top.
  const before = evaluation(60); before.best_move = 'g1f3';
  const grade = reviewMove(before, evaluation(-60), new Chess(), 'e2e4', grading('g1f3', [0.1, 0.2, 0.7], 78));
  expect(grade.label).toBe('Holds');
});
it('holds the spinner while the objective lane is pending, falls back when it fails', () => {
  const blunderSf = reviewMove(evaluation(600), evaluation(-1000), new Chess(), 'd2d4');
  expect(blunderSf.label).toBe('Blunder');
  const pending: ObjectiveGrade = { top: null, expected: null, afterExpected: null, beforePending: true, afterPending: false };
  expect(reviewMove(evaluation(600), evaluation(-1000), new Chess(), 'd2d4', pending).label).toBe('Unreviewed');
  const failed: ObjectiveGrade = { top: null, expected: null, afterExpected: null, beforePending: false, afterPending: false };
  expect(reviewMove(evaluation(600), evaluation(-1000), new Chess(), 'd2d4', failed).label).toBe('Blunder');
  const degraded: ObjectiveGrade = { top: null, expected: 80, afterExpected: 80, beforePending: false, afterPending: false };
  expect(reviewMove(evaluation(600), evaluation(-1000), new Chess(), 'd2d4', degraded).label).toBe('Blunder');
});
it('keeps Critical praise reachable through the 2400 top', () => {
  const before = evaluation(200); before.lines = [{ move: 'e2e4', score: before.score, depth: 14 }, { move: 'd2d4', score: { type: 'cp', value: 0 }, depth: 14 }];
  expect(reviewMove(before, before, new Chess(), 'e2e4', grading('e2e4', [0.1, 0.2, 0.7], 80)).label).toBe('Critical');
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
  expect(describeMove({ san: 'Nf3', quality: quality('Best'), rarity: rarity('Expected') }))
    .toBe('The natural choice.');
  expect(describeMove({ san: 'Nxh7+', quality: quality('Best'), rarity: rarity('Rare') }))
    .toBe('A rare find.');
  expect(describeMove({ san: 'Re8', quality: quality('Great'), rarity: rarity('Rare') }))
    .toBe('A rare find.');
  expect(describeMove({ san: 'Re8', quality: quality('Great'), rarity: rarity('Expected') }))
    .toBe('The natural choice.');
  expect(describeMove({ san: 'h3', quality: quality('Good'), rarity: rarity('Uncommon') }))
    .toBe('A meaningful minority that holds.');
  expect(describeMove({ san: 'Nxh7+', quality: quality('Excellent'), rarity: rarity('Rare') }))
    .toBe('An exceptional find.');
  expect(describeMove({ san: 'Qh5', quality: quality('Blunder', 25), rarity: rarity('Expected') }))
    .toBe('A common blunder.');
  expect(describeMove({ san: 'd5', quality: quality('Mistake', 12), rarity: rarity('Uncommon') }))
    .toBe('An uncommon mistake.');
  expect(describeMove({ san: 'Kd2', quality: quality('Blunder', 40), rarity: rarity('Uncommon') }))
    .toBe('An uncommon blunder.');
  expect(describeMove({ san: 'fxg3', quality: quality('Allowed mate'), rarity: rarity('Expected') }))
    .toBe('A common move that allows mate.');
  expect(describeMove({ san: 'fxg3', quality: quality('Allowed mate'), rarity: rarity('Rare') }))
    .toBe('A rare move that allows mate.');
  expect(describeMove({ san: 'Nf3', quality: quality('Best'), rarity: rarity('Unknown') })).toBeNull();
  expect(describeMove({ san: 'e4', quality: quality('Forced'), rarity: rarity('Unknown') }))
    .toBe('e4 was the only legal move.');
  expect(describeMove({ san: 'e4', quality: quality('Unreviewed'), rarity: rarity('Unknown') })).toBeNull();
  expect(describeMove({ san: 'e4', quality: undefined, rarity: undefined })).toBeNull();
});
it('keeps probabilities in the candidate lists, never in the verdict', () => {
  const quality: Quality = { label: 'Blunder', accuracy: 20, loss: 25 };
  const rarity = maiaRarity(maia([['e2e4', .15], ['d2d4', .13]]), 'd2d4');
  const text = describeMove({ san: 'd4', quality: { ...quality, label: 'Best' }, rarity });
  expect(text).toBe('The natural choice.');
  expect(text).not.toMatch(/Maia|predicts|%/);
  expect(text).not.toMatch(/most|nobody|population/i);
  const absent = describeMove({ san: 'Nf3', quality: { ...quality, label: 'Great' }, rarity: maiaRarity(maia([['e2e4', .15]]), 'g1f3') });
  expect(absent).toBe('A genuine find.');
  expect(absent).not.toMatch(/brilliant|only good|impossible|nobody|Maia|%/i);
  const absentBlunder = describeMove({ san: 'h4', quality, rarity: maiaRarity(maia([['e2e4', .15]]), 'h2h4') });
  expect(absentBlunder).toBe('An unlisted blunder.');
  const absentExcellent = describeMove({ san: 'Re8', quality: { ...quality, label: 'Excellent' }, rarity: maiaRarity(maia([['e2e4', .15]]), 'e8e7') });
  expect(absentExcellent).toBe('An exceptional find.');
  const absentGood = describeMove({ san: 'h3', quality: { ...quality, label: 'Good' }, rarity: maiaRarity(maia([['e2e4', .15]]), 'h2h3') });
  expect(absentGood).toBe('An unlisted choice that holds.');
  expect(describeMove({ san: 'd4', quality, rarity: undefined })).toBeNull();
});
it('gates praise on Maia: Excellent needs absent-or-tiny, Expected/Unknown cap at Best', () => {
  const critical: EngineGrade = { label: 'Critical', accuracy: 100, loss: 0 };
  const expected: Rarity = { label: 'Expected', r: 1, prob: 0.542, topProb: 0.542 };
  expect(effectiveQuality(critical, expected)?.label).toBe('Best');
  // Verdict text is identical either way, so only the badge changes.
  expect(describeMove({ san: 'Rxb3+', quality: { ...critical, label: 'Best' }, rarity: expected }))
    .toBe(describeMove({ san: 'Rxb3+', quality: { ...critical, label: 'Best' }, rarity: expected }));
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
it('passes shared display labels through effectiveQuality unchanged', () => {
  // Locks the isQualityLabel narrowing: engine facts already translated
  // above, so every remaining label must survive with accuracy/loss intact.
  const labels = ['Forced', 'Allowed mate', 'Blunder', 'Mistake', 'Inaccuracy', 'Unreviewed'] as const;
  for (const label of labels) {
    const grade: EngineGrade = { label, accuracy: 42, loss: 7 };
    expect(effectiveQuality(grade, undefined)).toEqual({ label, accuracy: 42, loss: 7 });
  }
});
it('notes when a mistake was hard to avoid because the best move was rare', () => {
  const blunder: Quality = { label: 'Blunder', accuracy: 20, loss: 25 };
  const expected: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  const rareBest: Rarity = { label: 'Rare', r: 0.1, prob: 0.02, topProb: 0.2 };
  const absentBest: Rarity = { label: 'Absent', r: null, prob: null, topProb: 0.4 };
  // Obvious mistake, elusive best move: forgivable — one short sentence, no
  // number. The concrete consequence lives in the "This line …" second
  // sentence plus its clickable PV.
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, bestRarity: rareBest }))
    .toBe('Hard to avoid.');
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, bestRarity: absentBest }))
    .toBe('Hard to avoid.');
  // Obvious mistake, obvious best move: damning as before.
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, bestRarity: expected }))
    .toBe('A common blunder.');
  // No best-move evidence: standard wording.
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected }))
    .toBe('A common blunder.');
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, bestRarity: { label: 'Unknown', r: null, prob: null, topProb: null } }))
    .toBe('A common blunder.');
  // Overrides every negative standard sentence, not just Expected.
  const uncommon: Rarity = { label: 'Uncommon', r: 0.4, prob: 0.2, topProb: 0.5 };
  expect(describeMove({ san: 'd5', quality: { ...blunder, label: 'Mistake' }, rarity: uncommon, bestRarity: rareBest }))
    .toBe('Hard to avoid.');
  // Praise and holds never read the best-move axis.
  expect(describeMove({ san: 'Nf3', quality: { ...blunder, label: 'Best' }, rarity: expected, bestRarity: rareBest }))
    .toBe('The natural choice.');
  expect(describeMove({ san: 'h3', quality: { ...blunder, label: 'Good' }, rarity: uncommon, bestRarity: rareBest }))
    .toBe('A meaningful minority that holds.');
  // Shifted interval: a best move at r ~= 0.29 with prob < 5% is now Rare-tiny
  // and forgives; the same ratio at prob >= 5% stays standard wording.
  const shiftedBestTiny: Rarity = { label: 'Rare', r: 0.29, prob: 0.04, topProb: 0.138 };
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, bestRarity: shiftedBestTiny }))
    .toBe('Hard to avoid.');
  const shiftedBestListed: Rarity = { label: 'Rare', r: 0.29, prob: 0.06, topProb: 0.207 };
  expect(describeMove({ san: 'Qh5', quality: blunder, rarity: expected, bestRarity: shiftedBestListed }))
    .toBe('A common blunder.');
  // f3-like Uncommon negative stays grade-specific with no percentage attached.
  const f3like: Rarity = { label: 'Uncommon', r: 0.438, prob: 0.149, topProb: 0.34 };
  expect(describeMove({ san: 'f3', quality: { ...blunder, label: 'Mistake' }, rarity: f3like }))
    .toBe('An uncommon mistake.');
});
it('appends the material note only for Mistake/Blunder', () => {
  const quality = (label: Quality['label']): Quality => ({ label, accuracy: 20, loss: 15 });
  const rarity: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  const note = 'This line wins a pawn for Black.';
  expect(describeMove({ san: 'Qh5', quality: quality('Blunder'), rarity, materialNote: note }))
    .toBe(`A common blunder. ${note}`);
  expect(describeMove({ san: 'd5', quality: quality('Mistake'), rarity, materialNote: note }))
    .toContain(note);
  expect(describeMove({ san: 'd5', quality: quality('Inaccuracy'), rarity, materialNote: note }))
    .not.toContain('This line');
  expect(describeMove({ san: 'fxg3', quality: quality('Allowed mate'), rarity, materialNote: note }))
    .not.toContain('This line');
  expect(describeMove({ san: 'Nf3', quality: quality('Best'), rarity, materialNote: note }))
    .not.toContain('This line');
});
it('appends the positive why only for praise grades', () => {
  const quality = (label: Quality['label']): Quality => ({ label, accuracy: 100, loss: 0 });
  const rarityOf = (label: Rarity['label']): Rarity => ({ label, r: 1, prob: 0.4, topProb: 0.4 });
  const rarity = rarityOf('Expected');
  expect(describeMove({ san: 'exd5', quality: quality('Best'), rarity, positiveNote: 'Wins a pawn.' }))
    .toBe('The natural choice. Wins a pawn.');
  expect(describeMove({ san: 'Nd4', quality: quality('Great'), rarity: rarityOf('Rare'), positiveNote: "Nd4 forks Black's bishop and queen." }))
    .toBe("A rare find. Nd4 forks Black's bishop and queen.");
  expect(describeMove({
    san: 'Kd1', quality: quality('Good'), rarity: rarityOf('Uncommon'), positiveNote: 'Gets out of check.',
  })).toBe('A meaningful minority that holds. Gets out of check.');
  // Novelty still prefixes the synthesis the note appends to.
  expect(describeMove({
    san: 'exd5', quality: quality('Best'), rarity,
    novelty: { priorName: 'Caro-Kann Defense', priorEco: 'B12' }, positiveNote: 'Wins a pawn.',
  })).toBe('Leaves Caro-Kann Defense book. The natural choice. Wins a pawn.');
  // Negative grades, forced moves, and terminals never take the note.
  expect(describeMove({ san: 'exd5', quality: quality('Blunder'), rarity, positiveNote: 'Wins a pawn.' }))
    .toBe('A common blunder.');
  expect(describeMove({ san: 'e4', quality: quality('Forced'), rarity, positiveNote: 'Wins a pawn.' }))
    .toBe('e4 was the only legal move.');
  expect(describeMove({ san: 'Qxf7#', quality: quality('Best'), rarity, terminal: 'checkmate', positiveNote: 'Wins a queen.' }))
    .toBe('Qxf7# delivers checkmate.');
  expect(describeMove({ san: 'Nf3', quality: quality('Best'), rarity, opening: { eco: 'C50', name: 'Italian Game' }, positiveNote: 'Gets out of check.' }))
    .toBe('Nf3 — Italian Game (C50). Book move.');
});
it('appends the mate-parry why only for praise grades', () => {
  const quality = (label: Quality['label']): Quality => ({ label, accuracy: 100, loss: 0 });
  const rarity: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  expect(describeMove({ san: 'g6', quality: quality('Best'), rarity, positiveNote: 'Parries Qxg7#.' }))
    .toBe('The natural choice. Parries Qxg7#.');
  expect(describeMove({ san: 'Re5', quality: quality('Good'), rarity, positiveNote: 'Avoids mate in one.' }))
    .toBe('The natural choice. Avoids mate in one.');
  // A parrying blunder stays a blunder story, never a defensive story.
  expect(describeMove({ san: 'g6', quality: quality('Blunder'), rarity, positiveNote: 'Parries Qxg7#.' }))
    .toBe('A common blunder.');
});
it('pairs hard-to-avoid with the material consequence', () => {
  const blunder: Quality = { label: 'Blunder', accuracy: 20, loss: 25 };
  const expected: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  const absentBest: Rarity = { label: 'Absent', r: null, prob: null, topProb: 0.4 };
  expect(describeMove({
    san: 'Qf3', quality: blunder, rarity: expected, bestRarity: absentBest,
    materialNote: 'This line loses a knight and a pawn for a bishop.',
  })).toBe('Hard to avoid. This line loses a knight and a pawn for a bishop.');
});
it('ranks terminal facts above book names, grades, and theory notes', () => {
  const quality = (label: Quality['label']): Quality => ({ label, accuracy: 20, loss: 15 });
  const rarity: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  const book = { eco: 'C50', name: 'Italian Game' };
  // A mating move that collides with a book hit still reports the mate.
  expect(describeMove({ san: 'Qxf7#', quality: quality('Best'), rarity, opening: book, terminal: 'checkmate', matePatternName: "Scholar's mate" }))
    .toBe("Qxf7# delivers Scholar's mate.");
  expect(describeMove({ san: 'Qxf7#', quality: quality('Best'), rarity, opening: book, terminal: 'checkmate' }))
    .toBe('Qxf7# delivers checkmate.');
  expect(describeMove({ san: 'Kf6', quality: quality('Blunder'), rarity, terminal: 'stalemate', pawnNote: 'Doubles a pawn.' }))
    .toBe('Kf6 allows stalemate.');
  expect(describeMove({ san: 'Rf3+', quality: quality('Good'), rarity, terminal: 'repetition' }))
    .toBe('Rf3+ forces a repetition draw.');
  expect(describeMove({ san: 'g5', quality: quality('Best'), rarity, terminal: 'fifty' })).toBe('g5 brings the fifty-move rule.');
  expect(describeMove({ san: 'Bxc6', quality: quality('Best'), rarity, terminal: 'insufficient' }))
    .toBe('Bxc6 leaves insufficient mating material.');
});
it('reports known draws and pointed underpromotions above the synthesis', () => {
  const quality = (label: Quality['label']): Quality => ({ label, accuracy: 20, loss: 15 });
  const rarity: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  expect(describeMove({ san: 'Nb3', quality: quality('Forced'), rarity, deadDraw: true }))
    .toBe('Nb3 was the only legal move.');
  expect(describeMove({ san: 'Nb3', quality: quality('Blunder'), rarity, deadDraw: true }))
    .toBe('Nb3 — known theoretical draw.');
  expect(describeMove({ san: 'a8=N+', quality: quality('Good'), rarity, underpromotionAvoids: true }))
    .toBe('a8=N+ underpromotes to avoid stalemate.');
});
it('prefixes novelty only on the rarity synthesis, never on overrides or quiet verdicts', () => {
  const quality = (label: Quality['label']): Quality => ({ label, accuracy: 20, loss: 15 });
  const rarity: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  const novelty = { priorName: 'Caro-Kann Defense', priorEco: 'B12' };
  expect(describeMove({ san: 'd5', quality: quality('Mistake'), rarity, novelty }))
    .toBe('Leaves Caro-Kann Defense book. A common mistake.');
  // Overrides carry no prefix; quiet verdicts stay quiet.
  expect(describeMove({ san: 'Qxf7#', quality: quality('Best'), rarity, novelty, terminal: 'checkmate' }))
    .toBe('Qxf7# delivers checkmate.');
  expect(describeMove({ san: 'e4', quality: quality('Forced'), rarity, novelty }))
    .toBe('e4 was the only legal move.');
  expect(describeMove({ san: 'd5', quality: quality('Mistake'), rarity: { label: 'Unknown', r: null, prob: null, topProb: null }, novelty }))
    .toBeNull();
});
it('falls back to the pawn note when the material window is silent', () => {
  const quality = (label: Quality['label']): Quality => ({ label, accuracy: 20, loss: 15 });
  const rarity: Rarity = { label: 'Expected', r: 1, prob: 0.4, topProb: 0.4 };
  expect(describeMove({ san: 'dxe5', quality: quality('Inaccuracy'), rarity, pawnNote: 'Doubles a pawn.' }))
    .toBe('A common inaccuracy. Doubles a pawn.');
  // The concrete best line outranks the positional observation.
  expect(describeMove({ san: 'Qh5', quality: quality('Blunder'), rarity, materialNote: 'This line wins a pawn for Black.', pawnNote: 'Doubles a pawn.' }))
    .toBe('A common blunder. This line wins a pawn for Black.');
  // Praise and allowed mates never take positional notes.
  expect(describeMove({ san: 'Nf3', quality: quality('Good'), rarity, pawnNote: 'Doubles a pawn.' }))
    .toBe('The natural choice.');
  expect(describeMove({ san: 'fxg3', quality: quality('Allowed mate'), rarity, pawnNote: 'Doubles a pawn.' }))
    .toBe('A common move that allows mate.');
});
