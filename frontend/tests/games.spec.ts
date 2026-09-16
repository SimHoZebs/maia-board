import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { KEYS } from '../src/storage';
import { defaultSettings } from '../src/domain';

type Row = {
  id: string; created_at: string; updated_at: string; user_color: string;
  elo_maia: number; elo_user: number; model: string; moves: string[]; result?: string; temperature?: number;
};

function stored(id: string, moves: string[] = []) {
  return { id, createdAt: '2026-09-10T00:00:00Z', moves, settings: { ...defaultSettings } };
}

async function bootGames(page: Page, seed: Record<string, unknown> = {}, offline = false) {
  const store = { games: new Map<string, Row>(), currentId: null as string | null, offline, writes: [] as string[] };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(storage => {
    if (sessionStorage.getItem('seeded')) return;
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, JSON.stringify(value));
    sessionStorage.setItem('seeded', '1');
  }, seed);
  await page.route('http://maia.test/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/openings') {
      const moves = route.request().postDataJSON()?.moves;
      await route.fulfill({ json: { matches: [], book_flags: Array.isArray(moves) ? moves.map(() => false) : [] } });
      return;
    }
    if (store.offline && (url.pathname === '/games' || url.pathname.startsWith('/games/'))) {
      await route.abort();
      return;
    }
    if (url.pathname === '/games' || url.pathname.startsWith('/games/')) {
      const method = route.request().method();
      const id = url.pathname === '/games' ? null : decodeURIComponent(url.pathname.slice('/games/'.length));
      if (method === 'GET' && id === null) {
        const rows = [...store.games.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        await route.fulfill({ json: { games: rows.slice(offset, offset + limit), current_id: store.currentId, current_game: store.games.get(store.currentId ?? '') ?? null, total: rows.length, next_offset: offset + limit < rows.length ? offset + limit : null } });
      } else if (method === 'POST') {
        store.writes.push('POST');
        const body = route.request().postDataJSON();
        const now = new Date().toISOString();
        const previous = store.games.get(body.id ?? '');
        const row: Row = {
          id: body.id ?? `server-${store.games.size + 1}`, created_at: body.created_at || previous?.created_at || now,
          updated_at: now, user_color: body.user_color, elo_maia: body.elo_maia, elo_user: body.elo_user,
          model: body.model, temperature: body.temperature, moves: body.moves, result: body.result ?? previous?.result,
        };
        store.games.set(row.id, row);
        if (body.current) store.currentId = row.id;
        await route.fulfill({ json: row });
      } else if (method === 'DELETE' && id) {
        store.writes.push('DELETE');
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
      await route.fulfill({ json: { move: 'e7e5', top_moves: [{ move: 'e7e5', prob: .6 }], wdl: [0.2, 0.3, 0.5], model_used: payload.model, degraded: false } });
      return;
    }
    const filename = url.pathname.startsWith('/assets/') ? url.pathname.slice(1) : 'index.html';
    await route.fulfill({ body: await readFile(resolve(process.env.MAIA_BUILD_DIR ?? 'dist-browser', filename)), contentType: filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
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

test('live play shows the actual 5m fallback after requesting 79m', async ({ page }) => {
  const app = await bootGames(page, { 'maia-board.migrated-games.v1': true });
  let requestedModel: unknown;
  await page.route('http://maia.test/move', async route => {
    requestedModel = route.request().postDataJSON().model;
    await route.fulfill({ json: { move: 'e7e5', top_moves: [{ move: 'e7e5', prob: .6 }], wdl: [.2, .3, .5], model_used: '5m', degraded: true } });
  });
  await page.goto('http://maia.test/play');
  await page.locator('#start-game').click();
  await clickSquare(page, 'e2');
  await clickSquare(page, 'e4');
  await expect(page.getByRole('status').filter({ hasText: '5m fallback · requested 79m' })).toBeVisible();
  expect(requestedModel).toBe('79m');
  await expect.poll(() => [...app.store.games.values()][0]?.moves).toEqual(['e2e4', 'e7e5']);
  expect([...app.store.games.values()][0].model).toBe('79m');
  await page.getByRole('button', { name: 'Takeback', exact: true }).click();
  await expect(page.getByText('5m fallback · requested 79m', { exact: true })).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test('legacy games seed read-only display without uploading', async ({ page }) => {
  // The v1 migration was deleted: pre-database keys seed local display but
  // never create upload ops, so the server stays untouched.
  const game = stored('local-1', ['e2e4', 'e7e5']);
  const app = await bootGames(page, { [KEYS.current]: game, [KEYS.saved]: [game] });
  await page.goto('http://maia.test/history');
  await expect(page.locator('.saved-game')).toHaveCount(1);
  await expect(page.locator('.saved-game').first()).toContainText('White · Maia 1600');
  await expect(page.locator('.sync-banner')).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(app.store.games.size).toBe(0);
  expect(app.store.writes).toEqual([]);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('.saved-game')).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test('history loads older pages while keeping the current game independent', async ({ page }) => {
  const app = await bootGames(page);
  for (let index = 0; index < 105; index++) {
    const id = `game-${index}`;
    app.store.games.set(id, { id, created_at: '2026-09-10T00:00:00Z', updated_at: new Date(Date.UTC(2026, 8, 10, 0, index)).toISOString(), user_color: 'white', elo_maia: 1600, elo_user: 1600, model: '79m', moves: ['e2e4', 'e7e5'], temperature: 1 });
  }
  app.store.currentId = 'game-0';
  await page.goto('http://maia.test/history');
  await expect(page.locator('.saved-game')).toHaveCount(101);
  await expect(page.getByText('Showing 101 of 105', { exact: true })).toBeVisible();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('http://maia.test/games?limit=100&offset=100', async route => { await held; await route.fallback(); });
  await page.getByRole('button', { name: 'Load more', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Loading…', exact: true })).toBeDisabled();
  release();
  await expect(page.locator('.saved-game')).toHaveCount(105);
  await expect(page.getByRole('button', { name: 'Load more', exact: true })).toHaveCount(0);
  expect(app.store.writes).toEqual([]);
  await page.locator('#mode-play').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  expect(app.errors).toEqual([]);
});

test('invalid pending data is exportable and discarded only after confirmation', async ({ page }) => {
  // The v1 outbox is no longer read; invalid entries reach recovery through
  // a v2 document instead.
  await bootGames(page, { 'maia-board.games.v2': { schema: 2, games: [], currentId: null, pending: [{ op: 'unknown', original: 'keep me', version: 'v1' }], recovery: [] } });
  await page.goto('http://maia.test/history');
  await expect(page.getByRole('button', { name: 'Export recovery data' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recovery data' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('maia-board-recovery.json');
  expect(await readFile((await file.path())!, 'utf8')).toContain('keep me');
  await page.getByRole('button', { name: 'Discard recovery item 1…' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Discard recovery item 1…' })).toBeVisible();
  await page.getByRole('button', { name: 'Discard recovery item 1…' }).click();
  await page.getByRole('button', { name: 'Discard item', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Discard recovery item 1…' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Export recovery data' })).toHaveCount(0);
});

test('durability failures remain visible and export in-memory games', async ({ page }) => {
  await bootGames(page);
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'maia-board.games.v2') throw new DOMException('Storage is full', 'QuotaExceededError');
      return set.call(this, key, value);
    };
  });
  await page.goto('http://maia.test/play');
  await page.locator('#start-game').click();
  await expect(page.locator('.sync-banner [role="alert"]')).toContainText(/storage/i);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export recovery data' }).click();
  const data = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  expect(data.games).toHaveLength(1);
  expect(data.pending[0]).toMatchObject({ op: 'save', current: true });
  await expect(page.getByRole('button', { name: 'Export recovery data' })).toBeVisible();
});

test('offline boot falls back to cache and retry syncs later', async ({ page }) => {
  const game = stored('local-1', ['e2e4', 'e7e5']);
  const app = await bootGames(page, {
    [KEYS.current]: game, [KEYS.saved]: [game],
  }, true);
  await page.goto('http://maia.test/history');
  await expect(page.locator('.saved-game')).toHaveCount(1);
  await expect(page.locator('.sync-banner')).toBeVisible();
  // Legacy seeds carry no upload ops, so queue v2-native work while offline:
  // a played move saves locally and pends the upload the aborted flush
  // cannot clear. Retry then syncs exactly that game.
  await page.goto('http://maia.test/play');
  await expect(page.locator('.turn-indicator')).toHaveText('To move');
  await clickSquare(page, 'g1');
  await clickSquare(page, 'f3');
  await expect.poll(() => page.evaluate(() => {
    const repository = JSON.parse(localStorage.getItem('maia-board.games.v2') || 'null');
    const game = repository?.games.find((item: any) => item.id === repository.currentId);
    return Array.isArray(game?.moves) ? game.moves.length : -1;
  })).toBe(3);
  // Still offline: the failed move flush leaves Retry visible. Flip online
  // only when clicking it, so the mount flush cannot self-heal first.
  await page.goto('http://maia.test/history');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
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
    const raw = localStorage.getItem('maia-board.games.v2');
    const repository = raw ? JSON.parse(raw) : null;
    const game = repository?.games.find((game: any) => game.id === repository.currentId);
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
