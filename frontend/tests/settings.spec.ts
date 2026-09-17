import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { replay } from '../src/domain';
import { stockfishPolicy } from '../src/stockfishSettings';
import { EvaluationFixture } from './evaluation-fixture';

for (const width of [360, 1440]) test(`engine settings and Play temperature at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const requests: { path: string; body: any }[] = [];
  const errors: string[] = [];
  let current: any = null;
  const cache = new EvaluationFixture();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://maia.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/games') {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        requests.push({ path, body });
        current = { ...body, updated_at: '2026-09-11T00:00:00Z' };
        await route.fulfill({ json: current });
      } else await route.fulfill({ json: { games: current ? [current] : [], current_id: current?.id ?? null, total: current ? 1 : 0 } });
      return;
    }
    if (await cache.lookup(route)) return;
    if (path === '/move' || path === '/evaluate') {
      const body = route.request().postDataJSON();
      requests.push({ path, body });
      const game = replay(body.moves, body.initial_fen);
      const moves = game.moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
      const score = { type: 'cp', value: 20 };
      await route.fulfill({ json: path === '/move' ? { move: moves[0], top_moves: [{ move: moves[0], prob: .5 }], wdl: [.2, .3, .5], model_used: body.model, degraded: false } : {
        engine: 'Stockfish 19', search_policy: stockfishPolicy(body.settings), depth: 12, terminal: null, best_move: moves[0], score,
        lines: moves.slice(0, body.settings.lines).map(move => ({ move, score, depth: 12 })),
      } });
      return;
    }
    const file = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    await route.fulfill({ body: await readFile(resolve('dist-browser', file)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://maia.test/play');
  // Header tabs hide on phones (the bottom-bar menu owns navigation there),
  // so navigate whichever way the current viewport offers.
  const gotoMode = async (mode: string) => {
    if (await page.locator(`#mode-${mode}`).isVisible()) await page.locator(`#mode-${mode}`).click();
    else { await page.locator('#mobile-menu').click(); await page.locator(`#mobile-mode-${mode}`).click(); }
  };
  await page.getByText('Advanced', { exact: true }).click();
  await page.locator('#maia-temperature').fill('0.7');
  await page.getByRole('radio', { name: 'Black', exact: true }).check();
  await page.screenshot({ path: info.outputPath('play-advanced.png') });
  await page.locator('#start-game').click();
  await expect.poll(() => requests.some(r => r.path === '/move' && r.body.temperature === .7)).toBe(true);
  await expect.poll(() => current?.moves.length).toBe(1);
  expect(current.temperature).toBe(.7);
  const gameId = current.id;
  const moveCount = requests.filter(r => r.path === '/move').length;
  await gotoMode('settings');
  await expect(page.getByRole('heading', { name: 'Stockfish', exact: true })).toBeVisible();
  await expect(page.locator('#maia-temperature')).toHaveCount(0);
  await expect(page.locator('#board')).toHaveCount(0);
  await page.locator('#stockfish-time').fill('');
  await page.locator('#stockfish-time').pressSequentially('0.75');
  await expect(page.locator('#stockfish-time')).toHaveValue('0.75');
  await page.locator('#stockfish-depth').focus();
  await expect(page.locator('#stockfish-time')).toHaveValue('0.75');
  await page.locator('#stockfish-time').fill('2');
  await expect(page.locator('#stockfish-time-cap')).toHaveValue('2');
  await page.locator('.segmented label', { hasText: '5' }).click();
  await expect(page.getByRole('radio', { name: '5', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Stop after time' })).toBeChecked();
  await expect(page.locator('#stockfish-depth')).toHaveValue('0');
  await page.locator('#stockfish-depth').fill('12');
  await expect(page.getByRole('radio', { name: 'Reach depth' })).toBeChecked();
  await page.locator('#stockfish-depth').fill('18');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Reach depth' })).toBeChecked();
  await expect(page.locator('#stockfish-time')).toHaveValue('2');
  await expect(page.getByRole('radio', { name: '5', exact: true })).toBeChecked();
  await expect(page.locator('#stockfish-depth')).toHaveValue('18');
  await expect(page.locator('#stockfish-time-cap')).toHaveValue('2');
  // Board orientation defaults to auto and persists the fixed side.
  await expect(page.getByRole('radio', { name: 'Auto', exact: true })).toBeChecked();
  await page.locator('div[role="radiogroup"][aria-labelledby="board-orientation-label"] label', { hasText: 'Black' }).click();
  await expect(page.getByRole('radio', { name: 'Black', exact: true })).toBeChecked();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Black', exact: true })).toBeChecked();
  await page.locator('div[role="radiogroup"][aria-labelledby="board-orientation-label"] label', { hasText: 'Auto' }).click();
  await expect(page.getByRole('radio', { name: 'Auto', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Stop after time' }).check();
  await expect(page.locator('#stockfish-depth')).toHaveValue('0');
  await page.getByRole('radio', { name: 'Reach depth' }).check();
  await expect(page.locator('#stockfish-depth')).toHaveValue('18');
  expect(requests.filter(r => r.path === '/move')).toHaveLength(moveCount);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('stockfish-settings.png') });
  await gotoMode('play');
  await expect(page.locator('#new-game')).toBeVisible();
  expect(current.id).toBe(gameId);
  expect(current.temperature).toBe(.7);
  await gotoMode('analysis');
  await page.getByRole('button', { name: 'Starting position', exact: true }).click();
  await page.locator('#load-analysis').click();
  await expect.poll(() => requests.some(r => r.path === '/evaluate')).toBe(true);
  const sf = requests.find(r => r.path === '/evaluate')!;
  expect(sf.body.settings).toEqual({ time_ms: 2000, lines: 5, depth: 18 });
  await expect.poll(() => requests.filter(r => r.path === '/move').length).toBeGreaterThan(moveCount);
  expect(requests.filter(r => r.path === '/move').at(-1)!.body).not.toHaveProperty('temperature');
  await expect(page.getByText('Stockfish returned an incomplete evaluation.')).toHaveCount(0);
  expect(errors).toEqual([]);
});
