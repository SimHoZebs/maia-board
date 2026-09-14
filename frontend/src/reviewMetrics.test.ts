import { expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { classifyLoss, describeMove, isMateFor, maiaRarity, moveAccuracy, reviewMove, SEARCH_POLICY, terminalEvaluation, whiteWin, type Evaluation, type Quality, type Rarity } from './reviewMetrics';
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
it('requires a strong evaluated alternative gap for Great and excludes incomplete pairs', () => {
  const before = evaluation(200); before.lines = [{ move: 'e2e4', score: before.score, depth: 14 }, { move: 'd2d4', score: { type: 'cp', value: 0 }, depth: 14 }];
  expect(reviewMove(before, before, new Chess(), 'e2e4').label).toBe('Great');
  before.lines[1].score = { type: 'mate', value: 3 };
  expect(reviewMove(before, before, new Chess(), 'e2e4').label).toBe('Best');
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
it('flags avoidable mate as Skull with zero accuracy but preserved loss', () => {
  // fxg3-type case: dead lost on cp (~2.5%) but not mated; the played move
  // lets Black force mate while the best move survives. Win% loss alone
  // (< 5) would read Good — Skull must fire first with accuracy 0.
  const before = evaluation(-1000); before.best_move = 'g1f3';
  const after = { ...evaluation(0), score: { type: 'mate' as const, value: -1, winning_side: 'black' as const } };
  const skull = reviewMove(before, after, new Chess(), 'e2e4');
  expect(skull.label).toBe('Skull');
  expect(skull.accuracy).toBe(0);
  expect(skull.loss).toBeGreaterThan(0);
  expect(skull.loss!).toBeLessThan(5);
  // Black-mover mirror: White mates after Black's move, best avoided it.
  const game = new Chess(); game.move('e4');
  const bBefore = evaluation(1000); bBefore.best_move = 'e7e5';
  const bAfter = { ...evaluation(0), score: { type: 'mate' as const, value: 1, winning_side: 'white' as const } };
  expect(reviewMove(bBefore, bAfter, game, 'd7d5').label).toBe('Skull');
  // Winner falls back to mate-value sign when winning_side is absent.
  expect(isMateFor({ type: 'mate', value: -3 }, 'black')).toBe(true);
  expect(isMateFor({ type: 'mate', value: 3 }, 'black')).toBe(false);
  expect(isMateFor({ type: 'cp', value: -1000 }, 'black')).toBe(false);
});
it('never skulls unavoidable or best-played mates, and forced still wins', () => {
  // Mate acceleration (already mated, M5 -> M1) with non-best play: not Skull.
  const mated = { ...evaluation(0), score: { type: 'mate' as const, value: -5, winning_side: 'black' as const }, best_move: 'g1f3' };
  const faster = { ...evaluation(0), score: { type: 'mate' as const, value: -1, winning_side: 'black' as const } };
  expect(reviewMove(mated, faster, new Chess(), 'e2e4').label).not.toBe('Skull');
  // Best move played: never Skull even if the after-position reads as mate.
  const best = evaluation(-1000); best.best_move = 'e2e4';
  const matedAfter = { ...evaluation(0), score: { type: 'mate' as const, value: -1, winning_side: 'black' as const } };
  expect(reviewMove(best, matedAfter, new Chess(), 'e2e4').label).not.toBe('Skull');
  // Single legal move allowing mate stays Forced.
  const forced = new Chess('5Q1k/8/5K2/8/8/8/8/8 b - - 0 1');
  expect(forced.moves()).toHaveLength(1);
  expect(reviewMove(evaluation(-900), matedAfter, forced, 'h8h7').label).toBe('Forced');
});
const maia = (probs: [string, number][], degraded = false) => ({ top_moves: probs.map(([move, prob]) => ({ move, prob })), degraded });
it('carves Miss out of the Blunder band when the win is gone but the position holds', () => {
  // winB ~90 (cp 600), winA 50 (cp 0): loss ~40 sits in the Blunder band,
  // yet the mover is alive at 50: missed opportunity, not damage.
  const before = evaluation(600); before.best_move = 'g1f3';
  expect(reviewMove(before, evaluation(0), new Chess(), 'e2e4').label).toBe('Miss');
  // Self-destructed instead (winA ~2): the Blunder stands.
  expect(reviewMove(before, evaluation(-1000), new Chess(), 'e2e4').label).toBe('Blunder');
  // Still winning afterwards (winA ~90): no miss, just imprecise at most.
  const kept = evaluation(600); kept.best_move = 'g1f3';
  expect(reviewMove(kept, evaluation(600), new Chess(), 'e2e4').label).toBe('Good');
  // No win on the board (winB ~55): ordinary Mistake, never Miss.
  const mid = evaluation(60); mid.best_move = 'g1f3';
  expect(reviewMove(mid, evaluation(-60), new Chess(), 'e2e4').label).toBe('Mistake');
  // Played the win: Best, not Miss.
  expect(reviewMove(before, before, new Chess(), 'g1f3').label).toBe('Best');
});
it('bands Maia rarity by ratio to the top move, not rank or absolute prob', () => {
  // 13% under a 15% top is the same band as the top itself.
  const close = maia([['e2e4', 0.15], ['d2d4', 0.13]]);
  expect(maiaRarity(close, 'e2e4').label).toBe('Expected');
  expect(maiaRarity(close, 'd2d4').label).toBe('Expected');
  // A 12% rank-1 in a wide position is still Expected.
  expect(maiaRarity(maia([['e2e4', 0.12], ['d2d4', 0.05]]), 'e2e4').label).toBe('Expected');
  expect(maiaRarity(maia([['e2e4', 0.4], ['d2d4', 0.15]]), 'd2d4').label).toBe('Seen');
  expect(maiaRarity(maia([['e2e4', 0.4], ['d2d4', 0.05]]), 'd2d4').label).toBe('Unseen');
  expect(maiaRarity(close, 'g1f3').label).toBe('Unseen');
  expect(maiaRarity(maia([]), 'e2e4').label).toBe('Unknown');
  expect(maiaRarity(undefined, 'e2e4').label).toBe('Unknown');
  expect(maiaRarity(maia([['e2e4', 0.5]], true), 'e2e4').label).toBe('Unknown');
});
it('describes the played move in plain English across both axes', () => {
  const quality = (label: Quality['label'], loss: number | null = 0): Quality => ({ label, accuracy: 100, loss });
  const rarity = (label: Rarity['label']): Rarity => ({ label, r: 1, prob: 0.4, topProb: 0.4 });
  expect(describeMove({ san: 'Nf3', quality: quality('Best'), rarity: rarity('Expected'), elo: 1600 }))
    .toBe("Best — Nf3 is the engine's top choice. Maia at 1600 predicts 40% for this move.");
  expect(describeMove({ san: 'Nxh7+', quality: quality('Best'), rarity: rarity('Unseen'), elo: 1600 }))
    .toBe("Best — Nxh7+ is the engine's top choice. Maia at 1600 predicts 40% for this move.");
  expect(describeMove({ san: 'Re8', quality: quality('Great'), rarity: rarity('Unseen'), elo: 1400 }))
    .toBe("Great — Re8 is the engine's top choice with a sizable gap to its next candidate. Maia at 1400 predicts 40% for this move.");
  expect(describeMove({ san: 'Re8', quality: quality('Great'), rarity: rarity('Expected'), elo: 1400 }))
    .toBe("Great — Re8 is the engine's top choice with a sizable gap to its next candidate. Maia at 1400 predicts 40% for this move.");
  expect(describeMove({ san: 'h3', quality: quality('Good'), rarity: rarity('Seen'), elo: 1600 }))
    .toBe("Good — h3 keeps the engine's estimated winning chance close to its best line. Maia at 1600 predicts 40% for this move.");
  expect(describeMove({ san: 'Qh5', quality: quality('Blunder', 25), rarity: rarity('Expected'), elo: 1600 }))
    .toBe('Qh5 was a blunder — it gave up 25% of your estimated winning chance. Maia at 1600 predicts 40% for this move.');
  expect(describeMove({ san: 'Kd2', quality: quality('Miss'), rarity: rarity('Seen'), elo: 1600, bestSan: 'Qxf7#' }))
    .toBe('Kd2 missed the win — Qxf7# kept the winning position.');
  expect(describeMove({ san: 'fxg3', quality: quality('Skull'), rarity: rarity('Expected'), elo: 1600, bestSan: 'Qg5+' }))
    .toBe('fxg3 allowed mate — Qg5+ held the position.');
  expect(describeMove({ san: 'fxg3', quality: quality('Skull'), rarity: rarity('Unseen'), elo: 1600 }))
    .toBe('fxg3 allowed mate.');
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
  expect(absent).toContain("absent from Maia's top choices");
  expect(absent).not.toMatch(/brilliant|only good|impossible|nobody/i);
  expect(describeMove({ san: 'd4', quality, rarity: undefined, elo: 1600 })).not.toContain('1600');
});
