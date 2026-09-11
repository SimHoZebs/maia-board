import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';
import { KEYS } from '../src/storage';
import { defaultSettings, replay, type StoredGame } from '../src/domain';
import type { MoveRequest } from '../src/api';
import { SEARCH_POLICY } from '../src/reviewMetrics';

const record = (moves: string[], color: 'white' | 'black' = 'white', id = 'fixture'): StoredGame => ({ id, createdAt: '2026-09-10T00:00:00Z', moves, settings: { ...defaultSettings, userColor: color } });

async function boot(page: Page, storage: Record<string, unknown> = {}, start = true, path = '/') {
  const requests: { route: Route; payload: MoveRequest }[] = [];
  const gameStore = { games: new Map<string, any>(), currentId: null as string | null };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ storage }) => {
    if (!sessionStorage.getItem('seeded')) {
      for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, JSON.stringify(value));
      sessionStorage.setItem('seeded', '1');
    }
    // Deliver obsolete replies too: cancellation is an optimization, never the correctness guard.
    const originalFetch = window.fetch;
    window.fetch = (input, init) => originalFetch(input, { ...init, signal: undefined });
    const stats = { adds: 0, removes: 0 };
    Object.assign(window, { boardListeners: stats });
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, ...args: any[]) => {
      if (type === 'mousemove') stats.adds++;
      return (add as any)(type, ...args);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, ...args: any[]) => {
      if (type === 'mousemove') stats.removes++;
      return (remove as any)(type, ...args);
    }) as typeof document.removeEventListener;
  }, { storage });
  await page.route('http://maia.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/move') { requests.push({ route, payload: route.request().postDataJSON() }); return; }
    if (path === '/evaluate') {
      const payload = route.request().postDataJSON();
      const game = replay(payload.moves, payload.initial_fen);
      const moves = game.moves({ verbose: true }).slice(0, 2).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
      await route.fulfill({ json: { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 14, terminal: null, best_move: moves[0] ?? null, score: { type: 'cp', value: 20 }, lines: moves.map(move => ({ move, score: { type: 'cp', value: 20 }, depth: 14 })) } }); return;
    }
    if (path === '/games' || path.startsWith('/games/')) {
      const method = route.request().method();
      const id = path === '/games' ? null : decodeURIComponent(path.slice('/games/'.length));
      if (method === 'GET' && id === null) {
        const rows = [...gameStore.games.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        await route.fulfill({ json: { games: rows, current_id: gameStore.currentId, total: rows.length } });
        return;
      }
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        const now = new Date().toISOString();
        const previous = gameStore.games.get(body.id ?? '');
        const same = previous && previous.user_color === body.user_color && previous.elo_maia === body.elo_maia
          && previous.elo_user === body.elo_user && previous.model === body.model && JSON.stringify(previous.moves) === JSON.stringify(body.moves);
        const row = {
          id: body.id ?? `mock-${gameStore.games.size + 1}`, created_at: body.created_at || previous?.created_at || now,
          updated_at: same ? previous.updated_at : now, user_color: body.user_color, elo_maia: body.elo_maia,
          elo_user: body.elo_user, model: body.model, moves: body.moves,
        };
        gameStore.games.set(row.id, row);
        if (body.current) gameStore.currentId = row.id;
        await route.fulfill({ json: row });
        return;
      }
      if (method === 'DELETE' && id) {
        gameStore.games.delete(id);
        if (gameStore.currentId === id) gameStore.currentId = null;
      }
      await route.fulfill({ status: 204, body: '' }); return;
    }
    const filename = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    const contentType = filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html';
    await route.fulfill({ body: await readFile(resolve('dist-browser', filename)), contentType });
  });
  await page.goto(`http://maia.test${path}`);
  await expect(page.getByRole('navigation', { name: 'Destination' })).toBeVisible();
  if (path === '/' || path === '/play') {
    if (start && !storage[KEYS.current]) await page.locator('#start-game').click();
    await expect(page.locator('#board cg-board')).toHaveCount(1);
    await expect(page.locator('#board piece:not(.ghost)')).toHaveCount(32 - (storage[KEYS.current] ? countCaptures(storage[KEYS.current] as StoredGame) : 0));
  }
  async function reply(index: number, move?: string, status = 200, topMoves?: { move: string; prob: number }[]) {
    await expect.poll(() => requests.length).toBeGreaterThan(index);
    const item = requests[index];
    const chosen = move ?? new Chess(item.payload.fen).moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`)[0];
    const delivered = page.waitForResponse(response => response.request() === item.route.request());
    await item.route.fulfill({ status, json: status === 200 ? { move: chosen, top_moves: topMoves ?? [{ move: chosen, prob: 0.6 }], wdl: [0.2, 0.3, 0.5], model_used: item.payload.model, degraded: false } : { code: 'engine_busy', message: 'busy' } });
    await (await delivered).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
  return { requests, reply, errors };
}
function countCaptures(game: StoredGame) { return replay(game.moves).history({ verbose: true }).filter(move => move.captured).length; }

for (const path of ['/analyze', '/history']) {
  test(`direct ${path} and refresh never start restored play inference`, async ({ page }) => {
    const game = record(['e2e4']);
    const app = await boot(page, { [KEYS.current]: game, [KEYS.saved]: [game] }, false, path);
    const destination = page.getByRole('link', { name: path === '/analyze' ? 'Analyze' : 'History', exact: true });
    await expect(destination).toHaveAttribute('aria-current', 'page');
    await expect(page.locator(path === '/analyze' ? '#analysis-controls' : '.saved-panel')).toBeVisible();
    await page.reload();
    await expect(destination).toHaveAttribute('aria-current', 'page');
    expect(app.requests).toHaveLength(0);
    expect(await currentMoves(page)).toEqual(['e2e4']);
    await page.locator('#mode-play').click();
    await expect(page).toHaveURL('http://maia.test/play');
    await app.reply(0, 'e7e5');
    await piece(page, 'e5', 'black pawn');
    expect(app.requests).toHaveLength(1);
    expect(app.errors).toEqual([]);
  });
}

test('direct play resumes once; Back/Forward preserves game viewing and analysis exploration', async ({ page }) => {
  const app = await boot(page, { [KEYS.current]: record(['e2e4']) }, false, '/play');
  await app.reply(0, 'e7e5');
  await page.locator('#analysis-first').click();
  await page.locator('#flip-board').click();
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-pgn').fill('1. d4 d5');
  await page.locator('#load-analysis').click();
  await move(page, 'c2', 'c4');
  await page.locator('#mode-history').click();
  await page.goBack();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 4');
  await piece(page, 'c4', 'white pawn');
  await expect(page.locator('.branch-label')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('http://maia.test/play');
  await expect(page.locator('#analysis-index')).toHaveText('Position 1 / 3');
  await piece(page, 'e2', 'white pawn');
  await expect(page.locator('#board .cg-wrap')).toHaveClass(/orientation-black/);
  await page.getByRole('button', { name: 'Return to game' }).click();
  await piece(page, 'e5', 'black pawn');
  await page.goForward();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await piece(page, 'c4', 'white pawn');
  await page.goForward();
  await expect(page).toHaveURL('http://maia.test/history');
  expect(app.requests.filter(request => !request.payload.initial_fen)).toHaveLength(1);
  expect(await currentMoves(page)).toEqual(['e2e4', 'e7e5']);
  expect(app.errors).toEqual([]);
});

test('Back retires pending analysis; Forward does not repeat it or resume play twice', async ({ page }) => {
  const app = await boot(page, { [KEYS.current]: record(['e2e4']) }, false, '/analyze');
  await page.locator('#mode-play').click();
  await expect.poll(() => app.requests.length).toBe(1);
  await page.goBack();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await app.reply(0, 'e7e5');
  expect(await currentMoves(page)).toEqual(['e2e4']);
  await page.locator('#load-analysis').click();
  await expect.poll(() => app.requests.length).toBe(2);
  await page.goForward();
  await expect(page).toHaveURL('http://maia.test/play');
  await expect.poll(() => app.requests.length).toBe(3);
  await app.reply(1, 'd2d4');
  await app.reply(2, 'c7c5');
  await piece(page, 'c5', 'black pawn');
  await page.goBack();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await expect(page.locator('#insight-content')).toHaveCount(1);
  await page.goForward();
  await expect(page).toHaveURL('http://maia.test/play');
  await piece(page, 'c5', 'black pawn');
  expect(app.requests).toHaveLength(3);
  expect(app.errors).toEqual([]);
});

for (const path of ['/', '/unknown/destination']) {
  test(`${path} redirects and resumes restored Maia turn exactly once`, async ({ page }) => {
    const app = await boot(page, { [KEYS.current]: record(['e2e4']) }, false, path);
    await expect(page).toHaveURL('http://maia.test/play');
    await expect.poll(() => app.requests.length).toBe(1);
    expect(app.requests[0].payload.moves).toEqual(['e2e4']);
    await app.reply(0, 'e7e5');
    await piece(page, 'e5', 'black pawn');
    expect(await currentMoves(page)).toEqual(['e2e4', 'e7e5']);
    expect(app.requests).toHaveLength(1);
    expect(app.errors).toEqual([]);
  });

  test(`${path} replaces its history entry with play`, async ({ page }) => {
    await boot(page, {}, false, '/history');
    await page.goto(`http://maia.test${path}`);
    await expect(page).toHaveURL('http://maia.test/play');
    await expect(page.locator('#play-controls')).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL('http://maia.test/history');
    await page.goForward();
    await expect(page).toHaveURL('http://maia.test/play');
  });
}
test('Analyze current game loads on Analyze without adding a history entry', async ({ page }) => {
  const game = record(['e2e4', 'e7e5']);
  const app = await boot(page, { [KEYS.current]: game }, false, '/history');
  await page.locator('#mode-analysis').click();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByRole('button', { name: 'Analyze current game', exact: true }).click();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await piece(page, 'e5', 'black pawn');
  await page.goBack();
  await expect(page).toHaveURL('http://maia.test/history');
  await expect(page.locator('.saved-panel')).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await piece(page, 'e5', 'black pawn');
  expect(app.requests).toHaveLength(0);
  expect(app.errors).toEqual([]);
});

