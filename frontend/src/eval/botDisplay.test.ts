import { expect, it } from 'vitest';
import { buildTimeline, START_FEN } from '../shared/domain';
import { reviewNodes, type ReviewSettings } from './evaluationStore';
import { selectBotDisplay } from './botDisplay';
import { botFixture } from './evaluationTestFixtures';

const settings: ReviewSettings = { botElo: 1600, userElo: 1600, model: '79m' };
const nodes = reviewNodes(buildTimeline(START_FEN, ['e2e4']));
it('retains only the same position while displaying the old Elo/model honestly', () => {
  const old = selectBotDisplay(nodes[0], settings, botFixture(START_FEN), null);
  const pending = selectBotDisplay(nodes[0], { ...settings, botElo: 2000 }, undefined, old.entry!, true);
  expect(pending).toMatchObject({ stale: true, pending: true, entry: { botElo: 1600 } });
  expect(selectBotDisplay(nodes[1], settings, undefined, old.entry!).entry).toBeUndefined();
  const branch = reviewNodes(buildTimeline(START_FEN, ['d2d4']));
  const after = selectBotDisplay(nodes[1], settings, botFixture(nodes[1].fen), null);
  expect(selectBotDisplay(branch[1], settings, undefined, after.entry!).entry).toBeUndefined();
});
it('fallback identity is actual model while freshness still belongs to the requested key', () => {
  const fallback = botFixture(START_FEN, '5m', true);
  const shown = selectBotDisplay(nodes[0], settings, fallback, null);
  expect(shown).toMatchObject({ stale: false, pending: false, entry: { result: { model_used: '5m', degraded: true } } });
  const settled = selectBotDisplay(nodes[0], { ...settings, botElo: 2000 }, botFixture(START_FEN), shown.entry!);
  expect(settled).toMatchObject({ stale: false, pending: false, entry: { botElo: 2000, result: { model_used: '79m', degraded: false } } });
});
