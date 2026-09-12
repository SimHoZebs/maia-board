import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';
import { KEYS } from '../src/storage';
import { defaultSettings, replay, type StoredGame } from '../src/domain';
import type { MoveRequest } from '../src/api';
import { defaultStockfishSettings, stockfishPolicy } from '../src/stockfishSettings';
const SEARCH_POLICY = stockfishPolicy(defaultStockfishSettings);

const record = (moves: string[], color: 'white' | 'black' = 'white', id = 'fixture'): StoredGame => ({ id, createdAt: '2026-09-10T00:00:00Z', moves, settings: { ...defaultSettings, userColor: color } });

// Capture clipboard writes: the fixtures serve plain HTTP, where the async
// clipboard API is unavailable, so the app would take its execCommand
// fallback instead of a readable clipboard.
async function stubClipboard(page: Page) {
  await page.addInitScript(() => {
    const writes: string[] = [];
    (window as unknown as { copiedTexts: string[] }).copiedTexts = writes;
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: (text: string) => { writes.push(text); return Promise.resolve(); } },
      configurable: true,
    });
  });
}
async function copiedTexts(page: Page) {
  return page.evaluate(() => (window as unknown as { copiedTexts: string[] }).copiedTexts.join('\n'));
}

async function boot(page: Page, storage: Record<string, unknown> = {}, start = true, path = '/', extraInit?: () => void, expectBoard = true) {
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
  if (extraInit) await page.addInitScript(extraInit);
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
          && previous.elo_user === body.elo_user && previous.model === body.model && JSON.stringify(previous.moves) === JSON.stringify(body.moves)
          && (previous.result ?? '') === (body.result ?? '');
        const row = {
          id: body.id ?? `mock-${gameStore.games.size + 1}`, created_at: body.created_at || previous?.created_at || now,
          updated_at: same ? previous.updated_at : now, user_color: body.user_color, elo_maia: body.elo_maia,
          elo_user: body.elo_user, model: body.model, moves: body.moves, result: body.result ?? previous?.result ?? '',
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
    if (expectBoard) {
      await expect(page.locator('#board cg-board')).toHaveCount(1);
      await expect(page.locator('#board piece:not(.ghost)')).toHaveCount(32 - (storage[KEYS.current] ? countCaptures(storage[KEYS.current] as StoredGame) : 0));
    }
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

for (const width of [390, 640, 1440]) {
  test(`destination tabs stay in place across modes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await boot(page);
    const tabs = page.getByRole('navigation', { name: 'Destination' });
    const positions = () => tabs.getByRole('link').evaluateAll(links => links.map(link => {
      const { x, y, width, height } = link.getBoundingClientRect();
      return { x, y, width, height };
    }));
    const initial = await positions();
    const names = await tabs.getByRole('link').allTextContents();
    for (const name of [...names.filter(name => name !== 'Play'), 'Play']) {
      await tabs.getByRole('link', { name, exact: true }).click();
      await expect(tabs.getByRole('link', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      expect(await positions()).toEqual(initial);
    }
  });
}

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
  await expect(page).toHaveURL('http://maia.test/analyze?moves=d2d4,d7d5');
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 4');
  await piece(page, 'c4', 'white pawn');
  await expect(page.getByLabel('Explored variation', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL('http://maia.test/play');
  await expect(page.locator('#analysis-index')).toHaveText('Position 1 / 3');
  await piece(page, 'e2', 'white pawn');
  await expect(page.locator('#board .cg-wrap')).toHaveClass(/orientation-black/);
  await page.getByRole('button', { name: 'Return to game' }).click();
  await piece(page, 'e5', 'black pawn');
  await page.goForward();
  await expect(page).toHaveURL('http://maia.test/analyze?moves=d2d4,d7d5');
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
  await expect(page).toHaveURL('http://maia.test/analyze?moves=e2e4,e7e5');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await piece(page, 'e5', 'black pawn');
  await page.goBack();
  await expect(page).toHaveURL('http://maia.test/history');
  await expect(page.locator('.saved-panel')).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL('http://maia.test/analyze?moves=e2e4,e7e5');
  await piece(page, 'e5', 'black pawn');
  // Play requests never send initial_fen; the analysis foreground always
  // does. Review must never resume play inference, while its own 200ms
  // auto-fetch may legitimately win the race here.
  expect(app.requests.filter(request => !request.payload.initial_fen)).toHaveLength(0);
  expect(app.errors).toEqual([]);
});

test('analysis content URLs deep-link, copy, and walk games', async ({ page }) => {
  const app = await boot(page);
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-pgn').fill('1. e4 e5');
  await page.locator('#load-analysis').click();
  await expect(page).toHaveURL('http://maia.test/analyze?moves=e2e4,e7e5');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await page.locator('#copy-analysis-link').click();
  await expect(page.locator('#copy-analysis-link')).toHaveText('Link copied');
  await page.goto('http://maia.test/analyze?moves=d2d4,d7d5');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await piece(page, 'd5', 'black pawn');
  await page.goBack();
  await expect(page).toHaveURL('http://maia.test/analyze?moves=e2e4,e7e5');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await piece(page, 'e5', 'black pawn');
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

test('analysis load, navigation, copy, request history, stale reply and mode reuse', async ({ page }) => {
  await stubClipboard(page);
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
  await page.locator('#copy-pgn').click();
  await expect(page.locator('#copy-pgn')).toHaveText('PGN copied');
  await expect.poll(() => copiedTexts(page)).toContain('1. e4 e5 2. Nf3');
  const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  await page.locator('#mode-analysis').click();
  await page.getByRole('button', { name: 'FEN', exact: true }).click();
  await page.locator('#analysis-fen').fill(fen); await page.locator('#analysis-pgn').fill('1. e4');
  await page.locator('#load-analysis').click();
  await expect.poll(() => app.requests.length).toBe(2);
  expect(app.requests[1].payload.initial_fen).toBe(fen);
  expect(replay(app.requests[1].payload.moves, fen).fen()).toBe(app.requests[1].payload.fen);
  await app.reply(1, 'e8d7');
  await expect(page.getByRole('heading', { name: 'Maia • 1600', exact: true })).toBeVisible();
  await expect(page.locator('#analysis-rating')).toHaveValue('1600');
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
  await expect(page.locator('#error-banner')).toContainText('Maia is busy. Wait a moment and try again.');
  await expect(page.locator('#retry-request')).toBeVisible();
  await expect(page.locator('.turn-indicator')).not.toHaveText('Thinking…');
  await page.locator('#retry-request').click();
  await expect.poll(() => app.requests.length).toBe(2);
  await app.reply(1, 'e7e5'); await expect(page.locator('.turn-indicator')).toHaveText('To move');
  expect(app.errors).toEqual([]);
});

test('board crashes stay inside the board panel, rest of app unaffected', async ({ page }) => {
  // Surgical sabotage: only ResizeObserver.observe calls inside .board-frame
  // throw, once. MovesPanel observes outside .board-frame, so a narrow board
  // boundary must catch this while navigation and controls stay alive. The
  // stored game keeps the board reset key stable across server sync, so the
  // fallback persists until the scoped retry instead of auto-clearing.
  const app = await boot(page, { [KEYS.current]: record([], 'white', 'crash-game') }, true, '/play', () => {
    const RealRO = window.ResizeObserver;
    let armed = true;
    window.ResizeObserver = class extends RealRO {
      observe(target: Element, options?: ResizeObserverOptions) {
        if (armed && target instanceof Element && target.closest('.board-frame')) {
          armed = false;
          throw new Error('injected board crash');
        }
        super.observe(target, options);
      }
    };
  }, false);
  await expect(page.locator('#board-error')).toContainText('Board failed to render');
  await expect(page.locator('#board-error')).toContainText('rest of the board is unaffected');
  await expect(page.locator('#board cg-board')).toHaveCount(0);
  // Isolation: destination nav and board controls survive the board crash.
  await expect(page.getByRole('navigation', { name: 'Destination' })).toBeVisible();
  await expect(page.locator('#flip-board')).toBeVisible();
  // Scoped retry remounts only the board panel and recovers.
  await page.locator('#board-error').getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('#board cg-board')).toHaveCount(1);
  await expect(page.locator('#board-error')).toHaveCount(0);
  expect(app.errors).toEqual([]);
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

test('analysis candidate preview, independent rating, branch replay and PGN copies', async ({ page }, testInfo) => {
  await stubClipboard(page);
  const app = await boot(page);
  await page.locator('#mode-analysis').click();
  await expect(page.locator('#analysis-controls')).toBeVisible();
  await page.locator('#analysis-pgn').fill('1. e4 e5 2. Nf3');
  await page.locator('#load-analysis').click();
  await expect(page.locator('#analysis-controls')).toHaveCount(0);
  await app.reply(0, 'b8c6', 200, [{ move: 'b8c6', prob: .4 }, { move: 'g8f6', prob: .15 }]);
  await expect(page.locator('section[aria-label="Maia analysis"] .candidate-reading')).toHaveText(['Nc640%', 'Nf615%']);
  await expect(page.locator('.win-hero')).toHaveCount(0);
  await expect(page.locator('section[aria-label="Maia analysis"] .candidate-list')).toContainText('Nc6');
  await expect(page.locator('.balance-track')).toHaveAccessibleName(/estimated White winning chance 52%/);
  await page.getByRole('button', { name: 'Explore Nf6' }).hover();
  await expect(page.locator('#board svg.cg-shapes line[stroke="#d6b85c"]')).toHaveCount(1);
  await piece(page, 'g8', 'black knight');
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 4');
  await expect(page.locator('section[aria-label="Maia analysis"] .candidate-list')).toContainText('Nc6');
  await screenshot(page, testInfo.outputPath('analysis-candidates-desktop.png'));
  await page.getByRole('button', { name: 'Explore Nf6' }).click();
  await piece(page, 'f6', 'black knight');
  await expect(page.locator('#insight-content')).toHaveCount(0);
  await expect(page.locator('#board svg.cg-shapes line[stroke="#d6b85c"]')).toHaveCount(0);
  await move(page, 'f1', 'c4');
  // Either branch move can win the 200ms foreground race. A parked
  // intermediate tip holds the single Maia lane (the fixture holds routes
  // open), so answer held requests until the tip fires.
  const full = ['e2e4', 'e7e5', 'g1f3', 'g8f6', 'f1c4'];
  const replied = new Set([0]);
  let tip = -1;
  for (let waited = 0; waited < 100 && tip < 0; waited++) {
    const last = app.requests.at(-1);
    if (last && last.payload.moves.join() === full.join()) { tip = app.requests.length - 1; break; }
    const pending = app.requests.findIndex((_, index) => !replied.has(index));
    if (pending >= 0) { replied.add(pending); await app.reply(pending); }
    else await page.waitForTimeout(100);
  }
  expect(tip).toBeGreaterThanOrEqual(1);
  expect(replay(app.requests[tip].payload.moves).fen()).toBe(app.requests[tip].payload.fen);
  await app.reply(tip, 'b8c6');
  await expect(page.locator('#analysis-rating')).toBeVisible();
  await page.locator('#analysis-rating').selectOption('2000');
  await expect(page.locator('#insight-content')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Maia • 2000', exact: true })).toBeVisible();
  await expect(page.locator('#analysis-rating')).toHaveValue('2000');
  await expect.poll(() => app.requests.length).toBe(tip + 2);
  expect(app.requests[tip + 1].payload).toMatchObject({ elo_maia: 2000, elo_user: 2000 });
  for (const [id, expected] of [['copy-pgn', '1. e4 e5 2. Nf3'], ['copy-explored-pgn', '1. e4 e5 2. Nf3 Nf6 3. Bc4']]) {
    await page.locator(`#${id}`).click();
    await expect(page.locator(`#${id}`)).toHaveText(/copied/i);
    await expect.poll(() => copiedTexts(page)).toContain(expected);
  }
  await page.locator('#return-original').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 4');
  await piece(page, 'g8', 'black knight');
  await page.locator('#mode-play').click();
  await expect(page.locator('.player-strip').filter({ hasText: 'Maia' })).toContainText('1600');
  expect(app.errors).toEqual([]);
});

test('history review, resume, copy, delete, and just-finished game review', async ({ page }) => {
  await stubClipboard(page);
  const mate = record(['f2f3', 'e7e5', 'g2g4', 'd8h4'], 'white', 'mate');
  const unfinished = record(['e2e4', 'e7e5'], 'white', 'unfinished');
  const app = await boot(page, { [KEYS.current]: mate, [KEYS.saved]: [mate, unfinished] });
  await expect(page.locator('.game-result')).toContainText('Black wins');
  await expect(page.locator('.board-stage.game-over .game-result .side-dot.black')).toHaveCount(1);
  await expect(page.locator('.board-stage.game-over')).toHaveCount(1);
  await page.getByRole('button', { name: 'Review game' }).click();
  await expect(page).toHaveURL('http://maia.test/analyze?moves=f2f3,e7e5,g2g4,d8h4');
  await expect(page.locator('#analysis-controls')).toHaveCount(0);
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  await page.locator('#mode-history').click();
  const cards = page.locator('.saved-game');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('White · Maia 1600');
  await expect(cards.first().getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await cards.first().getByRole('button', { name: 'Copy PGN' }).click();
  await expect(page.locator('.saved-panel [role="status"]')).toHaveText('PGN copied to clipboard');
  await expect.poll(() => copiedTexts(page)).toContain('Qh4#');
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
  await page.locator('.saved-game .saved-open').click();
  await expect(page).toHaveURL('http://maia.test/analyze?moves=d2d4,d7d5');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  // Arrow keys on the rating select must not step the board.
  await page.locator('#analysis-rating').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  // The Analyze tab returns to the importer instead of reopening the line.
  await page.locator('#mode-analysis').click();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await expect(page.locator('#analysis-pgn')).toBeVisible();
  await page.locator('#analysis-pgn').fill('1. e4');
  await page.locator('#load-analysis').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 2');
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-controls').getByRole('button', { name: 'Starting position', exact: true }).click();
  await page.locator('#load-analysis').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 1 / 1');
  await expect.poll(() => app.requests.length).toBeGreaterThan(0);
  if (app.requests[0].payload.moves.length) await app.reply(0);
  const currentIndex = app.requests[0].payload.moves.length ? 1 : 0;
  await app.reply(currentIndex, 'e2e4');
  await expect(page.locator('.win-hero')).toHaveCount(0);
  await expect(page.locator('section[aria-label="Maia analysis"] .candidate-list')).toContainText('e4');
});

test('tapping a history game opens its analysis', async ({ page }) => {
  const app = await boot(page, { [KEYS.saved]: [record(['e2e4', 'e7e5'], 'white', 'g1')] });
  await page.locator('#mode-history').click();
  await expect(page.locator('.saved-game')).toHaveCount(1);
  await page.locator('.saved-game .saved-open').click();
  await expect(page).toHaveURL('http://maia.test/analyze?moves=e2e4,e7e5');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await piece(page, 'e5', 'black pawn');
  expect(app.errors).toEqual([]);
});

test('new analysis and the Analyze tab return to the importer', async ({ page }) => {
  const app = await boot(page);
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-pgn').fill('1. e4 e5');
  await page.locator('#load-analysis').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await page.getByRole('button', { name: 'New analysis', exact: true }).click();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await expect(page.locator('#analysis-controls')).toBeVisible();
  await expect(page.locator('#analysis-index')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#analysis-controls')).toBeVisible();
  await expect(page.locator('#analysis-index')).toHaveCount(0);
  await page.locator('#analysis-pgn').fill('1. e4');
  await page.locator('#load-analysis').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 2');
  await page.locator('#mode-analysis').click();
  await expect(page).toHaveURL('http://maia.test/analyze');
  await expect(page.locator('#analysis-controls')).toBeVisible();
  expect(app.errors).toEqual([]);
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
    const toolbarBoxes = await page.locator('.board-actions button, .nav-buttons button').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top }; }));
    for (const box of toolbarBoxes) {
      expect(box.width).toBe(40); expect(box.height).toBe(40);
      expect(box.top).toBe(toolbarBoxes[0].top);
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

for (const width of [320, 390]) {
  test(`compact analysis variation notation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await boot(page, {}, false, '/analyze?moves=e2e4,e7e5,g1f3,b8c6,f1b5,a7a6');
    await page.locator('#analysis-first').click();
    await page.locator('#analysis-next').click();
    await move(page, 'c7', 'c5');
    await move(page, 'g1', 'f3');
    await expect(page.getByLabel('Original line', { exact: true })).toContainText('e5');
    const variation = page.getByLabel('Explored variation', { exact: true });
    await expect(variation).toContainText('c5');
    await expect(variation).toContainText('Nf3');
    await variation.getByRole('button', { name: /c5/ }).click();
    await piece(page, 'c5', 'black pawn');
    await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 4');
    await page.locator('#analysis-next').click();
    await piece(page, 'f3', 'white knight');
    await expect(page.locator('.move-cell[aria-current]')).toBeInViewport();
    await expect(page.locator('.branch-point > button')).toHaveCount(1);
    const origin = (await page.locator('.branch-point > button').boundingBox())!;
    const branch = (await variation.boundingBox())!;
    const continuation = (await page.locator('.original-move').first().boundingBox())!;
    expect(branch.y).toBeGreaterThanOrEqual(origin.y + origin.height);
    expect(branch.x).toBeGreaterThan(origin.x);
    expect(continuation.y).toBe(origin.y);
    const toolbar = await page.locator('.move-navigation button').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { y: r.y, width: r.width, height: r.height }; }));
    for (const box of toolbar) { expect(box.y).toBe(toolbar[0].y); expect(box.width).toBe(40); expect(box.height).toBe(40); }
    await expect(page.locator('#insight-title #analysis-rating')).toBeVisible();
    await expect(page.locator('#analysis-rating')).toHaveAccessibleName('Maia rating');
    await expect(page.locator('.insight-panel summary')).toHaveCount(0);
    await expect(page.getByText('Original', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Exploring', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Unreviewed', { exact: false })).toHaveCount(0);
    await expect(page.locator('.selected-quality, .quality-unreviewed')).toHaveCount(0);
    await expect(page.locator('.tab-action').getByRole('button', { name: 'Analyze explored line' })).toBeVisible();
    const tabRow = await page.locator('.analysis-tabs [role="tab"], .tab-action button').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { y: r.y, height: r.height }; }));
    expect(tabRow).toHaveLength(3);
    expect(Math.max(...tabRow.map(r => r.y))).toBeLessThan(Math.min(...tabRow.map(r => r.y + r.height)));
    const ratingBox = (await page.locator('#analysis-rating').boundingBox())!;
    expect(ratingBox.height).toBeLessThanOrEqual(32);
    const engines = (await page.locator('.engine-duo').boundingBox())!;
    const exports = (await page.locator('.analysis-actions').boundingBox())!;
    expect(exports.y).toBeGreaterThanOrEqual(engines.y + engines.height);
    await expect(page.locator('.board-stage .analysis-actions')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Stockfish/ })).toHaveCount(1);
    await expect(page.getByText('Engine moves', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`variation-${width}.png`), fullPage: true });
    await page.locator('#return-original').click();
    await expect(variation).toHaveCount(0);
    await page.locator('#analysis-next').click();
    await piece(page, 'e5', 'black pawn');
  });
}

for (const originPly of [0, 9, 12]) {
  test(`variation is inserted at its origin ply ${originPly}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await boot(page, {}, false, '/analyze?moves=e2e4,e7e5,g1f3,b8c6,f1b5,a7a6,b5a4,g8f6,e1g1,f8e7,f1e1,b7b5');
    await page.locator('#analysis-first').click();
    for (let index = 0; index < originPly; index++) await page.locator('#analysis-next').click();
    await move(page, originPly === 9 ? 'd7' : 'd2', originPly === 9 ? 'd6' : 'd4');
    const variation = page.getByLabel('Explored variation', { exact: true });
    await expect(variation).toBeVisible();
    await expect(page.locator('.move-cell[aria-current]')).toBeInViewport();
    const placement = await variation.evaluate(el => {
      const group = el.parentElement!;
      const before = []; let sibling = group.previousElementSibling;
      while (sibling) { before.push(sibling.tagName); sibling = sibling.previousElementSibling; }
      if (el.previousElementSibling) before.push(el.previousElementSibling.tagName);
      const after = []; sibling = group.nextElementSibling;
      while (sibling) { after.push(sibling.className); sibling = sibling.nextElementSibling; }
      return { before, after, top: el.getBoundingClientRect().top, parentBottom: el.previousElementSibling?.getBoundingClientRect().bottom, tailTop: group.nextElementSibling?.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom };
    });
    expect(placement.before).toEqual(Array(originPly).fill('BUTTON'));
    expect(placement.after).toHaveLength(12 - originPly);
    for (const cls of placement.after) expect(cls).toContain('original-move');
    if (placement.parentBottom !== undefined) expect(placement.top).toBeGreaterThanOrEqual(placement.parentBottom);
    if (placement.tailTop !== undefined) expect(placement.tailTop).toBeLessThan(placement.top);
    await page.screenshot({ path: info.outputPath(`branch-origin-${originPly}.png`), fullPage: true });
    await page.locator('#analysis-prev').click();
    await expect(page.locator('#analysis-index')).toHaveText(`Position ${originPly + 1} / ${originPly + 2}`);
    await page.locator('#analysis-next').click();
    await expect(page.locator('.variation-line .move-cell')).toHaveAttribute('aria-current', 'step');
  });
}

test('tapping an original move after the branch exits the branch', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await boot(page, {}, false, '/analyze?moves=e2e4,e7e5,g1f3,b8c6,f1b5,a7a6');
  await page.locator('#analysis-first').click();
  await page.locator('#analysis-next').click();
  await move(page, 'c7', 'c5');
  await expect(page.getByLabel('Explored variation', { exact: true })).toBeVisible();
  await expect(page.locator('#return-original')).toBeVisible();
  await page.locator('.original-move').first().click();
  await expect(page.getByLabel('Explored variation', { exact: true })).toHaveCount(0);
  await expect(page.locator('#return-original')).toHaveCount(0);
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 7');
  await piece(page, 'e5', 'black pawn');
  await page.locator('#analysis-next').click();
  await piece(page, 'f3', 'white knight');
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 7');
});

