import { expect, it } from 'vitest';
import { buildTimeline, START_FEN } from './domain';
import { reviewNodes, type ReviewSettings } from './evaluationStore';
import { selectMaiaDisplay } from './maiaDisplay';
import { maiaFixture } from './evaluationTestFixtures';

const settings: ReviewSettings = { eloMaia: 1600, eloUser: 1600, model: '79m' };
const nodes = reviewNodes(buildTimeline(START_FEN, ['e2e4']));
it('retains only the same position while displaying the old Elo/model honestly', () => {
  const old = selectMaiaDisplay(nodes[0], settings, maiaFixture(START_FEN), null);
  const pending = selectMaiaDisplay(nodes[0], { ...settings, eloMaia: 2000 }, undefined, old.entry!, true);
  expect(pending).toMatchObject({ stale: true, pending: true, entry: { eloMaia: 1600 } });
  expect(selectMaiaDisplay(nodes[1], settings, undefined, old.entry!).entry).toBeUndefined();
  const branch = reviewNodes(buildTimeline(START_FEN, ['d2d4']));
  const after = selectMaiaDisplay(nodes[1], settings, maiaFixture(nodes[1].fen), null);
  expect(selectMaiaDisplay(branch[1], settings, undefined, after.entry!).entry).toBeUndefined();
});
it('fallback identity is actual model while freshness still belongs to the requested key', () => {
  const fallback = maiaFixture(START_FEN, '5m', true);
  const shown = selectMaiaDisplay(nodes[0], settings, fallback, null);
  expect(shown).toMatchObject({ stale: false, pending: false, entry: { result: { model_used: '5m', degraded: true } } });
  const settled = selectMaiaDisplay(nodes[0], { ...settings, eloMaia: 2000 }, maiaFixture(START_FEN), shown.entry!);
  expect(settled).toMatchObject({ stale: false, pending: false, entry: { eloMaia: 2000, result: { model_used: '79m', degraded: false } } });
});
