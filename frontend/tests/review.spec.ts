import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { replay, START_FEN } from '../src/domain';
import { defaultStockfishSettings, stockfishPolicy } from '../src/stockfishSettings';
const SEARCH_POLICY = stockfishPolicy(defaultStockfishSettings);
import { KEYS } from '../src/storage';
import { lineHash, recordSettings } from '../src/analysisRecords';

async function bootReview(page: Page, pgn = '1. e4 e5 2. Nf3 Nc6', scores = [20,20,200,-700,-680]) {
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
      const score = { type: 'cp', value: scores[payload.moves.length] ?? 0 };
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
test('whole game completes independently of viewing and updates the position balance', async ({ page }, info) => {
  const app = await bootReview(page);
  await expect(page.locator('.balance-score')).toHaveText('-6.80');
  await expect(page.locator('.review-charts, .win-hero')).toHaveCount(0);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await page.locator('#analysis-first').click();
  await expect(page.getByRole('status').filter({ hasText: '10 / 10 analysis jobs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  await expect(page.locator('.move-cell .quality-great')).toHaveCount(2);
  await expect(page.locator('.move-cell .quality-mistake')).toHaveCount(1);
  await expect(page.locator('.move-cell .quality-blunder')).toHaveCount(1);
  await page.locator('.move-cell').nth(2).click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('.balance-score')).toHaveText('-7.00');
  await expect(page.locator('.balance-track')).toHaveAccessibleName(/estimated White winning chance 7%/);
  await page.locator('.insight-panel').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('completed-review.png'), fullPage: true });
  expect(app.errors).toEqual([]);
  expect(app.requests.filter(request => request.engine === '/evaluate')).toHaveLength(5);
});
for (const width of [320, 1440]) {
  test(`analysis container spaces both sides of section dividers at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await bootReview(page);
    for (const tab of ['Move analysis', 'Overview']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const sections = await page.locator('.insight-panel > .analysis-section:visible').evaluateAll(elements => elements.map(el => {
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        return { top: rect.top, bottom: rect.bottom, border: parseFloat(style.borderTopWidth), contentTop: el.firstElementChild!.getBoundingClientRect().top };
      }));
      expect(sections).toHaveLength(4);
      for (let index = 1; index < sections.length; index++) {
        expect(sections[index].border).toBe(1);
        expect(sections[index].top - sections[index - 1].bottom).toBeCloseTo(12, 0);
        expect(sections[index].contentTop - sections[index].top - sections[index].border).toBeCloseTo(12, 0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`analysis-spacing-${width}-${tab.replace(' ', '-')}.png`), fullPage: true });
    }
  });
}

test('overview summarizes the game and opens the decision before a selected mistake', async ({ page }, info) => {
  const app = await bootReview(page);
  await expect(page.getByRole('heading', { name: 'Stockfish 19 · depth 16' })).toBeVisible();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Overview', exact: true })).toBeVisible();
  await expect(page.locator('.engine-duo')).toHaveCount(0);
  await expect(page.locator('.overview-partial')).toContainText('Summary covers reviewed moves only');
  await expect(page.getByRole('region', { name: 'White accuracy', exact: true }).locator('.accuracy-value')).toHaveText('—');
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.locator('.review-coverage')).toHaveCount(0);
  await expect(page.locator('.overview-partial')).toHaveCount(0);
  await expect(page.locator('.accuracy-caption')).toHaveText(['Accuracy', 'Accuracy']);
  await expect(page.locator('.accuracy-coverage')).toHaveCount(0);
  await expect(page.locator('.review-issue')).toHaveCount(2);
  await expect(page.locator('.accuracy-summary')).not.toContainText('You');
  await page.screenshot({ path: info.outputPath('overview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review 2. Nf3 · White · Blunder', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('#insight-content').getByRole('button', { name: 'Preview Nf3 (played)', exact: true })).toBeVisible();
  await expect(page.locator('.balance-score')).toHaveText('+2.00');
  expect(app.errors).toEqual([]);
});

test('overview supports keyboard tabs without stepping the board and links inaccuracies on mobile', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const app = await bootReview(page, '1. e4 e5 2. Nf3 Nc6', [0,0,100,0,0]);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  const before = app.requests.length;
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeFocused();
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  await expect(page.locator('.review-issue')).toHaveCount(2);
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeFocused();
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  expect(app.requests).toHaveLength(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('overview-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review 1… e5 · Black · Inaccuracy', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Move analysis', exact: true })).toBeVisible();
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 5');
  await expect(page.locator('#insight-content').getByRole('button', { name: 'Preview e5 (played)', exact: true })).toBeVisible();
  expect(app.errors).toEqual([]);
});

test('overview distinguishes empty games, no issues, and explored lines', async ({ page }) => {
  await bootReview(page, '1. e4 e5', [0,0,0]);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByText('No inaccuracies, mistakes, misses, or blunders found.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).click();
  const board = (await page.locator('#board cg-board').boundingBox())!;
  await page.mouse.click(board.x + board.width * 3.5 / 8, board.y + board.height * 6.5 / 8);
  await page.mouse.click(board.x + board.width * 3.5 / 8, board.y + board.height * 4.5 / 8);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Explored line overview', exact: true })).toBeVisible();
  await page.locator('#return-original').click();
  await expect(page.getByRole('heading', { name: 'Game overview', exact: true })).toBeVisible();
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-pgn').fill('1. d4');
  await page.locator('#load-analysis').click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-controls').getByRole('button', { name: 'Starting position', exact: true }).click();
  await page.locator('#load-analysis').click();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByText('Play or load some moves to see an accuracy summary.', { exact: true })).toBeVisible();
  await expect(page.locator('.accuracy-value')).toHaveCount(0);
});

for (const width of [1440, 360]) test(`overview restores accuracy and evaluation graphs at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const app = await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Move accuracy graph', exact: true })).toBeVisible();
  await expect(page.locator('.chart-line')).toHaveCount(3);
  await expect(page.locator('.chart-point').first()).toBeDisabled();
  await expect(page.locator('.chart-dot-mistake')).toHaveCount(1);
  await expect(page.locator('.chart-dot-blunder')).toHaveCount(1);
  await expect(page.locator('.chart-point').nth(3)).toHaveAccessibleName(/2\. Nf3 · White.*move accuracy.*Blunder/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`overview-graphs-${width}.png`), fullPage: true });
  await page.locator('.chart-point').nth(3).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('#insight-content').getByRole('button', { name: 'Preview Nf3 (played)', exact: true })).toBeVisible();
  await expect(page.locator('.review-charts')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.chart-point[aria-current="step"]')).toHaveAccessibleName(/2\. Nf3/);
  await page.getByRole('tab', { name: 'Move accuracy', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Evaluation', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Evaluation graph', exact: true })).toBeVisible();
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('.chart-line')).toHaveCount(4);
  await expect(page.locator('.chart-point').nth(4)).toHaveAccessibleName(/2… Nc6 · Black.*White winning chance.*-6\.80/);
  await page.locator('.chart-point').nth(4).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  await expect(page.locator('.balance-score')).toHaveText('-6.80');
  expect(app.errors).toEqual([]);
});

