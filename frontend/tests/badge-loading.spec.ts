import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { replay } from '../src/domain';
import { defaultStockfishSettings, stockfishPolicy } from '../src/stockfishSettings';
const SEARCH_POLICY = stockfishPolicy(defaultStockfishSettings);

// History-game load: saved evaluations arrive over the network (prime) with
// no batch running. Pending badges must animate during the restore and go
// quiet once it lands.
async function bootHistory(page: Page, pgn: string, primeMs: number) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://maia.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/evaluations/coverage') {
      // Slow empty cache: the restore is genuinely in flight.
      await new Promise(resolve => setTimeout(resolve, primeMs));
      await route.fulfill({ json: { rows: {} } });
      return;
    }
    if (path.startsWith('/evaluations/')) {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ json: { key_hash: 'x', engine: 'sf', created_at: 'now' } });
        return;
      }
      // Slow empty cache: the restore is genuinely in flight.
      await new Promise(resolve => setTimeout(resolve, primeMs));
      await route.fulfill({ status: 404, json: { code: 'not_found', message: 'missing' } });
      return;
    }
    if (path === '/evaluate') {
      const payload = route.request().postDataJSON();
      const game = replay(payload.moves, payload.initial_fen);
      const legal = game.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
      const best = legal[0];
      const score = { type: 'cp', value: 20 };
      await route.fulfill({ json: {
        engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: best, score,
        lines: [{ move: best, score, depth: 12 }, { move: legal[1] ?? best, score: { type: 'cp', value: 0 }, depth: 12 }],
      } });
      return;
    }
    if (path === '/move') {
      const payload = route.request().postDataJSON();
      const game = replay(payload.moves, payload.initial_fen);
      const best = game.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`)[0];
      await route.fulfill({ json: { move: best, top_moves: [{ move: best, prob: .6 }], wdl: [.2,.3,.5], model_used: payload.model, degraded: false } });
      return;
    }
    if (path === '/games' || path.startsWith('/games/')) {
      if (route.request().method() === 'GET' && path === '/games') { await route.fulfill({ json: { games: [], current_id: null, total: 0 } }); return; }
      await route.fulfill({ status: 204, body: '' }); return;
    }
    const filename = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    await route.fulfill({ body: await readFile(resolve('dist-browser', filename)), contentType: filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.goto('http://maia.test/analyze');
  await page.locator('#analysis-pgn').fill(pgn);
  await page.locator('#load-analysis').click();
  return { errors };
}

test('badges animate while saved evaluations restore, then go quiet', async ({ page }, info) => {
  const app = await bootHistory(page, '1. e4 e5 2. Nf3 Nc6', 1500);
  // Restore in flight, no batch: all four moves pending at once.
  await expect(page.locator('.move-cell .quality-slot')).toHaveCount(4, { timeout: 10000 });
  await page.screenshot({ path: info.outputPath('prime-running.png') });
  // Empty restore and still no batch: nothing incoming, badges blank.
  await expect(page.locator('.move-cell .quality-slot')).toHaveCount(0, { timeout: 10000 });
  expect(app.errors).toEqual([]);
});