test('analysis keeps one scrolling main row and adds height only for a branch', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await boot(page, {}, false, '/analyze?moves=e2e4,e7e5,g1f3,b8c6,f1b5,a7a6,b5a4,g8f6,e1g1,f8e7,f1e1,b7b5');
  const list = page.locator('#move-list');
  const height = await list.evaluate(el => el.clientHeight);
  expect(height).toBe(40);
  expect(await list.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  const rows = await list.locator('.move-cell').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().y));
  expect(new Set(rows).size).toBe(1);
  await page.locator('#analysis-first').click();
  await page.locator('#analysis-next').click();
  await expect(page.locator('.move-cell[aria-current]')).toBeInViewport();
  await page.locator('#analysis-last').click();
  await expect(page.locator('.move-cell[aria-current]')).toBeInViewport();
  await page.locator('#analysis-first').click();
  for (const [from, to] of [['d2', 'd4'], ['d7', 'd5'], ['c2', 'c4'], ['e7', 'e6'], ['b1', 'c3'], ['g8', 'f6'], ['c1', 'g5'], ['f8', 'e7'], ['e2', 'e3'], ['e8', 'g8']]) await move(page, from, to);
  expect(await list.evaluate(el => el.clientHeight)).toBe(height + 32);
  const mainRows = await list.locator('.original-move').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().y));
  const branchRows = await list.locator('.variation-line .move-cell').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().y));
  expect(new Set(mainRows).size).toBe(1);
  expect(new Set(branchRows).size).toBe(1);
  expect(branchRows[0]).toBe(mainRows[0] + 32);
  await expect(page.locator('.move-cell[aria-current]')).toBeInViewport();
  await page.locator('#analysis-first').click();
  await page.locator('#analysis-next').click();
  await expect(page.locator('.move-cell[aria-current]')).toBeInViewport();
  await page.locator('#analysis-last').click();
  await expect(page.locator('.move-cell[aria-current]')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('horizontal-variation.png'), fullPage: true });
  await page.locator('#return-original').click();
  expect(await list.evaluate(el => el.clientHeight)).toBe(height);
});

