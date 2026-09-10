import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { KEYS } from '../src/storage';
import { defaultSettings } from '../src/domain';

type Row = {
  id: string; created_at: string; updated_at: string; user_color: string;
  elo_maia: number; elo_user: number; model: string; moves: string[];
};

function stored(id: string, moves: string[] = []) {
  return { id, createdAt: '2026-09-10T00:00:00Z', moves, settings: { ...defaultSettings } };
}

async function bootGames(page: Page, seed: Record<string, unknown> = {}, offline = false) {
  const store = { games: new Map<string, Row>(), currentId: null as string | null, offline };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(storage => {
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, JSON.stringify(value));
  }, seed);
  await page.route('http://maia.test/**', async route => {
    const url = new URL(route.request().url());
    if (store.offline && (url.pathname === '/games' || url.pathname.startsWith('/games/'))) {
      await route.abort();
      return;
    }
    if (url.pathname === '/games' || url.pathname.startsWith('/games/')) {
      const method = route.request().method();
      const id = url.pathname === '/games' ? null : decodeURIComponent(url.pathname.slice('/games/'.length));
      if (method === 'GET' && id === null) {
        const rows = [...store.games.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        await route.fulfill({ json: { games: rows, current_id: store.currentId, total: rows.length } });
      } else if (method === 'POST') {
        const body = route.request().postDataJSON();
        const now = new Date().toISOString();
        const previous = store.games.get(body.id ?? '');
        const row: Row = {
          id: body.id ?? `server-${store.games.size + 1}`, created_at: body.created_at || previous?.created_at || now,
          updated_at: now, user_color: body.user_color, elo_maia: body.elo_maia, elo_user: body.elo_user,
          model: body.model, moves: body.moves,
        };
        store.games.set(row.id, row);
        if (body.current) store.currentId = row.id;
        await route.fulfill({ json: row });
      } else if (method === 'DELETE' && id) {
        store.games.delete(id);
        if (store.currentId === id) store.currentId = null;
        await route.fulfill({ status: 204, body: '' });
      } else if (method === 'GET' && id) {
        const row = store.games.get(id);
        if (row) await route.fulfill({ json: row });
        else await route.fulfill({ status: 404, json: { code: 'not_found', message: 'unknown game' } });
      } else {
        await route.fulfill({ status: 405, json: { code: 'method_not_allowed', message: 'no' } });
      }
      return;
    }
    if (url.pathname === '/move') {
      const payload = route.request().postDataJSON();
      await route.fulfill({ json: { move: 'e7e5', top_moves: [], wdl: [0.2, 0.3, 0.5], model_used: payload.model, degraded: false } });
      return;
    }
    const filename = url.pathname.startsWith('/assets/') ? url.pathname.slice(1) : 'index.html';
    await route.fulfill({ body: await readFile(resolve('dist-browser', filename)), contentType: filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  return { store, errors };
}

async function clickSquare(page: Page, key: string) {
  const board = page.locator('#board cg-board');
  await board.scrollIntoViewIfNeeded();
  const bounds = (await board.boundingBox())!;
  const file = key.charCodeAt(0) - 97, rank = Number(key[1]) - 1;
  await page.mouse.click(bounds.x + (file + 0.5) * bounds.width / 8, bounds.y + (7 - rank + 0.5) * bounds.height / 8);
}

test('migration uploads local games once, reload resumes from the server', async ({ page }) => {
  const game = stored('local-1', ['e2e4', 'e7e5']);
  const app = await bootGames(page, { [KEYS.current]: game, [KEYS.saved]: [game] });
  await page.goto('http://maia.test/history');
  await expect(page.locator('.saved-game')).toHaveCount(1);
  await expect.poll(() => app.store.games.size).toBe(1);
  await expect.poll(() => app.store.currentId).toBe('local-1');
  expect(await page.evaluate(() => localStorage.getItem('maia-board.migrated-games.v1'))).toBe('true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('maia-board.outbox.v1'))).toBe('[]');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('.saved-game')).toHaveCount(1);
  await expect(page.locator('.saved-game').first()).toContainText('White · Maia 1600');
  await page.locator('.saved-game').first().getByRole('button', { name: 'Resume' }).click();
  await expect(page).toHaveURL('http://maia.test/play');
  await expect(page.locator('#board cg-board')).toBeVisible();
  expect(app.errors).toEqual([]);
});

test('offline boot falls back to cache and retry syncs later', async ({ page }) => {
  const game = stored('local-1', ['e2e4', 'e7e5']);
  const app = await bootGames(page, {
    [KEYS.current]: game, [KEYS.saved]: [game], 'maia-board.migrated-games.v1': true,
  }, true);
  await page.goto('http://maia.test/history');
  await expect(page.locator('.saved-game')).toHaveCount(1);
  await expect(page.locator('.sync-banner')).toBeVisible();
  app.store.offline = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => app.store.games.size).toBe(1);
  await expect(page.locator('.sync-banner')).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test('played moves persist and deletes stay deleted after reload', async ({ page }) => {
  const app = await bootGames(page, { 'maia-board.migrated-games.v1': true });
  await page.goto('http://maia.test/play');
  await page.locator('#start-game').click();
  await expect(page.locator('#play-controls')).toHaveCount(0);
  await clickSquare(page, 'e2');
  await clickSquare(page, 'e4');
  // A missing key throws instead of mismatching, which would abort polling
  // immediately; read defensively so the first ticks retry instead of failing.
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('maia-board.current-game.v1');
    const game = raw ? JSON.parse(raw) : null;
    return Array.isArray(game?.moves) ? game.moves.length : -1;
  }), { timeout: 30000 }).toBe(2);
  await expect.poll(() => app.store.games.size).toBe(1);
  await page.locator('#mode-history').click();
  await expect(page.locator('.saved-game')).toHaveCount(1);
  await page.locator('.saved-game').first().getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete game', exact: true }).click();
  await expect.poll(() => app.store.games.size).toBe(0);
  await page.reload();
  await expect(page.locator('.saved-game')).toHaveCount(0);
  expect(app.errors).toEqual([]);
});
