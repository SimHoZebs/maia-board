import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { replay } from '../src/domain';
import { cacheHash, reviewKey } from '../src/reviewCoordinator';
import { stockfishPolicy } from '../src/stockfishSettings';

// Regression for the duplicated-Stockfish-rows bug: a cached evaluation whose
// ranks echo one first move (b8c6 twice at ply 3) must be rejected into a
// miss, heal through live re-inference, and never strand a ghost row in the
// candidate list when navigating back to ply 6.
const MOVES = ['e2e4', 'e7e5', 'f2f3', 'b8c6', 'f1b5', 'g8f6'];
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const POLICY = 'sf19-ms750-mpv4-d0-t1-h64-v2';
const line = (move: string, value: number) => ({ move, score: { type: 'cp', value }, depth: 12 });
const sfRow = (lines: { move: string; score: { type: string; value: number }; depth: number }[]) => ({
  engine: 'Stockfish 19', search_policy: POLICY, depth: 12, terminal: null,
  best_move: lines[0].move, score: lines[0].score, lines,
});

test('duplicate stockfish ranks heal and never ghost', async ({ page }) => {
  const settings = { eloMaia: 1600, eloUser: 1600, model: '79m' as const, stockfish: { time_ms: 750, lines: 4, depth: 0 } };
  if (stockfishPolicy(settings.stockfish) !== POLICY) throw new Error('policy drift');
  const server = new Map<string, { engine: string; value: unknown }>();
  const seed = (engine: 'sf' | 'maia', slice: string[], value: unknown) => {
    const node = { initialFen: START, moves: slice, fen: replay(slice).fen() };
    server.set(cacheHash(reviewKey(engine, node, settings)), { engine, value });
  };
  // Ply 3 as the worker once persisted it: ranks 3 and 4 both b8c6.
  seed('sf', MOVES.slice(0, 3), sfRow([line('g8f6', -92), line('f8c5', -88), line('b8c6', -65), line('b8c6', -65)]));
  // Ply 6 clean, exactly as cached in production.
  seed('sf', MOVES.slice(0, 6), sfRow([line('g1e2', -37), line('b5c6', -76), line('d2d3', -84), line('b1c3', -91)]));
  await page.route('http://maia.test/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/evaluations/coverage') {
      const rows: Record<string, unknown> = {};
      for (const hash of url.searchParams.getAll('hash')) {
        const hit = server.get(hash);
        if (hit) rows[hash] = { engine: hit.engine, value: hit.value };
      }
      await route.fulfill({ json: { rows } });
      return;
    }
    if (path.startsWith('/evaluations/')) {
      const hash = path.slice('/evaluations/'.length);
      if (route.request().method() === 'PUT') {
        const put = route.request().postDataJSON();
        server.set(hash, { engine: put.engine, value: put.value });
        await route.fulfill({ json: { key_hash: hash, engine: put.engine, created_at: 'now' } });
        return;
      }
      const hit = server.get(hash);
      if (hit) await route.fulfill({ json: { key_hash: hash, engine: hit.engine, value: hit.value, created_at: 'now' } });
      else await route.fulfill({ status: 404, json: { code: 'not_found', message: 'missing' } });
      return;
    }
    if (path === '/move' || path === '/evaluate') {
      const payload = route.request().postDataJSON();
      if (path === '/move') {
        const fetched = payload.moves as string[];
        const move = fetched.length ? fetched[fetched.length - 1] : 'e2e4';
        await route.fulfill({ json: { move, top_moves: [{ move, prob: 0.6 }], wdl: [0.2, 0.3, 0.5], model_used: '79m', degraded: false } });
        return;
      }
      // Fixed-worker behavior: distinct first moves, best first.
      const legal = replay(payload.moves, payload.initial_fen).moves({ verbose: true })
        .map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
      const preferred = ['e2e4', 'e7e5', 'f2f3', 'b8c6', 'f1b5', 'g8f6'][payload.moves.length];
      const best = legal.includes(preferred) ? preferred : legal[0];
      const rest = legal.filter(move => move !== best).slice(0, 3);
      const values = [20, 0, -20, -40];
      const lines = [best, ...rest].map((move, index) => line(move, values[index]));
      await route.fulfill({ json: sfRow(lines) });
      return;
    }
    if (path === '/games' || path.startsWith('/games/')) {
      await route.fulfill({ json: { games: [], current_id: null, total: 0 } });
      return;
    }
    const filename = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    await route.fulfill({ body: await readFile(resolve('dist-browser', filename)), contentType: filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('maia.stockfish.v1', JSON.stringify({ time_ms: 750, lines: 4, depth: 0 }));
  });
  await page.goto(`http://maia.test/analyze?moves=${MOVES.join(',')}`);
  const sfRows = page.locator('section[aria-label="Stockfish evaluation"] li');
  const texts = () => sfRows.evaluateAll(els => els.map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim()));
  // Ply 6 primes clean from cache.
  await expect.poll(texts, { timeout: 60000 }).toEqual(['1Ne2-0.37', '2Bxc6-0.76', '3d3-0.84', '4Nc3-0.91']);
  // Ply 3's duplicated row is rejected into a miss, then heals live: four
  // distinct ranks, exactly one played marker.
  await page.locator('.move-cell').nth(2).click();
  await expect.poll(texts, { timeout: 60000 }).toHaveLength(4);
  expect(await sfRows.evaluateAll(els => els.map(el => el.querySelector('.rank')?.textContent))).toEqual(['1', '2', '3', '4']);
  expect(await sfRows.evaluateAll(els => els.filter(el => el.classList.contains('played')).length)).toBe(1);
  // Back at ply 6: still exactly the four clean rows, no ghost fifth.
  await page.locator('.move-cell').nth(5).click();
  await expect.poll(texts, { timeout: 60000 }).toEqual(['1Ne2-0.37', '2Bxc6-0.76', '3d3-0.84', '4Nc3-0.91']);
});