test('overview graphs leave unreviewed positions as gaps', async ({ page }) => {
  await bootReview(page);
  await expect(page.getByRole('heading', { name: 'Stockfish 19 · depth 16' })).toBeVisible();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.chart-point i')).toHaveCount(1);
  await expect(page.locator('.chart-line')).toHaveCount(0);
  await expect(page.locator('.chart-point').nth(2).locator('i')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Evaluation', exact: true }).click();
  await expect(page.locator('.chart-point i')).toHaveCount(2);
  await expect(page.locator('.chart-line')).toHaveCount(1);
  await expect(page.locator('.chart-point').nth(2).locator('i')).toHaveCount(0);
});

test('overview shows only your moves with your decision points on the graphs', async ({ page }) => {
  const app = await bootReview(page);
  await page.evaluate(key => {
    const snapshot = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...snapshot, ownGame: true, perspective: 'black' }));
  }, KEYS.snapshot);
  await page.reload();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.accuracy-card')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Black accuracy', exact: true })).toContainText('Black · You');
  await expect(page.getByRole('region', { name: 'White accuracy', exact: true })).toHaveCount(0);
  await expect(page.locator('.accuracy-caption')).toHaveText('Partial accuracy');
  await expect(page.locator('.review-issue')).toHaveCount(0);
  await expect(page.locator('.chart-point i')).toHaveCount(1);
  await expect(page.locator('.chart-point:disabled')).toHaveCount(3);
  await expect(page.locator('.chart-line')).toHaveCount(0);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  await expect(page.locator('.accuracy-caption')).toHaveText('Accuracy');
  await expect(page.locator('.review-issue')).toHaveCount(1);
  await expect(page.locator('.issue-move small')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review 1… e5 · Black · You · Mistake', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 5');
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await expect(page.locator('.chart-point i')).toHaveCount(2);
  await expect(page.locator('.chart-line')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Evaluation', exact: true }).click();
  await expect(page.locator('.chart-point i')).toHaveCount(2);
  await expect(page.locator('.chart-line')).toHaveCount(0);
  await expect(page.locator('.chart-point:disabled')).toHaveCount(3);
  await page.locator('#flip-board').click();
  await expect(page.getByRole('region', { name: 'Black accuracy', exact: true })).toContainText('Black · You');
  expect(app.errors).toEqual([]);
});

test('analysis tabs stay visible while panel content scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  const tabs = page.getByRole('tablist', { name: 'Game analysis views', exact: true });
  const before = await tabs.boundingBox();
  await page.locator('#analysis-panel-overview').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => page.locator('#analysis-panel-overview').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await tabs.boundingBox()).toEqual(before);
  await expect(tabs).toBeInViewport();
});