async function square(page: Page, key: string) {
  const board = page.locator('#board cg-board');
  await board.scrollIntoViewIfNeeded();
  const bounds = (await board.boundingBox())!;
  const black = await page.locator('#board .cg-wrap').evaluate(el => el.classList.contains('orientation-black'));
  const file = key.charCodeAt(0) - 97, rank = Number(key[1]) - 1;
  return { x: bounds.x + (black ? 7 - file + 0.5 : file + 0.5) * bounds.width / 8, y: bounds.y + (black ? rank + 0.5 : 7 - rank + 0.5) * bounds.height / 8 };
}
async function move(page: Page, from: string, to: string, drag = false) {
  const a = await square(page, from), b = await square(page, to);
  if (drag) {
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
  } else { await page.mouse.click(a.x, a.y); await page.mouse.click(b.x, b.y); }
}
async function piece(page: Page, key: string, expected: string | null) {
  await expect.poll(() => page.locator('#board cg-board piece:not(.ghost)').evaluateAll((els, key) => {
    const node = els.find(el => (el as HTMLElement & { cgKey: string }).cgKey === key);
    return node ? node.className.replace(/\s*(anim|dragging|fading)\b/g, '').trim() : null;
  }, key)).toBe(expected);
}
async function currentMoves(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null')?.moves ?? [], KEYS.current);
}
async function screenshot(page: Page, path: string) {
  await expect(page.locator('#board piece.anim')).toHaveCount(0);
  await page.screenshot({ path, fullPage: true });
}

