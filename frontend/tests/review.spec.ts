import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { replay, START_FEN } from '../src/domain';
import { SEARCH_POLICY } from '../src/reviewMetrics';
import { KEYS } from '../src/storage';
import { lineHash, recordSettings } from '../src/analysisRecords';

async function bootReview(page: Page, pgn = '1. e4 e5 2. Nf3 Nc6') {
  const requests: { engine: string; moves: string[]; initial_fen: string; elo_maia?: number }[] = [];
  const evaluations = new Map<string, { engine: string; value: unknown }>();
  const analyses: { line: string; settings: unknown; positions: number; failed: number }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://maia.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/evaluations/')) {
      const hash = path.slice('/evaluations/'.length);
      if (route.request().method() === 'PUT') {
        const put = route.request().postDataJSON();
        evaluations.set(hash, { engine: put.engine, value: put.value });
        await route.fulfill({ json: { key_hash: hash, engine: put.engine, created_at: 'now' } });
        return;
      }
      const hit = evaluations.get(hash);
      if (hit) await route.fulfill({ json: { key_hash: hash, engine: hit.engine, value: hit.value, created_at: 'now' } });
      else await route.fulfill({ status: 404, json: { code: 'not_found', message: 'missing' } });
      return;
    }
    if (path === '/move' || path === '/evaluate') {
      const payload = route.request().postDataJSON(); requests.push({ engine: path, ...payload });
      const game = replay(payload.moves, payload.initial_fen);
      const legal = game.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
      const preferred = ['e2e4', 'e7e5', 'g1f3', 'b8c6'][payload.moves.length];
      const best = legal.includes(preferred) ? preferred : legal[0];
      const score = { type: 'cp', value: [20,20,200,-700,-680][payload.moves.length] ?? 0 };
      await route.fulfill({ json: path === '/move' ? { move: best, top_moves: [{ move: best, prob: .6 }], wdl: [.2,.3,.5], model_used: payload.model, degraded: false } : {
        engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12 + payload.moves.length, terminal: null, best_move: best, score,
        lines: [{ move: best, score, depth: 12 }, { move: legal.find(move => move !== best), score: { type: 'cp', value: game.turn() === 'w' ? -500 : 500 }, depth: 12 }],
      } }); return;
    }
    if (path === '/analyses' || path.startsWith('/analyses/')) {
      const url = new URL(route.request().url());
      if (route.request().method() === 'PUT') {
        const put = route.request().postDataJSON();
        analyses.push({ line: path.slice('/analyses/'.length), settings: put.settings, positions: put.positions, failed: put.failed });
        await route.fulfill({ json: { line_hash: path.slice('/analyses/'.length), settings: put.settings, positions: put.positions, failed: put.failed, completed_at: '2026-09-11T00:00:00Z' } });
        return;
      }
      const wanted = path === '/analyses' ? url.searchParams.getAll('line') : [path.slice('/analyses/'.length)];
      await route.fulfill({ json: { analyses: analyses.filter(entry => wanted.includes(entry.line)).map(entry => ({ line_hash: entry.line, settings: entry.settings, positions: entry.positions, failed: entry.failed, completed_at: '2026-09-11T00:00:00Z' })) } });
      return;
    }
    if (path === '/games' || path.startsWith('/games/')) {
      const method = route.request().method();
      if (method === 'GET' && path === '/games') { await route.fulfill({ json: { games: [], current_id: null, total: 0 } }); return; }
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        await route.fulfill({ json: { id: body.id ?? 'mock-game', created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z', user_color: body.user_color, elo_maia: body.elo_maia, elo_user: body.elo_user, model: body.model, moves: body.moves } });
        return;
      }
      await route.fulfill({ status: 204, body: '' }); return;
    }
    const filename = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    await route.fulfill({ body: await readFile(resolve('dist-browser', filename)), contentType: filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://maia.test/analyze');
  await page.locator('#analysis-pgn').fill(pgn); await page.locator('#load-analysis').click();
  return { requests, errors, evaluations, analyses };
}
const lines = (page: Page) => page.locator('#board svg.cg-shapes line');
async function atStart(page: Page) {
  await page.locator('#analysis-first').click();
  await expect(lines(page)).toHaveCount(3);
}
test('automatic review shows real overlapping SVG arrows and orientation', async ({ page }, info) => {
  const app = await bootReview(page); await atStart(page);
  const strokes = async () => lines(page).evaluateAll(elements => elements.map(el => ({ color: el.getAttribute('stroke'), opacity: el.getAttribute('opacity'), width: el.getAttribute('stroke-width'), from: [el.getAttribute('x1'), el.getAttribute('y1')], to: [el.getAttribute('x2'), el.getAttribute('y2')] })));
  const arrows = await strokes();
  expect(arrows.map(arrow => arrow.color)).toEqual(['#ffffff','#ef4444','#3b82f6']);
  expect(arrows.map(arrow => arrow.width)).toEqual(['0.1875','0.125','0.0625']);
  expect(arrows.map(arrow => arrow.opacity)).toEqual(['0.45','0.45','0.45']);
  expect(arrows.every(arrow => JSON.stringify(arrow.from) === JSON.stringify(arrows[0].from) && JSON.stringify(arrow.to) === JSON.stringify(arrows[0].to))).toBe(true);
  await expect(lines(page)).toHaveCount(3);
  await page.locator('#flip-board').click();
  expect(Number((await strokes())[0].from[0])).toBe(-Number(arrows[0].from[0]));
  await page.locator('#flip-board').click();
  await page.locator('.insight-panel').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('coincident-arrows.png'), fullPage: true });
  expect(app.errors).toEqual([]);
  expect(app.requests.filter(request => request.engine === '/move' && request.moves.length === 0)).toHaveLength(1);
});
test('whole game completes independently of viewing, renders quality and clickable gap-aware graphs', async ({ page }, info) => {
  const app = await bootReview(page);
  await expect(page.locator('.selected-quality')).toContainText('Nc6');
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await page.locator('#analysis-first').click();
  await expect(page.getByRole('status').filter({ hasText: '10 / 10 analysis jobs' })).toBeVisible();
  await expect(page.locator('.accuracy-summary')).toContainText('2 / 2 reviewed');
  await expect(page.locator('.accuracy-summary > div')).toHaveCount(1);
  await expect(page.locator('.move-cell .quality-great')).toHaveCount(2);
  await expect(page.locator('.move-cell .quality-mistake')).toHaveCount(1);
  await expect(page.locator('.move-cell .quality-blunder')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Move accuracy' }).click();
  await page.getByRole('button', { name: /^3\. Nf3 ·/ }).click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('.selected-quality')).toContainText('Blunder');
  await expect(page.locator('.selected-evaluation')).toContainText('depth 15');
  await page.getByRole('tab', { name: 'Evaluation', exact: true }).click();
  await expect(page.locator('.chart-line')).toHaveCount(4);
  await page.locator('.insight-panel').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('completed-review.png'), fullPage: true });
  expect(app.errors).toEqual([]);
  expect(app.requests.filter(request => request.engine === '/evaluate')).toHaveLength(5);
});
test('blunder and mistake destinations carry board badges', async ({ page }) => {
  await bootReview(page);
  await page.locator('#analysis-first').click();
  await page.locator('#analysis-next').click();
  await page.locator('#analysis-next').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('#board').getByText('?', { exact: true })).toBeVisible();
  await page.locator('#analysis-next').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('#board').getByText('??', { exact: true })).toBeVisible();
});
test('server-cached positions skip inference after reload', async ({ page }) => {
  const app = await bootReview(page);
  await expect(page.locator('.selected-evaluation')).toContainText('depth 16');
  await expect.poll(() => app.evaluations.size).toBeGreaterThanOrEqual(3);
  const calls = app.requests.length;
  await page.reload();
  // The loaded line restores from the snapshot with the import panel closed;
  // cached positions resolve without new inference.
  await expect(page.locator('.selected-evaluation')).toContainText('depth 16');
  await expect(page.locator('.candidate-list li')).not.toHaveCount(0);
  expect(app.requests).toHaveLength(calls);
  expect(app.errors).toEqual([]);
});
test('completed analysis restores automatically across reload without inference', async ({ page }) => {
  const app = await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('status').filter({ hasText: '10 / 10 analysis jobs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  expect(app.analyses).toHaveLength(1);
  const inferred = () => app.requests.filter(request => request.engine === '/move' || request.engine === '/evaluate').length;
  const before = inferred();
  expect(before).toBeGreaterThan(0);
  await page.reload();
  // No click: the fresh record primes itself from the server eval cache.
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  await expect(page.locator('.candidate-list li').first()).toBeVisible();
  expect(inferred()).toBe(before);
  expect(app.analyses).toHaveLength(1);
});
test('partially evicted analysis restores cached positions and gates the rest', async ({ page }) => {
  const app = await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('status').filter({ hasText: '10 / 10 analysis jobs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  // Evict every Maia row server-side: Stockfish stays cached.
  for (const [hash, entry] of app.evaluations) if (entry.engine === 'maia') app.evaluations.delete(hash);
  const inferred = (engine: string) => app.requests.filter(request => request.engine === engine).length;
  const movesBefore = inferred('/move'), evalsBefore = inferred('/evaluate');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Restore remaining' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /of \d+ positions cached/ })).toBeVisible();
  await page.getByRole('button', { name: 'Restore remaining' }).click();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  // Exactly the five evicted Maia positions re-infer; Stockfish never does.
  expect(inferred('/move') - movesBefore).toBe(5);
  expect(inferred('/evaluate') - evalsBefore).toBe(0);
});
test('changed analysis settings mark the completed record stale', async ({ page }) => {
  const app = await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('status').filter({ hasText: '10 / 10 analysis jobs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  expect(app.analyses).toHaveLength(1);
  await page.getByText('Analysis settings', { exact: true }).click();
  await page.locator('#analysis-rating').selectOption('1800');
  await expect(page.getByRole('button', { name: 'Analyze entire game' })).toBeVisible();
  await expect(page.locator('.analysis-record')).toContainText('Last analyzed');
});
test('history rows show analyzed status from stored records', async ({ page }) => {
  const moves = ['e2e4', 'e7e5'];
  await bootReview(page);
  await page.route(url => url.pathname === '/games', route => route.fulfill({ json: { games: [{ id: 'g1',
    created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z', user_color: 'white',
    elo_maia: 1600, elo_user: 1600, model: '79m', moves }], current_id: null, total: 1 } }));
  await page.route(url => url.pathname === '/analyses', route => route.fulfill({ json: { analyses: [{
    line_hash: lineHash(START_FEN, moves),
    settings: recordSettings({ eloMaia: 1600, eloUser: 1600, model: '79m' }),
    positions: 3, failed: 0, completed_at: '2026-09-11T00:00:00Z' }] } }));
  await page.goto('http://maia.test/history');
  await expect(page.locator('.saved-game')).toContainText('Analyzed');
});
test('mixed arrow sources retain their own endpoints', async ({ page }, info) => {
  await bootReview(page);
  await page.route('http://maia.test/move', route => route.fulfill({ json: { move: 'g1f3', top_moves: [{ move: 'g1f3', prob: .6 }], wdl: [.2,.3,.5], model_used: '79m', degraded: false } }));
  await page.route('http://maia.test/evaluate', route => route.fulfill({ json: { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'd2d4', score: { type: 'cp', value: 20 }, lines: [{ move: 'd2d4', score: { type: 'cp', value: 20 }, depth: 12 }, { move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 }] } }));
  await atStart(page);
  const endpoints = await lines(page).evaluateAll(elements => elements.map(el => `${el.getAttribute('x1')},${el.getAttribute('y1')}:${el.getAttribute('x2')},${el.getAttribute('y2')}`));
  expect(new Set(endpoints).size).toBe(3);
  await expect(page.getByRole('heading', { name: /Human moves/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stockfish' })).toBeVisible();
  await expect(page.locator('.insight-panel')).toContainText('Nf3');
  await expect(page.locator('.insight-panel')).toContainText('d4');
  await page.locator('.insight-panel').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('mixed-arrows.png'), fullPage: true });
});
test('current and predecessor alone leave earlier chart points missing', async ({ page }) => {
  await bootReview(page);
  await expect(page.locator('.selected-evaluation')).toContainText('depth 16');
  await expect(page.locator('.chart-line')).toHaveCount(1);
  await expect(page.locator('.chart-point').first()).toHaveAccessibleName(/Unreviewed/);
  await expect(page.locator('.chart-point').first().locator('i')).toHaveCount(0);
  await expect(page.locator('.accuracy-summary')).toContainText('0 / 2 reviewed');
});
test('cancel stops lazy batch scheduling while retaining completed position results', async ({ page }) => {
  await bootReview(page);
  await expect(page.locator('.selected-evaluation')).toContainText('depth 16');
  await expect(page.locator('#insight-content')).toHaveCount(1);
  const held: Route[] = [];
  await page.route('http://maia.test/move', route => { held.push(route); });
  await page.route('http://maia.test/evaluate', route => { held.push(route); });
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect.poll(() => held.length).toBe(2);
  await expect(page.getByRole('button', { name: 'Analyze entire game' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel analysis' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'canceled' })).toBeVisible();
  for (const route of held) await route.fulfill({ json: route.request().url().endsWith('/move') ? { move: 'e2e4', top_moves: [{ move: 'e2e4', prob: .6 }], wdl: [.2,.3,.5], model_used: '79m', degraded: false } : { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'e2e4', score: { type: 'cp', value: 20 }, lines: [{ move: 'e2e4', score: { type: 'cp', value: 20 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: 0 }, depth: 12 }] } });
  await page.locator('#analysis-first').click();
  await expect(lines(page)).toHaveCount(3);
  expect(held).toHaveLength(2);
  await expect(page.getByRole('status').filter({ hasText: 'canceled' })).toBeVisible();
});
for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 360, height: 800 }, { width: 390, height: 844 }]) {
  test(`review geometry, arrows and graphs ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport); await bootReview(page); await atStart(page);
    await page.getByRole('button', { name: 'Analyze entire game' }).click();
    await expect(page.getByRole('status').filter({ hasText: '10 / 10 analysis jobs' })).toBeVisible();
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.insight-panel')!.scrollTop = 0; });
    const box = (await page.locator('#board').boundingBox())!;
    expect(box.width).toBeGreaterThan(300); expect(box.width).toBeCloseTo(box.height, 0);
    for (const rect of await page.locator('.player-strip, .move-navigation, .board-actions').evaluateAll(elements => elements.map(el => { const rect = el.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; }))) {
      expect(rect.top).toBeGreaterThanOrEqual(0); expect(rect.bottom).toBeLessThanOrEqual(viewport.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const size of await page.locator('.chart-point, .chart-tabs button').evaluateAll(elements => elements.map(el => { const rect = el.getBoundingClientRect(); return [rect.width, rect.height]; }))) { expect(size[0]).toBeGreaterThanOrEqual(44); expect(size[1]).toBeGreaterThanOrEqual(44); }
    await page.screenshot({ path: info.outputPath(`review-${viewport.width}.png`), fullPage: true });
  });
}
test('terminal repetition skips Maia and keeps the local draw result', async ({ page }) => {
  const app = await bootReview(page, '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8');
  await expect(page.locator('.selected-evaluation')).toContainText('terminal result');
  await expect(page.locator('.selected-evaluation')).toContainText('50.0%');
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Cancel analysis' })).toHaveCount(0);
  expect(app.requests.some(request => request.moves.length === 8)).toBe(false);
});
test('touch graph selection preserves position', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).tap();
  await expect(page.getByRole('status').filter({ hasText: '10 / 10 analysis jobs' })).toBeVisible();
  await page.locator('.chart-point').nth(1).tap();
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 5');
  await page.locator('.chart-point').nth(2).tap();
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('#board svg.cg-shapes line')).toHaveCount(3);
  await context.close();
});
for (const bit of [0, 1]) test(`random side resolves once with crypto bit ${bit}`, async ({ page }) => {
  await page.addInitScript(bit => { let calls = 0; crypto.getRandomValues = ((array: Uint32Array) => { calls++; array[0] = bit; (window as any).randomSideCalls = calls; return array; }) as typeof crypto.getRandomValues; }, bit);
  await bootReview(page); await page.locator('#mode-play').click();
  await page.getByRole('radio', { name: 'Random' }).check();
  await page.locator('#start-game').click();
  await expect(page.locator('#board .cg-wrap')).toHaveClass(new RegExp(`orientation-${bit ? 'black' : 'white'}`));
  await page.locator('#new-game').click(); await page.getByRole('radio', { name: 'Random' }).check();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).randomSideCalls)).toBe(1);
  await expect.poll(() => page.evaluate(key => {
    const raw = localStorage.getItem(key);
    const settings = raw ? JSON.parse(raw) : null;
    return typeof settings?.userColor === 'string' ? settings.userColor : null;
  }, KEYS.settings)).toBe(bit ? 'black' : 'white');
});