test('unlisted played moves have no fallback below either prediction list', async ({ page }) => {
  await bootReview(page, '1. d4 d5');
  await page.locator('#analysis-first').click();
  await expect(page.locator('#insight-content .candidate-list')).toContainText('e4');
  await expect(page.locator('section[aria-label="Stockfish evaluation"] .candidate-list')).toContainText('e4');
  await expect(page.locator('.engine-duo')).not.toContainText('Played d4');
  await expect(page.locator('.engine-duo .candidate-list')).not.toContainText(['d4', 'd4']);
});

test('checkmate fills the bar for the winning side', async ({ page }) => {
  await bootReview(page, '1. f3 e5 2. g4 Qh4#');
  await expect(page.locator('.balance-track')).toHaveAccessibleName('Black wins · estimated White winning chance 0%');
  await expect(page.locator('.balance-white')).toHaveCSS('height', '0px');
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
  await expect(page.getByRole('heading', { name: 'Stockfish 19 · depth 16' })).toBeVisible();
  await expect.poll(() => app.evaluations.size).toBeGreaterThanOrEqual(3);
  const calls = app.requests.length;
  await page.reload();
  // The loaded line restores from the snapshot with the import panel closed;
  // cached positions resolve without new inference.
  await expect(page.getByRole('heading', { name: 'Stockfish 19 · depth 16' })).toBeVisible();
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
  await expect(page.locator('#analysis-rating')).toBeVisible();
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
    settings: recordSettings({ eloMaia: 1600, eloUser: 1600, model: '79m', stockfish: defaultStockfishSettings }),
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
  await expect(page.getByRole('heading', { name: 'Maia • 1600', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stockfish' })).toBeVisible();
  await expect(page.locator('.insight-panel')).toContainText('Nf3');
  await expect(page.locator('.insight-panel')).toContainText('d4');
  await page.locator('.insight-panel').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('mixed-arrows.png'), fullPage: true });
});
test('current position balance replaces the win-rate sections', async ({ page }) => {
  await bootReview(page);
  await expect(page.locator('.balance-score')).toHaveText('-6.80');
  await expect(page.locator('.review-charts, .win-hero')).toHaveCount(0);
  await expect(page.getByText('Unreviewed', { exact: false })).toHaveCount(0);
  await expect(page.locator('[title*="Unreviewed"], [aria-label*="Unreviewed"], .quality-unreviewed')).toHaveCount(0);
});
test('cancel stops lazy batch scheduling while retaining completed position results', async ({ page }) => {
  await bootReview(page);
  await expect(page.getByRole('heading', { name: 'Stockfish 19 · depth 16' })).toBeVisible();
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
  test(`review geometry, arrows and balance ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
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
    const row = await page.locator('.analysis-record p, .analysis-record button, .generation-settings').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    expect(Math.max(...row.map(r => r.top))).toBeLessThan(Math.min(...row.map(r => r.bottom)));
    const bar = (await page.locator('.balance-track').boundingBox())!;
    expect(bar.height).toBeGreaterThan(bar.width * 5);
    const squares = (await page.locator('#board cg-board').boundingBox())!;
    expect(bar.x).toBeCloseTo(squares.x + squares.width, 0);
    expect(bar.y).toBeCloseTo(squares.y, 0);
    expect(bar.height).toBeCloseTo(squares.height, 0);
    const white = (await page.locator('.balance-white').boundingBox())!;
    expect(white.y + white.height).toBeCloseTo(bar.y + bar.height, 0);
    await page.locator('#flip-board').click();
    const flipped = (await page.locator('.balance-white').boundingBox())!;
    expect(flipped.y).toBeCloseTo(bar.y, 0);
    expect(flipped.height).toBeCloseTo(white.height, 0);
    await page.locator('#flip-board').click();
    await page.screenshot({ path: info.outputPath(`review-${viewport.width}.png`), fullPage: true });
  });
}
test('evaluation bar follows rendered board dimensions on resize and fractional pixel density', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1103, height: 857 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage();
  await bootReview(page);
  for (const viewport of [{ width: 1103, height: 857 }, { width: 393, height: 851 }, { width: 1281, height: 901 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const board = (await page.locator('#board cg-board').boundingBox())!;
      const bar = (await page.locator('.balance-track').boundingBox())!;
      return Math.max(Math.abs(bar.x - board.x - board.width), Math.abs(bar.y - board.y), Math.abs(bar.height - board.height));
    }).toBeLessThan(.1);
  }
  await context.close();
});

test('terminal repetition skips Maia and keeps the local draw result', async ({ page }) => {
  const app = await bootReview(page, '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8');
  await expect(page.locator('.balance-track')).toHaveAccessibleName('Draw · estimated White winning chance 50%');
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Cancel analysis' })).toHaveCount(0);
  expect(app.requests.some(request => request.moves.length === 8)).toBe(false);
});
test('touch move selection updates the position balance', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).tap();
  await expect(page.getByRole('status').filter({ hasText: '10 / 10 analysis jobs' })).toBeVisible();
  await page.locator('.move-cell').nth(0).tap();
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 5');
  await page.locator('.move-cell').nth(1).tap();
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