for (const color of ['white', 'black'] as const) for (const drag of [false, true]) {
  test(`${color}: ${drag ? 'drag' : 'click'}, Maia reply, takeback and flip`, async ({ page }) => {
    const app = await boot(page, { [KEYS.settings]: { ...defaultSettings, userColor: color } });
    if (color === 'black') { await app.reply(0, 'e2e4'); await piece(page, 'e4', 'white pawn'); }
    const before = color === 'black' ? 1 : 0;
    await move(page, color === 'white' ? 'e2' : 'e7', color === 'white' ? 'e4' : 'e5', drag);
    await expect.poll(() => app.requests.length).toBe(before + 1);
    const request = app.requests[before].payload;
    expect(request.maia_color).toBe(color === 'white' ? 'black' : 'white');
    expect(replay(request.moves).fen()).toBe(request.fen);
    expect(request.elo_maia).toBe(1600);
    await app.reply(before, color === 'white' ? 'e7e5' : 'g1f3');
    await expect(page.locator('#insight-title')).toHaveCount(0);
    await expect(page.locator('.estimate')).toHaveCount(0);
    await expect(page.locator('.candidate-list li')).toHaveCount(0);
    await page.locator('#flip-board').click();
    await expect(page.locator('#board .cg-wrap')).toHaveClass(new RegExp(`orientation-${color === 'white' ? 'black' : 'white'}`));
    await page.locator('#takeback').click();
    await expect.poll(() => currentMoves(page)).toEqual(color === 'white' ? [] : ['e2e4']);
    await piece(page, color === 'white' ? 'e2' : 'e7', `${color} pawn`);
    expect(app.errors).toEqual([]);
  });
}