test('complete game navigation keeps board size stable', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mate = record(['f2f3', 'e7e5', 'g2g4', 'd8h4'], 'white', 'mate');
  await boot(page, { [KEYS.current]: mate, [KEYS.saved]: [mate] });
  await expect(page.locator('.game-result')).toBeVisible();
  const size = () => page.locator('#board').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
  const tip = await size();
  await page.locator('#analysis-prev').click();
  await expect(page.getByRole('button', { name: 'Return to game' })).toBeVisible();
  expect(await size()).toEqual(tip);
  await page.locator('#analysis-first').click();
  expect(await size()).toEqual(tip);
  await page.locator('#analysis-last').click();
  expect(await size()).toEqual(tip);
});

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
  await page.getByRole('button', { name: 'Explore e4' }).tap();
  await piece(page, 'e4', 'white pawn');
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 2');
  expect(app.errors).toEqual([]);
  await context.close();
});

test('resign ends the game, persists, and hides resume', async ({ page }) => {
  const app = await boot(page);
  await move(page, 'e2', 'e4');
  await app.reply(0, 'e7e5');
  await piece(page, 'e5', 'black pawn');
  await page.locator('#resign').click();
  await page.locator('#confirm-resign').click();
  await expect(page.locator('.game-result')).toContainText('Black wins · resignation');
  await expect(page.locator('#resign')).toHaveCount(0);
  await expect(page.locator('#takeback')).toBeDisabled();
  await move(page, 'd2', 'd4');
  expect(await currentMoves(page)).toEqual(['e2e4', 'e7e5']);
  await page.locator('#mode-history').click();
  const card = page.locator('.saved-game').first();
  await expect(card).toContainText('Black wins · resignation');
  await expect(card.getByRole('button', { name: 'Resume' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.saved-game').first()).toContainText('Black wins · resignation');
  await page.locator('#mode-play').click();
  await expect(page.locator('.game-result')).toContainText('Black wins · resignation');
  expect(app.errors).toEqual([]);
});
