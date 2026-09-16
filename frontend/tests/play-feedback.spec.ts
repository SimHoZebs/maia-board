import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';
import { KEYS } from '../src/storage';
import { stockfishPolicy } from '../src/stockfishSettings';

// Play grades through the foreground Focus lane (single /evaluate per new
// endpoint, single /move for the mover) plus the read-only bulk prime. The
// whole-line server batch is out of this path: any POST /reviews during
// these specs is a regression — fail it on contact.
type Behavior = { evaluateFailuresRemaining: number; evaluateAlwaysFail?: boolean };
type Hits = { reviews: string[]; evaluates: any[]; maiaEvals: any[]; playMoves: any[] };

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

async function bootPlay(page: Page, behavior: Behavior) {
  const errors: string[] = [];
  const hits: Hits = { reviews: [], evaluates: [], maiaEvals: [], playMoves: [] };
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
      // Empty cache: every badge must settle through foreground fetches.
      await route.fulfill({ json: { results: [] } }); return;
    }
    if (path === '/evaluate') {
      const payload = route.request().postDataJSON();
      hits.evaluates.push(payload);
      if (behavior.evaluateAlwaysFail || behavior.evaluateFailuresRemaining > 0) {
        if (!behavior.evaluateAlwaysFail) behavior.evaluateFailuresRemaining--;
        await route.fulfill({ status: 500, json: { code: 'unknown', message: 'boom' } }); return;
      }
      await route.fulfill({ json: sfEvaluation(payload.fen, payload.settings) }); return;
    }
    if (path === '/move') {
      const payload = route.request().postDataJSON();
      // Play replies carry a temperature; foreground Maia evals do not.
      (payload.temperature !== undefined ? hits.playMoves : hits.maiaEvals).push(payload);
      await route.fulfill({ json: maiaEvaluation(payload.fen, payload) }); return;
    }
    if (path.startsWith('/reviews')) {
      hits.reviews.push(`${route.request().method()} ${path}`);
      await route.fulfill({ status: 500, json: { code: 'unknown', message: 'play must not batch' } }); return;
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
  return { errors, hits };
}

async function clickSquare(page: Page, file: number, rank: number) {
  const board = (await page.locator('#board cg-board').boundingBox())!;
  await page.mouse.click(board.x + (board.width * (file + 0.5)) / 8, board.y + (board.height * (8 - rank + 0.5)) / 8);
}

const settledBadges = '.move-cell span.quality:not(.quality-slot):not(.quality-shimmer):not(.quality-placeholder):not(.quality-book)';

async function startAndPlayNf3(page: Page) {
  await page.locator('#start-game').click();
  await expect(page.locator('#board cg-board')).toBeVisible();
  // 1. Nf3 e5 with an empty book, so the knight earns a real engine badge
  // instead of a book chip; black's reply is not ours to judge.
  await clickSquare(page, 6, 1);
  await clickSquare(page, 5, 3);
  await expect(page.locator('.move-cell').first()).toContainText('1. Nf3', { timeout: 15000 });
  await expect(page.locator('.move-cell').nth(1)).toContainText('e5', { timeout: 15000 });
}

test('play feedback badges settle through foreground fetches with no batch', async ({ page }) => {
  const app = await bootPlay(page, { evaluateFailuresRemaining: 0 });
  await startAndPlayNf3(page);
  await expect(page.locator(settledBadges)).toHaveCount(1, { timeout: 20000 });
  // The lookup cache was empty, so that badge could only have settled via
  // foreground /evaluate calls — and play issued no batch traffic.
  expect(app.hits.evaluates.length).toBeGreaterThan(0);
  expect(app.hits.reviews).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('transient evaluate failures retry and still settle without refresh', async ({ page }) => {
  const app = await bootPlay(page, { evaluateFailuresRemaining: 4 });
  await startAndPlayNf3(page);
  // First attempts 500; the capped backoff retry must still land the grade.
  await expect(page.locator(settledBadges)).toHaveCount(1, { timeout: 30000 });
  expect(app.hits.reviews).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('persistent evaluate failures stay bounded and issue no batch', async ({ page }) => {
  const app = await bootPlay(page, { evaluateFailuresRemaining: 0, evaluateAlwaysFail: true });
  await startAndPlayNf3(page);
  // Initial pair fetch plus the capped retries, then silence: no storm, no
  // batch fallback, no page errors.
  await page.waitForTimeout(10000);
  // Initial pair fetches plus the capped sweep retries (at most 3 fires per
  // line over the failed keys), then silence: no storm, no batch fallback.
  expect(app.hits.evaluates.length).toBeLessThanOrEqual(16);
  expect(app.hits.evaluates.length).toBeGreaterThan(0);
  expect(app.hits.reviews).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('foreground maia evals only cover the user mover', async ({ page }) => {
  const app = await bootPlay(page, { evaluateFailuresRemaining: 0 });
  await startAndPlayNf3(page);
  await expect(page.locator(settledBadges)).toHaveCount(1, { timeout: 20000 });
  // Play replies name Maia's color; the user is the other side, and every
  // foreground Maia eval must name the user's side (the mover it translates).
  const userColor = app.hits.playMoves[0].maia_color === 'white' ? 'black' : 'white';
  expect(app.hits.maiaEvals.length).toBeGreaterThan(0);
  for (const payload of app.hits.maiaEvals) expect(payload.maia_color).toBe(userColor);
  expect(app.hits.reviews).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('mid-game settings change re-grades under the new policy', async ({ page }) => {
  const app = await bootPlay(page, { evaluateFailuresRemaining: 0 });
  await startAndPlayNf3(page);
  await expect(page.locator(settledBadges)).toHaveCount(1, { timeout: 20000 });
  await page.locator('#mode-settings').click();
  await page.locator('#stockfish-depth').fill('18');
  await page.locator('#mode-play').click();
  await expect(page.locator('#board cg-board')).toBeVisible();
  // The pair refires under the edited settings; the mock echoes the policy.
  await expect.poll(async () => app.hits.evaluates.filter(payload => payload.settings?.depth === 18).length, { timeout: 20000 }).toBeGreaterThan(0);
  expect(app.hits.reviews).toEqual([]);
  expect(app.errors).toEqual([]);
});
