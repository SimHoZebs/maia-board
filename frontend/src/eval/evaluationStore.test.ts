import { describe, expect, it } from 'vitest';
import { buildTimeline, START_FEN } from '../shared/domain';
import { ceilElo } from '../board/BoardTools';
import {
  evaluationRequest,
  reviewKey,
  reviewNodes,
  settingsHash,
  splitValueElos,
} from './evaluationStore';

describe('analysis Elo bucketing', () => {
  it('ceils Elos up to the next hundred', () => {
    expect(ceilElo(800)).toBe(800);
    expect(ceilElo(801)).toBe(900);
    expect(ceilElo(1512)).toBe(1600);
    expect(ceilElo(1675)).toBe(1700);
    expect(ceilElo(1700)).toBe(1700);
    expect(ceilElo(2400)).toBe(2400);
  });
  it('buckets settings hashes so nearby strengths share keys', () => {
    const base = { botElo: 1675, userElo: 1512, model: '79m' as const };
    const neighbor = { botElo: 1699, userElo: 1599, model: '79m' as const };
    const ceiling = { botElo: 1700, userElo: 1600, model: '79m' as const };
    expect(settingsHash('maia', base)).toBe(settingsHash('maia', neighbor));
    expect(settingsHash('maia', base)).toBe(settingsHash('maia', ceiling));
  });
  it('sends bucketed Elos on the bulk wire', () => {
    const nodes = reviewNodes(buildTimeline(START_FEN, ['e2e4']));
    const req = evaluationRequest('maia', nodes[1], {
      botElo: 1675,
      userElo: 1512,
      model: '79m',
    });
    expect(req).toMatchObject({ elo_maia: 1700, elo_user: 1600 });
  });
  it('buckets split value Elos too', () => {
    expect(
      splitValueElos({
        botElo: 800,
        userElo: 800,
        valueBotElo: 1512,
        valueUserElo: 1512,
        model: '79m',
      }),
    ).toEqual({ valueBotElo: 1600, valueUserElo: 1600 });
  });
  it('keeps the grading 2400 identity exact and deduped', () => {
    const nodes = reviewNodes(buildTimeline(START_FEN, ['e2e4']));
    const plain = { botElo: 2400, userElo: 2400, model: '79m' as const };
    const split = { ...plain, valueBotElo: 2400, valueUserElo: 2400 };
    const req = evaluationRequest('maia', nodes[1], plain);
    expect(req).toMatchObject({ elo_maia: 2400, elo_user: 2400 });
    expect(req).not.toHaveProperty('value_elo_maia');
    expect(reviewKey('maia', nodes[1], plain)).toBe(reviewKey('maia', nodes[1], split));
  });
});
