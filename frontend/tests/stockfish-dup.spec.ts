import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { replay } from '../src/domain';
import { EvaluationFixture } from './evaluation-fixture';
import { stockfishPolicy } from '../src/stockfishSettings';

// Regression for the duplicated-Stockfish-rows bug: a cached evaluation whose
// ranks echo one first move must be rejected into a miss, heal through live
// re-inference, and never strand a ghost row in the candidate list.
// Seeded positions are focus-relative: the panel judges the displayed move
// from its before-position, so poison sits at ply 2 (shown when viewing ply
// 3) and the clean row at ply 5 (shown at the tip).
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
  const server = new EvaluationFixture();
  const seed = (engine: 'sf' | 'maia', slice: string[], value: unknown) => {
    const body = { initial_fen: START, moves: slice, fen: replay(slice).fen(), settings: settings.stockfish, elo_maia: settings.eloMaia, elo_user: settings.eloUser, model: settings.model };
    server.set(engine, body, value);
  };
  // Ply 2 as the worker once persisted it: ranks 3 and 4 echo one move.
  // The panel judges the displayed move from its before-position, so the
  // seeded positions are focus-relative: poison at ply 2 (shown when
  // viewing ply 3), clean at ply 5 (shown at the tip).
  seed('sf', MOVES.slice(0, 2), sfRow([line('g1f3', -92), line('f1c4', -88), line('d2d4', -65), line('d2d4', -65)]));
  // Ply 5 clean, exactly as cached in production.
  seed('sf', MOVES.slice(0, 5), sfRow([line('a8b8', -37), line('d8e7', -76), line('d8f6', -84), line('e8e7', -91)]));
  await page.route('http://maia.test/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (await server.lookup(route)) return;
    if (path === '/move' || path === '/evaluate') {
      const payload = route.request().postDataJSON();
      if (path === '/move') {
        const candidate = replay(payload.moves, payload.initial_fen).moves({ verbose: true })[0];
        const move = `${candidate.from}${candidate.to}${candidate.promotion ?? ''}`;
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
  // Tip view shows the focus (ply 5) rows, primed clean from cache.
  await expect.poll(texts, { timeout: 60000 }).toEqual(['1Rb8-0.37', '2Qe7-0.76', '3Qf6-0.84', '4Ke7-0.91']);
  // Ply 3's view shows focus ply 2, whose duplicated row is rejected into a
  // miss, then heals live: four distinct ranks, exactly one played marker.
  await page.locator('.move-cell').nth(2).click();
  await expect.poll(texts, { timeout: 60000 }).toHaveLength(4);
  expect(await sfRows.evaluateAll(els => els.map(el => el.querySelector('.rank')?.textContent))).toEqual(['1', '2', '3', '4']);
  expect(await sfRows.evaluateAll(els => els.filter(el => el.classList.contains('played')).length)).toBe(1);
  // Back at the tip: still exactly the four clean rows, no ghost fifth.
  await page.locator('.move-cell').nth(5).click();
  await expect.poll(texts, { timeout: 60000 }).toEqual(['1Rb8-0.37', '2Qe7-0.76', '3Qf6-0.84', '4Ke7-0.91']);
});
