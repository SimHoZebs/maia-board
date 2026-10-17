import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { replay } from '../src/shared/domain';
import { defaultStockfishSettings, stockfishPolicy } from '../src/eval/stockfishSettings';

const MOVES =
  'e2e4,e7e5,g1f3,b8c6,f1c4,f8c5,c2c3,g8f6,d2d4,e5d4,c3d4,c5b4,b1c3,f6e4,e1g1,e4c3,b2c3,b4e7,d4d5,c6a5,d1a4,a5c4,a4c4,d7d6,c1g5,e7g5,f3g5,e8g8,c4e4,d8g5,f2f4,g5f5,e4d4,c8d7,h2h3,f8e8,g2g4,f5e4,d4d2,e4e3,d2e3,e8e3,a1e1,e3h3,e1e7,d7g4,g1f2,g4f3,f1e1,g8f8,e1e3,h3h2,f2f3,h2h3,f3e4,h3e3,e4e3,f8e7,e3d4,b7b6,d4c4,a7a6,f4f5,h7h5,c4d4,h5h4,d4e3,e7f6,e3f4,a8h8,c3c4,h4h3'.split(
    ',',
  );

function legalAt(prefix: string[]) {
  const game = replay(prefix);
  return game.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
}

function sfRow(prefix: string[], settings: any) {
  const legal = legalAt(prefix);
  if (!legal.length) {
    return {
      engine: 'Stockfish 19',
      search_policy: stockfishPolicy(settings ?? defaultStockfishSettings),
      depth: 0,
      terminal: 'draw',
      best_move: null,
      score: { type: 'cp', value: 0 },
      lines: [],
    };
  }
  const lineMoves = MOVES.slice(0, prefix.length);
  const next = lineMoves[prefix.length];
  const best = (next && legal.includes(next) ? next : legal[0]) as string;
  const count = Math.max(1, Math.min(settings?.lines ?? 1, legal.length));
  const depth = 20;
  const score = { type: 'cp', value: Math.round(60 * Math.sin(prefix.length)) };
  const ranked = [best, ...legal.filter(move => move !== best)].slice(0, count);
  return {
    engine: 'Stockfish 19',
    search_policy: stockfishPolicy(settings ?? defaultStockfishSettings),
    depth,
    terminal: null,
    best_move: ranked[0] ?? null,
    score,
    lines: ranked.map(move => ({ move, score, depth })),
  };
}

function botRow(prefix: string[]) {
  const legal = legalAt(prefix);
  const best = legal[0] ?? 'e2e4';
  const second = legal.find(move => move !== best);
  return {
    move: best,
    top_moves: [
      { move: best, prob: 0.6, wdl: [0.2, 0.3, 0.5] },
      ...(second ? [{ move: second, prob: 0.25, wdl: [0.2, 0.3, 0.5] }] : []),
    ],
    wdl: [0.2, 0.3, 0.5],
    model_used: '79m',
    degraded: false,
  };
}

test('long 72-ply analyze line does not crash the app', async ({ page }) => {
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
  });
  await page.route('http://maia.test/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/me') {
      await route.fulfill({
        json: { id: 'test-user', created_at: '2026-01-01T00:00:00Z', display_name: 'Tester' },
      });
      return;
    }
    if (path === '/openings') {
      const moves = route.request().postDataJSON()?.moves;
      await route.fulfill({
        json: { matches: [], book_flags: Array.isArray(moves) ? moves.map(() => false) : [] },
      });
      return;
    }
    if (path === '/evaluate') {
      const payload = route.request().postDataJSON();
      await route.fulfill({ json: sfRow(payload.moves, payload.settings) });
      return;
    }
    if (path === '/move/analysis') {
      const payload = route.request().postDataJSON();
      await route.fulfill({ json: botRow(payload.moves) });
      return;
    }
    if (path === '/evaluations/lookup') {
      const { line, requests } = route.request().postDataJSON();
      const results = requests.map((body: any, index: number) => ({
        index,
        value:
          body.engine === 'sf'
            ? sfRow(line.moves.slice(0, body.ply), body.settings)
            : botRow(line.moves.slice(0, body.ply)),
      }));
      await route.fulfill({ json: { results } });
      return;
    }
    if (path === '/reviews' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      await route.fulfill({
        json: { job_id: 'mock-72', total: body.requests.length, cached: 0, pending: 0 },
      });
      return;
    }
    if (path.startsWith('/reviews/')) {
      const total = 72 * 3;
      const progress = { job_id: 'mock-72', total, done: total, failed: 0, finished: true };
      if (path.endsWith('/events')) {
        await route.fulfill({
          body: `data: ${JSON.stringify({ progress })}\n\n`,
          contentType: 'text/event-stream',
        });
        return;
      }
      await route.fulfill({ json: progress });
      return;
    }
    if (path === '/games' && route.request().method() === 'GET') {
      await route.fulfill({ json: { games: [], current_id: null, total: 0, next_offset: null } });
      return;
    }
    const filename = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    await route.fulfill({
      body: await readFile(resolve('dist-browser', filename)),
      contentType: filename.endsWith('.js')
        ? 'text/javascript'
        : filename.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    });
  });
  await page.goto(`http://maia.test/analyze?moves=${MOVES.join(',')}`);
  await expect(page.locator('#analysis-index')).toHaveText('Position 73 / 73', { timeout: 15000 });
  // Scrub across the line: start, early middlegame, late endgame, back to tip.
  for (const n of [0, 10, 36, 71]) {
    await page.locator('.move-cell').nth(n).click();
  }
  await expect(page.locator('#analysis-index')).toHaveText('Position 73 / 73');
  // Run the whole-game batch and let every lane settle (the fixture may
  // already show Analyzed if foreground + restore settled the line first).
  const analyzeButton = page.getByRole('button', { name: 'Analyze entire game' });
  if (await analyzeButton.count()) await analyzeButton.first().click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeVisible({ timeout: 60000 });
  await page.waitForTimeout(3000);
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