const special = {
  castle: { white: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'd2d3', 'g8f6'], black: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'd2d3', 'g8f6', 'e1g1'] },
  ep: { white: ['e2e4', 'a7a6', 'e4e5', 'd7d5'], black: ['a2a3', 'e7e5', 'a3a4', 'e5e4', 'd2d4'] },
  promotion: { white: ['a2a4', 'h7h5', 'a4a5', 'h5h4', 'a5a6', 'h4h3', 'a6b7', 'h3g2'], black: ['a2a4', 'h7h5', 'a4a5', 'h5h4', 'a5a6', 'h4h3', 'a6b7', 'h3g2', 'b7a8q'] },
};
for (const color of ['white', 'black'] as const) {
  test(`${color}: castling reconciles rook`, async ({ page }) => {
    const app = await boot(page, { [KEYS.current]: record(special.castle[color], color) });
    const rank = color === 'white' ? '1' : '8';
    await move(page, `e${rank}`, `g${rank}`, color === 'black');
    await piece(page, `g${rank}`, `${color} king`); await piece(page, `f${rank}`, `${color} rook`); await piece(page, `h${rank}`, null);
    await expect.poll(() => app.requests.length).toBe(1);
    expect(app.requests[0].payload.moves.at(-1)).toBe(`e${rank}g${rank}`);
    await app.reply(0); await expect(page.locator('.turn-indicator')).toHaveText('To move');
    expect(app.errors).toEqual([]);
  });
  test(`${color}: en passant removes captured pawn`, async ({ page }) => {
    const app = await boot(page, { [KEYS.current]: record(special.ep[color], color) });
    const from = color === 'white' ? 'e5' : 'e4', to = color === 'white' ? 'd6' : 'd3';
    await move(page, from, to, color === 'white');
    await piece(page, to, `${color} pawn`); await piece(page, color === 'white' ? 'd5' : 'd4', null);
    await expect.poll(() => app.requests.length).toBe(1);
    expect(app.requests[0].payload.moves.at(-1)).toBe(from + to);
  });
  test(`${color}: promotion restores board, cancels and underpromotes`, async ({ page }) => {
    const app = await boot(page, { [KEYS.current]: record(special.promotion[color], color) });
    const from = color === 'white' ? 'b7' : 'g2', to = color === 'white' ? 'a8' : 'h1';
    await move(page, from, to);
    await expect(page.locator('#promotion-dialog')).toBeVisible();
    await piece(page, from, `${color} pawn`); await piece(page, to, `${color === 'white' ? 'black' : 'white'} rook`);
    expect(app.requests).toHaveLength(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#promotion-dialog')).not.toBeVisible();
    await move(page, from, to, true);
    await page.locator('[data-promotion="n"]').click();
    await piece(page, to, `${color} knight`);
    await expect.poll(() => app.requests.length).toBe(1);
    expect(app.requests[0].payload.moves.at(-1)).toBe(from + to + 'n');
    expect(app.errors).toEqual([]);
  });
}

test('analysis load, navigation, export, request history, stale reply and mode reuse', async ({ page }) => {
  const app = await boot(page);
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-pgn').fill('1. e4 e5 2. Nf3');
  await page.locator('#load-analysis').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 4');
  await piece(page, 'f3', 'white knight');
  await expect.poll(() => app.requests.length).toBe(1);
  expect(app.requests[0].payload.moves).toEqual(['e2e4', 'e7e5', 'g1f3']);
  await page.locator('#analysis-prev').click();
  await app.reply(0, 'b8c6');
  await expect(page.locator('#insight-content')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Analyze entire game' })).toBeEnabled();
  await piece(page, 'g1', 'white knight');
  await page.locator('#analysis-next').click();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#export-pgn').click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('maia-analysis.pgn');
  expect(await readFile((await download.path())!, 'utf8')).toContain('1. e4 e5 2. Nf3');
  const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  await page.locator('#mode-analysis').click();
  await page.getByRole('button', { name: 'FEN', exact: true }).click();
  await page.locator('#analysis-fen').fill(fen); await page.locator('#analysis-pgn').fill('1. e4');
  await page.locator('#load-analysis').click();
  await expect.poll(() => app.requests.length).toBe(2);
  expect(app.requests[1].payload.initial_fen).toBe(fen);
  expect(replay(app.requests[1].payload.moves, fen).fen()).toBe(app.requests[1].payload.fen);
  await app.reply(1, 'e8d7');
  await expect(page.locator('#insight-title')).toHaveText('Human moves · 1600 rating');
  await page.locator('#mode-play').click(); await move(page, 'd2', 'd4');
  await expect.poll(() => app.requests.length).toBe(3);
  await app.reply(2, 'd7d5'); await piece(page, 'd5', 'black pawn');
  expect(app.errors).toEqual([]);
});

test('saved switching at identical FEN retires pending reply and persists selection', async ({ page }) => {
  const a = record(['e2e4'], 'white', 'a'), b = record(['e2e4'], 'white', 'b');
  const app = await boot(page, { [KEYS.current]: a, [KEYS.saved]: [a, b] });
  await expect.poll(() => app.requests.length).toBe(1);
  await page.locator('#mode-history').click();
  await page.locator('[data-game-id="b"]').click();
  await expect.poll(() => app.requests.length).toBe(2);
  await expect.poll(() => page.evaluate(key => {
    const raw = localStorage.getItem(key);
    const game = raw ? JSON.parse(raw) : null;
    return typeof game?.id === 'string' ? game.id : null;
  }, KEYS.current)).toBe('b');
  await app.reply(1, 'c7c5'); await app.reply(0, 'e7e5');
  await piece(page, 'c5', 'black pawn'); await piece(page, 'e7', 'black pawn');
  await expect(page.locator('#insight-title')).toHaveCount(0);
  await page.reload(); await piece(page, 'c5', 'black pawn');
  expect(app.errors).toEqual([]);
});

test('pending takeback/new game/mode/settings transitions reject obsolete replies', async ({ page }) => {
  const app = await boot(page);
  await move(page, 'e2', 'e4'); await expect.poll(() => app.requests.length).toBe(1);
  await page.locator('#takeback').click(); await app.reply(0, 'e7e5');
  await piece(page, 'e2', 'white pawn'); await piece(page, 'e7', 'black pawn');
  await move(page, 'e2', 'e4'); await expect.poll(() => app.requests.length).toBe(2);
  await page.locator('#mode-analysis').click(); await page.locator('#mode-play').click();
  await expect.poll(() => app.requests.length).toBe(3);
  await app.reply(1, 'e7e5'); await expect(page.locator('.turn-indicator')).toHaveText('Thinking…');
  await page.locator('#new-game').click();
  await page.locator('#elo-maia').selectOption('1800');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(app.requests).toHaveLength(3);
  await page.locator('#new-game').click();
  await page.locator('#elo-maia').selectOption('2000');
  await page.locator('#start-game').click(); await app.reply(2, 'e7e5');
  await expect.poll(() => currentMoves(page)).toEqual([]);
  await expect(page.locator('.turn-indicator')).toHaveText('To move');
  await piece(page, 'e7', 'black pawn');
  expect(app.errors).toEqual([]);
});

test('request errors settle without retry loops, controls recover', async ({ page }) => {
  const app = await boot(page);
  await move(page, 'e2', 'e4'); await app.reply(0, undefined, 503);
  await expect(page.locator('#error-banner')).toHaveText('Maia is busy. Wait a moment and try again.');
  await expect(page.locator('.turn-indicator')).not.toHaveText('Thinking…');
  await page.locator('#takeback').click(); await move(page, 'd2', 'd4');
  await app.reply(1, 'd7d5'); await expect(page.locator('.turn-indicator')).toHaveText('To move');
  expect(app.requests).toHaveLength(2);
});

test('single live Chessground binding survives React updates and StrictMode cleanup', async ({ page }, testInfo) => {
  const app = await boot(page);
  const stats = () => page.evaluate(() => (window as any).boardListeners as { adds: number; removes: number });
  const initial = await stats();
  expect(initial.adds - initial.removes).toBe(1);
  if (process.env.NODE_ENV === 'development') expect(initial).toEqual({ adds: 2, removes: 1 });
  await move(page, 'e2', 'e4'); await app.reply(0, 'e7e5');
  await expect(page.locator('.turn-indicator')).toHaveText('To move');
  await page.locator('#mode-analysis').click(); await page.locator('#analysis-pgn').fill('1. d4 d5');
  await page.locator('#load-analysis').click(); await page.locator('#mode-play').click();
  await page.locator('#flip-board').click();
  expect(await stats()).toEqual(initial);
  await expect(page.locator('#board cg-board')).toHaveCount(1);
  await screenshot(page, testInfo.outputPath('desktop.png'));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('#board cg-board').evaluate(board => {
    const bounds = board.getBoundingClientRect();
    return [...board.querySelectorAll('piece:not(.ghost)')].every(piece => {
      const rect = piece.getBoundingClientRect();
      return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
    });
  })).toBe(true);
  await move(page, 'g1', 'f3', true);
  await expect.poll(() => app.requests.length).toBe(2);
  await app.reply(1, 'b8c6');
  await piece(page, 'f3', 'white knight');
  await expect.poll(() => page.locator('#board cg-board').evaluate(board => {
    const bounds = board.getBoundingClientRect();
    const black = board.closest('.cg-wrap')!.classList.contains('orientation-black');
    return [...board.querySelectorAll('piece:not(.ghost)')].flatMap(el => {
      const key = (el as HTMLElement & { cgKey: string }).cgKey;
      const file = key.charCodeAt(0) - 97, rank = Number(key[1]) - 1;
      const rect = el.getBoundingClientRect();
      const x = bounds.left + (black ? 7 - file : file) * bounds.width / 8;
      const y = bounds.top + (black ? rank : 7 - rank) * bounds.height / 8;
      return Math.abs(rect.left - x) > 1 || Math.abs(rect.top - y) > 1 ? [{ key, actual: [rect.left, rect.top], expected: [x, y] }] : [];
    });
  })).toEqual([]);
  await screenshot(page, testInfo.outputPath('mobile.png'));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(app.errors).toEqual([]);
});

test('setup disappears; draft cancel preserves a reply arriving while historical', async ({ page }) => {
  const app = await boot(page, {}, false);
  await expect(page.locator('#play-controls')).toBeVisible();
  expect(app.requests).toHaveLength(0);
  await page.locator('#elo-maia').selectOption('1800');
  await page.locator('#start-game').click();
  await expect(page.locator('#play-controls')).toHaveCount(0);
  await expect(page.locator('.insight-panel, .saved-panel, .turn-chip, .stage-heading')).toHaveCount(0);
  await move(page, 'e2', 'e4');
  await expect.poll(() => app.requests.length).toBe(1);
  expect(app.requests[0].payload).toMatchObject({ elo_maia: 1800, elo_user: 1800 });
  await page.locator('#analysis-first').click();
  await piece(page, 'e2', 'white pawn');
  await move(page, 'd2', 'd4');
  expect(await currentMoves(page)).toEqual(['e2e4']);
  await page.locator('#new-game').click();
  await page.locator('#elo-maia').selectOption('2200');
  await app.reply(0, 'e7e5');
  await page.keyboard.press('Escape');
  await expect(page.locator('#new-game')).toBeFocused();
  await piece(page, 'e2', 'white pawn');
  expect(await currentMoves(page)).toEqual(['e2e4', 'e7e5']);
  await page.getByRole('button', { name: 'Return to game' }).click();
  await piece(page, 'e5', 'black pawn');
  expect(app.requests).toHaveLength(1);
  await expect(page.locator('.player-strip').filter({ hasText: 'Maia' })).toContainText('1800');
});

test('analysis candidate preview, independent rating, branch replay and labeled exports', async ({ page }, testInfo) => {
  const app = await boot(page);
  await page.locator('#mode-analysis').click();
  await expect(page.locator('#analysis-controls')).toBeVisible();
  await page.locator('#analysis-pgn').fill('1. e4 e5 2. Nf3');
  await page.locator('#load-analysis').click();
  await expect(page.locator('#analysis-controls')).toHaveCount(0);
  await app.reply(0, 'b8c6', 200, [{ move: 'b8c6', prob: .4 }, { move: 'g8f6', prob: .15 }]);
  await expect(page.locator('section[aria-label="Maia analysis"] .candidate-reading')).toHaveText(['Nc640%', 'Nf615%']);
  await expect(page.locator('section[aria-label="Maia analysis"] .win-hero strong')).toHaveText('20%');
  await expect(page.locator('section[aria-label="Maia analysis"] .win-hero span')).toHaveText('White win · after Nc6');
  await expect(page.locator('section[aria-label="Stockfish evaluation"] .win-hero strong')).toHaveText('52%');
  await page.getByRole('button', { name: 'Preview Nf6' }).hover();
  await expect(page.locator('#board svg.cg-shapes line[stroke="#d6b85c"]')).toHaveCount(1);
  await piece(page, 'g8', 'black knight');
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 4');
  await expect(page.locator('section[aria-label="Maia analysis"] .win-hero span')).toHaveText('White win · after Nc6');
  await screenshot(page, testInfo.outputPath('analysis-candidates-desktop.png'));
  await move(page, 'g8', 'f6');
  await piece(page, 'f6', 'black knight');
  await expect(page.locator('#insight-content')).toHaveCount(0);
  await expect(page.locator('#board svg.cg-shapes line[stroke="#d6b85c"]')).toHaveCount(0);
  await move(page, 'f1', 'c4');
  await expect.poll(() => app.requests.length).toBe(2);
  expect(app.requests[1].payload.moves).toEqual(['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f1c4']);
  expect(replay(app.requests[1].payload.moves).fen()).toBe(app.requests[1].payload.fen);
  await page.locator('#mode-analysis').click();
  await page.keyboard.press('Escape');
  expect(app.requests).toHaveLength(2);
  await app.reply(1, 'b8c6');
  await page.getByText('Analysis settings', { exact: true }).click();
  await page.locator('#analysis-rating').selectOption('2000');
  await expect(page.locator('#insight-content')).toHaveCount(0);
  await expect(page.locator('#insight-title')).toHaveText('Human moves · 2000 rating');
  await expect.poll(() => app.requests.length).toBe(3);
  expect(app.requests[2].payload).toMatchObject({ elo_maia: 2000, elo_user: 2000 });
  await page.locator('#analysis-model').selectOption('5m');
  await app.reply(2, 'b8c6');
  await expect(page.locator('#insight-content')).toHaveCount(0);
  for (const [id, filename, expected] of [['export-pgn', 'maia-analysis.pgn', '1. e4 e5 2. Nf3'], ['export-explored', 'maia-explored.pgn', '1. e4 e5 2. Nf3 Nf6 3. Bc4']]) {
    const downloading = page.waitForEvent('download');
    await page.locator(`#${id}`).click();
    const file = await downloading;
    expect(file.suggestedFilename()).toBe(filename);
    expect(await readFile((await file.path())!, 'utf8')).toContain(expected);
  }
  await page.locator('#return-original').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 4');
  await piece(page, 'g8', 'black knight');
  await page.locator('#mode-play').click();
  await expect(page.locator('.player-strip').filter({ hasText: 'Maia' })).toContainText('1600');
  expect(app.errors).toEqual([]);
});

test('history review, resume, export, delete, and just-finished game review', async ({ page }) => {
  const mate = record(['f2f3', 'e7e5', 'g2g4', 'd8h4'], 'white', 'mate');
  const unfinished = record(['e2e4', 'e7e5'], 'white', 'unfinished');
  const app = await boot(page, { [KEYS.current]: mate, [KEYS.saved]: [mate, unfinished] });
  await expect(page.locator('.game-result')).toContainText('Black wins');
  await page.getByRole('button', { name: 'Review game' }).click();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await expect(page.locator('#analysis-controls')).toHaveCount(0);
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  await page.locator('#mode-history').click();
  const cards = page.locator('.saved-game');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('White · Maia 1600');
  await expect(cards.first().getByRole('button', { name: 'Resume' })).toHaveCount(0);
  const downloading = page.waitForEvent('download');
  await cards.first().getByRole('button', { name: 'Export' }).click();
  expect(await readFile((await (await downloading).path())!, 'utf8')).toContain('Qh4#');
  await cards.last().getByRole('button', { name: 'Resume' }).click();
  await expect(page).toHaveURL('http://maia.test/play');
  await piece(page, 'e5', 'black pawn');
  await page.locator('#mode-history').click();
  await cards.last().getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete game', exact: true }).click();
  await expect(cards).toHaveCount(1);
  await page.reload();
  await expect(page).toHaveURL('http://maia.test/history');
  await expect(cards).toHaveCount(1);
  await page.locator('#mode-play').click();
  await expect(page.locator('#play-controls')).toBeVisible();
  expect(await currentMoves(page)).toEqual([]);
  expect(app.errors).toEqual([]);
});

test('analysis entry sources and input keyboard isolation', async ({ page }) => {
  const app = await boot(page, { [KEYS.saved]: [record(['d2d4', 'd7d5'])] });
  await page.locator('#mode-analysis').click();
  await page.getByRole('button', { name: 'History', exact: true }).last().click();
  await page.locator('.saved-game').getByRole('button', { name: 'Analyze', exact: true }).click();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-pgn').fill('1. e4');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await page.keyboard.press('Escape');
  await expect(page.locator('#mode-analysis')).toBeFocused();
  await page.locator('#mode-analysis').click();
  await page.getByRole('button', { name: 'Starting position', exact: true }).click();
  await page.locator('#load-analysis').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 1 / 1');
  await expect.poll(() => app.requests.length).toBeGreaterThan(0);
  if (app.requests[0].payload.moves.length) await app.reply(0);
  const currentIndex = app.requests[0].payload.moves.length ? 1 : 0;
  await app.reply(currentIndex, 'e2e4');
  await expect(page.locator('section[aria-label="Maia analysis"] .win-hero strong')).toHaveText('50%');
  await expect(page.locator('section[aria-label="Maia analysis"] .win-hero span')).toHaveText('White win · after e4');
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 360, height: 800 }, { width: 390, height: 844 }]) {
  test(`workspace geometry and horizontal notation ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const long = Array.from({ length: 18 }, () => ['g1f3', 'g8f6', 'f3g1', 'f6g8']).flat();
    await boot(page, { [KEYS.current]: record(long) });
    const board = await page.locator('#board').boundingBox();
    expect(board!.width).toBeGreaterThan(viewport.width < 760 ? 300 : 380);
    expect(Math.abs(board!.width - board!.height)).toBeLessThan(1);
    for (const selector of ['.player-strip', '.move-navigation', '.board-actions']) for (const box of await page.locator(selector).evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }))) {
      expect(box.top).toBeGreaterThanOrEqual(0); expect(box.bottom).toBeLessThanOrEqual(viewport.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const box of await page.locator('.board-actions button, .nav-buttons button, .site-header a').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; }))) {
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const list = page.locator('#move-list');
    expect(await list.evaluate(el => el.scrollWidth > el.clientWidth && el.clientHeight <= 52)).toBe(true);
    await page.locator('#analysis-first').click();
    await page.locator('#analysis-next').click();
    await expect(page.locator('.move-cell[aria-current]')).toBeInViewport();
    await page.locator('#analysis-last').click();
    await expect(page.locator('.move-cell[aria-current]')).toBeInViewport();
    await expect(page.locator('.game-result')).toBeInViewport();
    await page.evaluate(({ key, game }) => localStorage.setItem(key, JSON.stringify(game)), { key: KEYS.current, game: record(['e2e4', 'e7e5']) });
    await page.reload();
    const controls = (await page.locator('.board-actions').boundingBox())!;
    expect(controls.y + controls.height).toBeLessThanOrEqual(viewport.height);
    await screenshot(page, testInfo.outputPath(`play-${viewport.width}.png`));
    await page.locator('#mode-analysis').click();
    await page.locator('#analysis-pgn').fill('1. e4 e5 2. Nf3');
    await page.locator('#load-analysis').click();
    const rail = (await page.locator('.insight-panel').boundingBox())!;
    const stage = (await page.locator('.board-stage').boundingBox())!;
    if (viewport.width > 760) expect(rail.x).toBeGreaterThan(stage.x + stage.width);
    else expect(rail.y).toBeGreaterThanOrEqual(stage.y + stage.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(page, testInfo.outputPath(`analysis-${viewport.width}.png`));
  });
}

test('phone touch movement and board exploration', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const app = await boot(page);
  const from = await square(page, 'e2'), to = await square(page, 'e4');
  await page.touchscreen.tap(from.x, from.y); await page.touchscreen.tap(to.x, to.y);
  await app.reply(0, 'e7e5');
  await piece(page, 'e5', 'black pawn');
  await page.locator('#mode-analysis').tap();
  await page.getByRole('button', { name: 'Starting position', exact: true }).tap();
  await page.locator('#load-analysis').tap();
  await app.reply(1, 'e2e4');
  await page.getByRole('button', { name: 'Preview e4' }).tap();
  await expect(page.locator('#board svg.cg-shapes line[stroke="#ef4444"]')).toHaveCount(1);
  const a = await square(page, 'e2'), b = await square(page, 'e4');
  await page.touchscreen.tap(a.x, a.y); await page.touchscreen.tap(b.x, b.y);
  await piece(page, 'e4', 'white pawn');
  expect(app.errors).toEqual([]);
  await context.close();
});
