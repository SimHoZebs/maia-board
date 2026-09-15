import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { replay } from '../src/domain';
import { defaultStockfishSettings, stockfishPolicy } from '../src/stockfishSettings';
const SEARCH_POLICY = stockfishPolicy(defaultStockfishSettings);
import { KEYS } from '../src/storage';
import { EvaluationFixture, evaluationIdentity } from './evaluation-fixture';

async function bootReview(page: Page, pgn = '1. e4 e5 2. Nf3 Nc6', scores = [20,20,200,-700,-680]) {
  const requests: { engine: string; moves: string[]; initial_fen: string; elo_maia?: number }[] = [];
  const cache = new EvaluationFixture();
  const evaluations = cache.entries;
  const errors: string[] = [];
  // Fake review-batch server: accept the submitted items and immediately
  // report a finished job. Actual evaluations still flow through the
  // foreground /move + /evaluate mocks below via the batch prime, so panel
  // content stays computed live exactly as in production.
  const batches = new Map<string, number>();
  let batchSeq = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://maia.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (await cache.lookup(route)) return;
    if (path === '/reviews' && method === 'POST') {
      const body = route.request().postDataJSON();
      const total = Array.isArray(body?.requests) ? body.requests.length : 0;
      const jobId = `mock-batch-${++batchSeq}`;
      batches.set(jobId, total);
      await route.fulfill({ json: { job_id: jobId, total, cached: 0, pending: total } });
      return;
    }
    if (path.startsWith('/reviews/')) {
      const segments = path.slice('/reviews/'.length).split('/');
      const job = batches.get(segments[0]);
      if (job === undefined) { await route.fulfill({ status: 404, body: '' }); return; }
      const progress = { job_id: segments[0], total: job, done: job, failed: 0, cancelled: false, finished: true };
      if (segments[1] === 'events') {
        await route.fulfill({ body: `data: ${JSON.stringify({ progress })}\n\n`, contentType: 'text/event-stream' });
        return;
      }
      if (method === 'DELETE') { await route.fulfill({ status: 204, body: '' }); return; }
      await route.fulfill({ json: progress });
      return;
    }
    if (path === '/move' || path === '/evaluate') {
      const payload = route.request().postDataJSON(); requests.push({ engine: path, ...payload });
      const engine = path === '/move' ? 'maia' : 'sf';
      // Read-through emulation: serve a matching stored row, else compute
      // live and file it, mirroring the backend contract.
      const hit = cache.get(engine, payload);
      if (hit) {
        await route.fulfill({ json: hit.value, headers: { 'X-Eval-Cache': 'hit' } });
        return;
      }
      const game = replay(payload.moves, payload.initial_fen);
      const legal = game.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
      const preferred = ['e2e4', 'e7e5', 'g1f3', 'b8c6'][payload.moves.length];
      const best = legal.includes(preferred) ? preferred : legal[0];
      const score = { type: 'cp', value: scores[payload.moves.length] ?? 0 };
      const value = path === '/move' ? { move: best, top_moves: [{ move: best, prob: .6 }], wdl: [.2,.3,.5], model_used: payload.model, degraded: false } : {
        engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12 + payload.moves.length, terminal: null, best_move: best, score,
        lines: [{ move: best, score, depth: 12 + payload.moves.length }, ...legal.filter(move => move !== best).slice(0, 1).map(move => ({ move, score: { type: 'cp', value: game.turn() === 'w' ? -500 : 500 }, depth: 12 + payload.moves.length }))],
      };
      cache.set(engine, payload, value);
      await route.fulfill({ json: value }); return;
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
  return { requests, errors, evaluations };
}
const lines = (page: Page) => page.locator('#board svg.cg-shapes line');
test('standalone FEN shows current candidates and clears correct-frame previews', async ({ page }) => {
  const app = await bootReview(page);
  const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 23';
  await page.goto(`http://maia.test/analyze?fen=${encodeURIComponent(fen)}`);
  await expect(page.locator('#analysis-index')).toHaveText('Position 1 / 1');
  const maia = page.getByRole('region', { name: 'Maia analysis', exact: true });
  await expect(maia.getByRole('button', { name: 'Explore e4', exact: true })).toBeVisible();
  const candidate = page.getByRole('region', { name: 'Stockfish evaluation', exact: true }).getByRole('button', { name: 'Explore e3', exact: true });
  await expect(page.getByRole('region', { name: 'Stockfish evaluation', exact: true }).getByRole('button').first()).toBeVisible();
  const preview = page.locator('#board svg.cg-shapes line[stroke="#d6b85c"]');
  await candidate.hover();
  await expect(preview).toHaveCount(1);
  await page.locator('.brand').hover();
  await expect(preview).toHaveCount(0);
  await candidate.focus();
  await expect(preview).toHaveCount(1);
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).focus();
  await expect(preview).toHaveCount(0);
  await maia.getByRole('button', { name: 'Explore e4', exact: true }).click();
  await expect(page.locator('.move-cell')).toContainText('23. e4');
  await expect(maia.getByRole('button', { name: 'Explore e4 (played) from before this move', exact: true })).toBeVisible();
  await maia.getByRole('button').first().hover();
  await expect(preview).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test('root identifies requested and actual fallback models', async ({ page }) => {
  const app = await bootReview(page);
  await page.route('http://maia.test/move', route => {
    const body = route.request().postDataJSON();
    const move = replay(body.moves, body.initial_fen).moves({ verbose: true })[0];
    const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
    return route.fulfill({ json: { move: uci, top_moves: [{ move: uci, prob: .13 }], wdl: [.2,.3,.5], model_used: '5m', degraded: true } });
  });
  await page.goto('http://maia.test/analyze?moves=');
  await expect(page.getByRole('heading', { name: 'Maia 5m • 1600', exact: true })).toBeVisible();
  await expect(page.getByText('Requested 79m; using 5m fallback.', { exact: true })).toBeVisible();
  expect(app.errors).toEqual([]);
});

test('adjacent backward navigation animates and loaded positions start settled', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await bootReview(page);
  await expect(page.locator('#board piece.anim')).toHaveCount(0);
  const animated = await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('#analysis-prev')!.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return document.querySelectorAll('#board piece.anim').length;
  });
  expect(animated).toBeGreaterThan(0);
  await expect(page.locator('#board piece.anim')).toHaveCount(0);
  await page.goto('http://maia.test/analyze?moves=d2d4,d7d5');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await expect(page.locator('#board piece.anim')).toHaveCount(0);
});
async function atStart(page: Page) {
  await page.locator('#analysis-first').click();
  await expect(lines(page)).toHaveCount(3);
}
test('automatic review shows real overlapping SVG arrows', async ({ page }, info) => {
  const app = await bootReview(page); await atStart(page);
  const strokes = async () => lines(page).evaluateAll(elements => elements.map(el => ({ color: el.getAttribute('stroke'), opacity: el.getAttribute('opacity'), width: el.getAttribute('stroke-width'), from: [el.getAttribute('x1'), el.getAttribute('y1')], to: [el.getAttribute('x2'), el.getAttribute('y2')] })));
  const arrows = await strokes();
  expect(arrows.map(arrow => arrow.color)).toEqual(['#ffffff','#ef4444','#3b82f6']);
  expect(arrows.map(arrow => arrow.width)).toEqual(['0.1875','0.125','0.0625']);
  expect(arrows.map(arrow => arrow.opacity)).toEqual(['0.45','0.45','0.45']);
  expect(arrows.every(arrow => JSON.stringify(arrow.from) === JSON.stringify(arrows[0].from) && JSON.stringify(arrow.to) === JSON.stringify(arrows[0].to))).toBe(true);
  await expect(lines(page)).toHaveCount(3);
  // Analysis board is fixed white-side up (no flip button).
  await expect(page.locator('#flip-board')).toHaveCount(0);
  await expect(page.locator('#board .cg-wrap')).toHaveClass(/orientation-white/);
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
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
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
    for (const tab of ['Move analysis', 'Moves to review']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const sections = await page.locator('.insight-panel > .analysis-section:visible').evaluateAll(elements => elements.map(el => {
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        return { top: rect.top, bottom: rect.bottom, border: parseFloat(style.borderTopWidth), contentTop: el.firstElementChild!.getBoundingClientRect().top };
      }));
      expect(sections).toHaveLength(3);
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

test('move analysis summarizes the game below the engines and links mistakes from moves to review', async ({ page }, info) => {
  const app = await bootReview(page);
  await expect(page.getByRole('heading', { name: 'Stockfish 19 · depth 15' })).toBeVisible();
  await expect(page.getByRole('tabpanel', { name: 'Move analysis', exact: true })).toBeVisible();
  await expect(page.locator('.overview-partial')).toContainText('Summary covers reviewed moves only');
  await expect(page.getByRole('region', { name: 'White accuracy', exact: true }).locator('.accuracy-value')).toHaveText('—');
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.locator('.review-coverage')).toHaveCount(0);
  await expect(page.locator('.overview-partial')).toHaveCount(0);
  await expect(page.locator('.accuracy-caption')).toHaveText(['Accuracy', 'Accuracy']);
  await expect(page.locator('.accuracy-summary')).not.toContainText('You');
  await page.getByRole('tab', { name: 'Moves to review', exact: true }).click();
  await expect(page.locator('.review-issue')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('overview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review 2. Nf3 · White · Blunder', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('#insight-content').getByRole('button', { name: 'Explore Nf3 (played) from before this move', exact: true })).toBeVisible();
  await expect(page.locator('.balance-score')).toHaveText('-7.00');
  expect(app.errors).toEqual([]);
});

test('tabs support keyboard navigation without stepping the board and link inaccuracies on mobile', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const app = await bootReview(page, '1. e4 e5 2. Nf3 Nc6', [0,0,100,0,0]);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  const before = app.requests.length;
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Moves to review', exact: true })).toBeFocused();
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  await expect(page.locator('.review-issue')).toHaveCount(2);
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Moves to review', exact: true })).toBeFocused();
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  expect(app.requests).toHaveLength(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('overview-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review 1… e5 · Black · Inaccuracy', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Move analysis', exact: true })).toBeVisible();
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('#insight-content').getByRole('button', { name: 'Explore e5 (played) from before this move', exact: true })).toBeVisible();
  expect(app.errors).toEqual([]);
});

test('moves to review distinguishes empty games, no issues, and explored lines', async ({ page }) => {
  await bootReview(page, '1. e4 e5', [0,0,0]);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Moves to review', exact: true }).click();
  await expect(page.getByText('No inaccuracies, mistakes, blunders, or allowed mates found.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).click();
  const board = (await page.locator('#board cg-board').boundingBox())!;
  await page.mouse.click(board.x + board.width * 3.5 / 8, board.y + board.height * 6.5 / 8);
  await page.mouse.click(board.x + board.width * 3.5 / 8, board.y + board.height * 4.5 / 8);
  await page.getByRole('tab', { name: 'Moves to review', exact: true }).click();
  await expect(page.locator('.tab-action').getByRole('button', { name: 'Analyze explored line' })).toBeVisible();
  // No return button: step back to the fork, then Next continues original.
  await page.locator('#analysis-prev').click();
  await page.locator('#analysis-next').click();
  await expect(page.getByLabel('Explored variation', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Game overview' })).toBeVisible();
  await page.getByRole('tab', { name: 'Moves to review', exact: true }).click();
  await expect(page.getByText('No inaccuracies, mistakes, blunders, or allowed mates found.', { exact: true })).toBeVisible();
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-pgn').fill('1. d4');
  await page.locator('#load-analysis').click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-controls').getByRole('button', { name: 'Starting position', exact: true }).click();
  await page.locator('#load-analysis').click();
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).click();
  await expect(page.getByText('Play or load some moves to see an accuracy summary.', { exact: true })).toBeVisible();
  await expect(page.locator('.accuracy-value')).toHaveCount(0);
});

for (const width of [1440, 360]) test(`move analysis restores accuracy and evaluation graphs at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const app = await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
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
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('.review-charts')).toHaveCount(1);
  await expect(page.locator('.chart-point[aria-current="step"]')).toHaveAccessibleName(/2\. Nf3/);
  await page.getByRole('tab', { name: 'Move accuracy', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Evaluation', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Evaluation graph', exact: true })).toBeVisible();
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('.chart-line')).toHaveCount(4);
  await expect(page.locator('.chart-point').nth(4)).toHaveAccessibleName(/2… Nc6 · Black.*White winning chance.*-6\.80/);
  await page.locator('.chart-point').nth(4).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  await expect(page.locator('.balance-score')).toHaveText('-6.80');
  await expect(page.locator('.chart-point[aria-current="step"]')).toHaveAccessibleName(/2… Nc6/);
  expect(app.errors).toEqual([]);
});

test('move analysis graphs leave unreviewed positions as gaps', async ({ page }) => {
  await bootReview(page);
  await expect(page.getByRole('heading', { name: 'Stockfish 19 · depth 15' })).toBeVisible();
  await expect(page.locator('.chart-point i')).toHaveCount(1);
  await expect(page.locator('.chart-line')).toHaveCount(0);
  await expect(page.locator('.chart-point').nth(2).locator('i')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Evaluation', exact: true }).click();
  await expect(page.locator('.chart-point i')).toHaveCount(2);
  await expect(page.locator('.chart-line')).toHaveCount(1);
  await expect(page.locator('.chart-point').nth(2).locator('i')).toHaveCount(0);
});

test('move analysis shows only your moves with your decision points on the graphs', async ({ page }) => {
  const app = await bootReview(page);
  await page.evaluate(key => {
    const snapshot = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...snapshot, ownGame: true, perspective: 'black' }));
  }, KEYS.snapshot);
  await page.reload();
  await expect(page.locator('.accuracy-card')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Black accuracy', exact: true })).toContainText('Black · You');
  await expect(page.getByRole('region', { name: 'White accuracy', exact: true })).toHaveCount(0);
  await expect(page.locator('.accuracy-caption')).toHaveText('Partial accuracy');
  await expect(page.locator('.chart-point i')).toHaveCount(1);
  await expect(page.locator('.chart-point:disabled')).toHaveCount(0);
  await expect(page.locator('.chart-line')).toHaveCount(0);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await expect(page.locator('.accuracy-caption')).toHaveText('Accuracy');
  await page.getByRole('tab', { name: 'Moves to review', exact: true }).click();
  await expect(page.locator('.review-issue')).toHaveCount(1);
  await expect(page.locator('.issue-move small')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review 1… e5 · Black · You · Mistake', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('.chart-point i')).toHaveCount(2);
  await expect(page.locator('.chart-line')).toHaveCount(1);
  expect(await page.locator('.chart-point span').allTextContents()).toEqual(['1…', '2…']);
  await page.getByRole('tab', { name: 'Evaluation', exact: true }).click();
  await expect(page.locator('.chart-point i')).toHaveCount(2);
  await expect(page.locator('.chart-line')).toHaveCount(1);
  expect(await page.locator('.chart-point span').allTextContents()).toEqual(['1…', '2…']);
  await expect(page.locator('.chart-point:disabled')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Black accuracy', exact: true })).toContainText('Black · You');
  expect(app.errors).toEqual([]);
});

test('analysis tabs stay visible while panel content scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  const tabs = page.getByRole('tablist', { name: 'Game analysis views', exact: true });
  const before = await tabs.boundingBox();
  await page.locator('#analysis-panel-moves').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => page.locator('#analysis-panel-moves').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await tabs.boundingBox()).toEqual(before);
  await expect(tabs).toBeInViewport();
});

test('unlisted played moves have no fallback below either prediction list', async ({ page }) => {
  await bootReview(page, '1. d4 d5');
  // Step to the position after the played move: the panel judges d4 from its
  // before-position, where the top predictions genuinely exclude it.
  await page.locator('#analysis-first').click();
  await page.locator('#analysis-next').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 3');
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
  await expect(page.getByRole('heading', { name: 'Stockfish 19 · depth 15' })).toBeVisible();
  // Both engines at the before/current pair must finish before reloading.
  // Three rows can leave current-position Maia uncached and legitimately
  // trigger the fourth request after reload.
  await expect.poll(() => app.evaluations.size).toBe(4);
  const calls = app.requests.length;
  await page.reload();
  // The loaded line restores from the snapshot with the import panel closed;
  // cached positions resolve without new inference.
  await expect(page.getByRole('heading', { name: 'Stockfish 19 · depth 15' })).toBeVisible();
  await expect(page.locator('.candidate-list li')).not.toHaveCount(0);
  expect(app.requests).toHaveLength(calls);
  expect(app.errors).toEqual([]);
});
test('completed analysis restores automatically across reload without inference', async ({ page }) => {
  const app = await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  const inferred = () => app.requests.filter(request => request.engine === '/move' || request.engine === '/evaluate').length;
  const before = inferred();
  expect(before).toBeGreaterThan(0);
  await page.reload();
  // No click: the fresh record primes itself from the server eval cache.
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await expect(page.locator('.candidate-list li').first()).toBeVisible();
  expect(inferred()).toBe(before);
});
test('partially evicted analysis restores cached positions and gates the rest', async ({ page }) => {
  const app = await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  // Evict every Maia row server-side: Stockfish stays cached.
  const evicted = [...app.evaluations].filter(([, entry]) => entry.engine === 'maia').map(([hash]) => hash);
  expect(evicted.length).toBeGreaterThan(0);
  for (const hash of evicted) app.evaluations.delete(hash);
  const inferred = (engine: string) => app.requests.filter(request => request.engine === engine).length;
  const evalsBefore = inferred('/evaluate');
  const reloadMark = app.requests.length;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Analyze entire game' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /of \d+ positions cached/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  // Every evicted Maia position re-infers at least once; Stockfish never does.
  // Set membership instead of exact counts: the insight single and the
  // foreground may legitimately re-request the viewed position alongside the
  // batch, so duplicates are allowed but omissions are not.
  const reRequested = new Set(
    app.requests.slice(reloadMark)
      .filter(request => request.engine === '/move')
      .map(request => evaluationIdentity('maia', request)),
  );
  expect(evicted.every(hash => reRequested.has(hash))).toBe(true);
  expect(inferred('/evaluate') - evalsBefore).toBe(0);
});
test('changed analysis settings gate the missing positions behind a new batch', async ({ page }) => {
  await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await expect(page.locator('#analysis-rating')).toBeVisible();
  await page.locator('#analysis-rating').selectOption('1800');
  await expect(page.getByRole('button', { name: 'Analyze entire game' })).toBeVisible();
  // No parallel record layer remains: completion derives from cached rows, so
  // no record banner can appear for the previous settings.
  await expect(page.locator('.analysis-record')).toHaveCount(0);
});
test('mixed arrow sources retain their own endpoints', async ({ page }, info) => {
  await bootReview(page);
  await page.route('http://maia.test/move', route => route.fulfill({ json: { move: 'g1f3', top_moves: [{ move: 'g1f3', prob: .6 }], wdl: [.2,.3,.5], model_used: '79m', degraded: false } }));
  await page.route('http://maia.test/evaluate', route => route.fulfill({ json: { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'd2d4', score: { type: 'cp', value: 20 }, lines: [{ move: 'd2d4', score: { type: 'cp', value: 20 }, depth: 12 }, { move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 }] } }));
  await atStart(page);
  const endpoints = await lines(page).evaluateAll(elements => elements.map(el => `${el.getAttribute('x1')},${el.getAttribute('y1')}:${el.getAttribute('x2')},${el.getAttribute('y2')}`));
  expect(new Set(endpoints).size).toBe(3);
  // Arrows project forward from the viewed position, but the panel judges the
  // displayed move from its before-position: step forward to read predictions.
  await page.locator('#analysis-next').click();
  await expect(page.getByRole('heading', { name: 'Maia 79m • 1600', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Stockfish' })).toBeVisible();
  await expect(page.locator('.insight-panel')).toContainText('Nf3');
  await expect(page.locator('.insight-panel')).toContainText('d4');
  await page.locator('.insight-panel').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('mixed-arrows.png'), fullPage: true });
});
test('current position balance replaces the win-rate sections', async ({ page }) => {
  await bootReview(page);
  await expect(page.locator('.balance-score')).toHaveText('-6.80');
  // The accuracy/evaluation graphs live in Move analysis now, so the section
  // renders before any review — connected lines appear only once reviewed
  // positions settle (dot coverage is asserted in the gaps test below).
  await expect(page.locator('.win-hero')).toHaveCount(0);
  await expect(page.locator('.chart-line')).toHaveCount(0);
  await expect(page.getByText('Unreviewed', { exact: false })).toHaveCount(0);
  await expect(page.locator('[title*="Unreviewed"], [aria-label*="Unreviewed"], .quality-unreviewed')).toHaveCount(0);
});
test('analysis progress replaces the analyze button while running without a cancel option', async ({ page }) => {
  await bootReview(page);
  await expect(page.getByRole('heading', { name: 'Stockfish 19 · depth 15' })).toBeVisible();
  const held: Route[] = [];
  await page.route('http://maia.test/move', route => { held.push(route); });
  await page.route('http://maia.test/evaluate', route => { held.push(route); });
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect.poll(() => held.length).toBe(2);
  await expect(page.getByRole('button', { name: 'Analyze entire game' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel analysis' })).toHaveCount(0);
  await expect(page.locator('.tab-action').getByRole('status')).toHaveText(/Analyzing \d+ of \d+…/);
  await page.unroute('http://maia.test/move');
  await page.unroute('http://maia.test/evaluate');
  for (const route of held) await route.fulfill({ json: route.request().url().endsWith('/move') ? { move: 'e2e4', top_moves: [{ move: 'e2e4', prob: .6 }], wdl: [.2,.3,.5], model_used: '79m', degraded: false } : { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'e2e4', score: { type: 'cp', value: 20 }, lines: [{ move: 'e2e4', score: { type: 'cp', value: 20 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: 0 }, depth: 12 }] } });
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await expect(page.locator('.tab-action').getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel analysis' })).toHaveCount(0);
});
for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 360, height: 800 }, { width: 390, height: 844 }]) {
  test(`review geometry, arrows and balance ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport); await bootReview(page); await atStart(page);
    await page.getByRole('button', { name: 'Analyze entire game' }).click();
    await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.insight-panel')!.scrollTop = 0; });
    const box = (await page.locator('#board').boundingBox())!;
    expect(box.width).toBeGreaterThan(300); expect(box.width).toBeCloseTo(box.height, 0);
    for (const rect of await page.locator('.player-strip, .move-navigation, .board-actions').evaluateAll(elements => elements.map(el => { const rect = el.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; }))) {
      expect(rect.top).toBeGreaterThanOrEqual(0); expect(rect.bottom).toBeLessThanOrEqual(viewport.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const row = await page.locator('.analysis-tabs [role="tab"], .tab-action button').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    expect(Math.max(...row.map(r => r.top))).toBeLessThan(Math.min(...row.map(r => r.bottom)));
    const bar = (await page.locator('.balance-track').boundingBox())!;
    expect(bar.height).toBeGreaterThan(bar.width * 5);
    const squares = (await page.locator('#board cg-board').boundingBox())!;
    expect(bar.x).toBeCloseTo(squares.x + squares.width, 0);
    expect(bar.y).toBeCloseTo(squares.y, 0);
    expect(bar.height).toBeCloseTo(squares.height, 0);
    const white = (await page.locator('.balance-white').boundingBox())!;
    expect(white.y + white.height).toBeCloseTo(bar.y + bar.height, 0);
    // Analysis board is fixed white-side up (no flip button).
    await expect(page.locator('#flip-board')).toHaveCount(0);
    await expect(page.locator('#board .cg-wrap')).toHaveClass(/orientation-white/);
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
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
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
