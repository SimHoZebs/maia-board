import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';
import { KEYS } from '../src/storage';
import { stockfishPolicy } from '../src/stockfishSettings';

// Regression: the auto-start batch effect depended on the `start` callback,
// which closed over the inline `engines` array — a new identity every render.
// With play feedback on, every render resubmitted the batch (start() ->
// setProgress -> render -> ...), crashing the board with React error #185.
// `start` must stay referentially stable across renders.
function sfEvaluation(fen: string, settings: any) {
  const policy = stockfishPolicy(settings);
  const game = new Chess(fen);
  const legal = game.moves({ verbose: true }).slice(0, 2).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
  const score = { type: 'cp', value: 20 };
  return { engine: 'Stockfish 19', search_policy: policy, depth: 12, terminal: null, best_move: legal[0] ?? null, score, lines: legal.map(move => ({ move, score, depth: 12 })) };
}

function maiaEvaluation(fen: string, payload: any) {
  const game = new Chess(fen);
  const legal = game.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
  const preferred = payload.maia_color === 'black' && legal.includes('e7e5') ? 'e7e5' : legal[0];
  return { move: preferred, top_moves: [{ move: preferred, prob: 0.6 }], wdl: [0.2, 0.3, 0.5], model_used: payload.model ?? '79m', degraded: false };
}

async function bootPlay(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ feedbackKey }) => {
    localStorage.setItem(feedbackKey, JSON.stringify(true));
    const originalFetch = window.fetch;
    window.fetch = (input, init) => originalFetch(input, { ...init, signal: undefined });
  }, { feedbackKey: KEYS.feedback });
  await page.route('http://n/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/openings') {
      const moves = route.request().postDataJSON()?.moves;
      await route.fulfill({ json: { matches: [], book_flags: Array.isArray(moves) ? moves.map(() => false) : [] } }); return;
    }
    if (path === '/evaluations/lookup') {
      const { requests } = route.request().postDataJSON();
      // Read-through emulation: compute what the batch asked for, like the
      // backend would, so priming actually settles rows.
      const results = requests.map((body: any, index: number) => ({
        index,
        value: body.engine === 'sf' ? sfEvaluation(body.fen, body.settings) : maiaEvaluation(body.fen, body),
      }));
      await route.fulfill({ json: { results } }); return;
    }
    if (path === '/evaluate') {
      const payload = route.request().postDataJSON();
      await route.fulfill({ json: sfEvaluation(payload.fen, payload.settings) }); return;
    }
    if (path === '/move') {
      const payload = route.request().postDataJSON();
      await route.fulfill({ json: maiaEvaluation(payload.fen, payload) }); return;
    }
    if (path === '/reviews' && route.request().method() === 'POST') {
      const { requests } = route.request().postDataJSON();
      await route.fulfill({ json: { job_id: 'j9', total: requests.length, cached: 0, pending: requests.length } }); return;
    }
    if (path === '/reviews/j9') {
      await route.fulfill({ json: { job_id: 'j9', total: 0, done: 0, failed: 0, cancelled: false, finished: true } }); return;
    }
    if (path === '/reviews/j9/events') {
      await route.fulfill({ status: 500, body: '' }); return;
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
  await page.goto('http://n/play');
  return { errors };
}

async function clickSquare(page: Page, file: number, rank: number) {
  const board = (await page.locator('#board cg-board').boundingBox())!;
  await page.mouse.click(board.x + (board.width * (file + 0.5)) / 8, board.y + (board.height * (8 - rank + 0.5)) / 8);
}

test('play feedback badges settle without an update-depth crash', async ({ page }) => {
  const app = await bootPlay(page);
  await page.locator('#start-game').click();
  await expect(page.locator('#board cg-board')).toBeVisible();
  // The loop used to crash here already: starting with feedback on
  // resubmitted the batch on every render. Survival is the assertion.
  await page.waitForTimeout(2000);
  await expect(page.locator('#board cg-board')).toBeVisible();
  // 1. Nf3 e5 2. Ng1 with an empty book, so the knight dance earns real
  // engine badges instead of book chips: both white moves settle.
  await clickSquare(page, 6, 1);
  await clickSquare(page, 5, 3);
  await expect(page.locator('.move-cell').first()).toContainText('1. Nf3', { timeout: 15000 });
  await expect(page.locator('.move-cell').nth(1)).toContainText('e5', { timeout: 15000 });
  await clickSquare(page, 5, 3);
  await clickSquare(page, 6, 1);
  await expect(page.locator('.move-cell').nth(2)).toContainText('2. Ng1', { timeout: 15000 });
  // Settled engine badges: not the loading reel, shimmer, placeholder, or
  // book chip. Both white moves grade (black's reply is not ours to judge).
  await expect(page.locator('.move-cell span.quality:not(.quality-slot):not(.quality-shimmer):not(.quality-placeholder):not(.quality-book)')).toHaveCount(2, { timeout: 20000 });
  expect(app.errors.filter(message => /185|Maximum update depth/.test(message))).toEqual([]);
});
