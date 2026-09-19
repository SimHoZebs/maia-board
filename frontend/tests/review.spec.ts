import { test, expect, type Page, type Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { replay } from '../src/domain';
import { defaultStockfishSettings, stockfishPolicy } from '../src/stockfishSettings';
const SEARCH_POLICY = stockfishPolicy(defaultStockfishSettings);
import { KEYS } from '../src/storage';
import { EvaluationFixture, evaluationIdentity } from './evaluation-fixture';

async function bootReview(page: Page, pgn = '1. e4 e5 2. Nf3 Nc6', scores = [20,20,200,-700,-680]) {
  const requests: { engine: string; moves: string[]; initial_fen: string; elo_maia?: number }[] = [];
  const cache = new EvaluationFixture();
  const evaluations = cache.entries;
  const errors: string[] = [];
  // Fake review-batch server: accept the submitted items and immediately
  // report a finished job, filing computed values for every submitted item
  // into the lookup cache first — mirroring the backend, which files batch
  // results into its eval cache so the post-batch prime resolves by lookup.
  // Without that filing, finished batches would leave every position missing
  // and no test could observe a settled line.
  const batches = new Map<string, { total: number; requests: any[]; filed: boolean }>();
  let batchSeq = 0;
  // Best-move selection shared by both engines: stay on the main test
  // line while it is legal, else fall back to the first legal move. The
  // /move branch historically shares this preferred override (not raw
  // moves[0]); keep it so mocked Maia play follows the PGN under test.
  const bestMove = (payload: any) => {
    const game = replay(payload.moves, payload.initial_fen);
    const legal = game.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
    const preferred = ['e2e4', 'e7e5', 'g1f3', 'b8c6'][payload.moves.length];
    return legal.includes(preferred) ? preferred : legal[0];
  };
  const maiaValue = (payload: any) => {
    const best = bestMove(payload);
    const game = replay(payload.moves, payload.initial_fen);
    const legal = game.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
    const second = legal.find(move => move !== best) ?? best;
    const extra = second === best ? [] : [{ move: second, prob: .25, wdl: [.2,.3,.5] }];
    return { move: best, top_moves: [{ move: best, prob: .6, wdl: [.2,.3,.5] }, ...extra], wdl: [.2,.3,.5], model_used: payload.model, degraded: false };
  };
  // Objective (2400) lane: same PGN-following top as the display lane
  // while the PGN move holds (mover loss < 5), diverging to the first
  // legal sidestep exactly where the score drops — the same threshold the
  // grades use, so blunder/mistake coverage follows the `scores` array
  // without a third fixture axis. The PGN move always stays listed so
  // "(played)" markers and branch exploration keep working; every entry
  // carries the position WDL (per-move WDLs are a server detail).
  const gradeValue = (payload: any) => {
    const game = replay(payload.moves, payload.initial_fen);
    const legal = game.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
    const pgn = bestMove(payload);
    const ply = payload.moves.length;
    const whiteWin = (cp: number) => 100 / (1 + Math.exp(-0.00368208 * cp));
    const moverExp = (cp: number) => game.turn() === 'w' ? whiteWin(cp) : 100 - whiteWin(cp);
    const loss = Math.max(0, moverExp(scores[ply] ?? 0) - moverExp(scores[ply + 1] ?? scores[ply] ?? 0));
    const cp = scores[ply] ?? 0;
    const white = whiteWin(cp);
    const win = (game.turn() === 'w' ? white : 100 - white) / 100;
    const wdl: [number, number, number] = [1 - win, 0, win];
    if (loss >= 5) {
      const top = legal.find(move => move !== pgn) ?? legal[0];
      // Single-legal-move positions (forced): no second entry, or the
      // duplicate-move validation rejects the row.
      const entries = top === pgn
        ? [{ move: top, prob: .6, wdl }]
        : [{ move: top, prob: .5, wdl }, { move: pgn, prob: .3, wdl }];
      return { move: top, top_moves: entries, wdl, model_used: '79m', degraded: false };
    }
    const second = legal.find(move => move !== pgn) ?? pgn;
    const extra = second === pgn ? [] : [{ move: second, prob: .25, wdl }];
    return { move: pgn, top_moves: [{ move: pgn, prob: .6, wdl }, ...extra], wdl, model_used: '79m', degraded: false };
  };
  const maiaOrGrade = (payload: any) => payload.elo_maia === 2400 ? gradeValue(payload) : maiaValue(payload);
  const sfValue = (payload: any) => {
    const game = replay(payload.moves, payload.initial_fen);
    const legal = game.moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
    const best = bestMove(payload);
    const score = { type: 'cp', value: scores[payload.moves.length] ?? 0 };
    return {
      engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12 + payload.moves.length, terminal: null, best_move: best, score,
      lines: [{ move: best, score, depth: 12 + payload.moves.length }, ...legal.filter(move => move !== best).slice(0, 1).map(move => ({ move, score: { type: 'cp', value: game.turn() === 'w' ? -500 : 500 }, depth: 12 + payload.moves.length }))],
    };
  };
  const fileBatch = (jobId: string) => {
    const job = batches.get(jobId);
    if (!job || job.filed) return;
    job.filed = true;
    for (const request of job.requests) {
      cache.set(request.engine, request, request.engine === 'maia' ? maiaOrGrade(request) : sfValue(request));
    }
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('http://maia.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // Empty book: in-book moves would render a chip in the badge box
    // instead of a quality badge, so the fixture names nothing and every
    // move shows its verdict.
    if (path === '/openings') {
      const moves = route.request().postDataJSON()?.moves;
      await route.fulfill({ json: { matches: [], book_flags: Array.isArray(moves) ? moves.map(() => false) : [] } });
      return;
    }
    const method = route.request().method();
    if (await cache.lookup(route)) return;
    if (path === '/reviews' && method === 'POST') {
      const body = route.request().postDataJSON();
      const requests = Array.isArray(body?.requests) ? body.requests : [];
      const jobId = `mock-batch-${++batchSeq}`;
      batches.set(jobId, { total: requests.length, requests, filed: false });
      await route.fulfill({ json: { job_id: jobId, total: requests.length, cached: 0, pending: requests.length } });
      return;
    }
    if (path.startsWith('/reviews/')) {
      const segments = path.slice('/reviews/'.length).split('/');
      const job = batches.get(segments[0]);
      if (job === undefined) { await route.fulfill({ status: 404, body: '' }); return; }
      fileBatch(segments[0]);
      const progress = { job_id: segments[0], total: job.total, done: job.total, failed: 0, cancelled: false, finished: true };
      if (segments[1] === 'events') {
        await route.fulfill({ body: `data: ${JSON.stringify({ progress })}\n\n`, contentType: 'text/event-stream' });
        return;
      }
      await route.fulfill({ json: progress });
      return;
    }
    if (path === '/move' || path === '/move/analysis' || path === '/evaluate') {
      const payload = route.request().postDataJSON(); requests.push({ engine: path, ...payload });
      const engine = path === '/evaluate' ? 'sf' : 'maia';
      // Read-through emulation: serve a matching stored row, else compute
      // live and file it, mirroring the backend contract.
      const hit = cache.get(engine, payload);
      if (hit) {
        await route.fulfill({ json: hit.value, headers: { 'X-Eval-Cache': 'hit' } });
        return;
      }
      const value = path === '/evaluate' ? sfValue(payload) : maiaOrGrade(payload);
      cache.set(engine, payload, value);
      await route.fulfill({ json: value }); return;
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
  // Fresh contexts default to past arrows; seed next so this fixture keeps
  // exercising next-mode rendering (the unit test pins the past default,
  // and the basis test below covers both modes explicitly).
  await page.addInitScript(() => localStorage.setItem('maia-board.arrow-basis.v1', '"next"'));
  await page.goto('http://maia.test/analyze');
  await page.locator('#analysis-pgn').fill(pgn);   await page.locator('#load-analysis').click();
  return { requests, errors, evaluations, batches };
}
const lines = (page: Page) => page.locator('#board svg.cg-shapes line');
test('standalone FEN shows current candidates and clears correct-frame previews', async ({ page }) => {
  const app = await bootReview(page);
  const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 23';
  await page.goto(`http://maia.test/analyze?fen=${encodeURIComponent(fen)}`);
  await expect(page.locator('#analysis-index')).toHaveText('Position 1 / 1');
  const maia = page.getByRole('region', { name: 'Maia analysis', exact: true });
  await expect(maia.getByRole('button', { name: 'Explore e4', exact: true })).toBeVisible();
  const candidate = maia.getByRole('button', { name: 'Explore e3', exact: true });
  await expect(maia.getByRole('button').first()).toBeVisible();
  const preview = page.locator('#board svg.cg-shapes line[stroke="#d6b85c"]');
  await candidate.hover();
  await expect(preview).toHaveCount(1);
  await page.locator('.brand').hover();
  await expect(preview).toHaveCount(0);
  await candidate.focus();
  await expect(preview).toHaveCount(1);
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).focus();
  await expect(preview).toHaveCount(0);
  await maia.getByRole('button', { name: 'Explore e4', exact: true }).click();
  await expect(page.locator('.move-cell')).toContainText('23. e4');
  await expect(maia.getByRole('button', { name: 'Explore e4 (played) from before this move', exact: true })).toBeVisible();
  await maia.getByRole('button').first().hover();
  await expect(preview).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test('root shows the fallback notice without model parameters', async ({ page }) => {
  const app = await bootReview(page);
  await page.route('http://maia.test/move**', route => {
    const body = route.request().postDataJSON();
    const move = replay(body.moves, body.initial_fen).moves({ verbose: true })[0];
    const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
    return route.fulfill({ json: { move: uci, top_moves: [{ move: uci, prob: .13, wdl: [.2,.3,.5] }], wdl: [.2,.3,.5], model_used: '5m', degraded: true } });
  });
  await page.goto('http://maia.test/analyze?moves=');
  await expect(page.locator('#objective-rating')).toHaveValue('2400');
  await expect(page.locator('section[aria-label="Maia analysis"]').getByText('Maia fallback results.', { exact: true })).toBeVisible();
  await expect(page.getByText('Maia3 fallback results.', { exact: true })).toBeVisible();
  expect(app.errors).toEqual([]);
});

test('adjacent backward navigation animates and loaded positions start settled', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await bootReview(page);
  await expect(page.locator('#board piece.anim')).toHaveCount(0);
  const animated = await page.evaluate(async () => {
    document.querySelector<HTMLButtonElement>('#analysis-prev')!.click();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return document.querySelectorAll('#board piece.anim').length;
  });
  expect(animated).toBeGreaterThan(0);
  await expect(page.locator('#board piece.anim')).toHaveCount(0);
  await page.goto('http://maia.test/analyze?moves=d2d4,d7d5');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 3');
  await expect(page.locator('#board piece.anim')).toHaveCount(0);
});
async function atStart(page: Page) {
  await page.locator('#analysis-first').click();
  await expect(lines(page)).toHaveCount(3);
}
test('automatic review shows real overlapping SVG arrows', async ({ page }, info) => {
  const app = await bootReview(page); await atStart(page);
  const strokes = async () => lines(page).evaluateAll(elements => elements.map(el => ({ color: el.getAttribute('stroke'), opacity: el.getAttribute('opacity'), width: el.getAttribute('stroke-width'), from: [el.getAttribute('x1'), el.getAttribute('y1')], to: [el.getAttribute('x2'), el.getAttribute('y2')] })));
  const arrows = await strokes();
  expect(arrows.map(arrow => arrow.color)).toEqual(['#ffffff','#ef4444','#3b82f6']);
  expect(arrows.map(arrow => arrow.width)).toEqual(['0.1875','0.125','0.0625']);
  expect(arrows.map(arrow => arrow.opacity)).toEqual(['0.45','0.45','0.45']);
  expect(arrows.every(arrow => JSON.stringify(arrow.from) === JSON.stringify(arrows[0].from) && JSON.stringify(arrow.to) === JSON.stringify(arrows[0].to))).toBe(true);
  await expect(lines(page)).toHaveCount(3);
  // Analysis board defaults to auto orientation (reviewed side at bottom, white here) with no flip button.
  await expect(page.locator('#flip-board')).toHaveCount(0);
  await expect(page.locator('#board .cg-wrap')).toHaveClass(/orientation-white/);
  await page.locator('.insight-panel').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('coincident-arrows.png'), fullPage: true });
  expect(app.errors).toEqual([]);
  // Display + grading lanes each fetch the root once in the foreground.
  expect(app.requests.filter(request => (request.engine === '/move' || request.engine === '/move/analysis') && request.moves.length === 0)).toHaveLength(2);
});
test('whole game completes independently of viewing and updates the position balance', async ({ page }, info) => {
  // Book chips would occupy the badge boxes on this all-book line (see
  // badge-loading.spec.ts): the fixture names nothing so verdicts render.
  const app = await bootReview(page, '1. e4 e5 2. Nf3 Nc6', [20,20,200,-700,-680]);
  await expect(page.locator('.balance-white-tag')).toHaveText('8%');
  await expect(page.locator('.balance-black-tag')).toHaveText('92%');
  await expect(page.locator('.balance-draw-tag')).toHaveCount(0);
  // The charts shell mounts pre-analysis (lines stay empty until verdicts
  // settle); only the hero must stay absent before the review runs.
  await expect(page.locator('.win-hero')).toHaveCount(0);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await page.locator('#analysis-first').click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  // Top verdicts now grade 'Best' (engine top choice), not 'Great': the
  // Sep-15 verdict rework reserves Great for near-best non-best moves.
  await expect(page.locator('.move-cell .quality-best')).toHaveCount(2);
  await expect(page.locator('.move-cell .quality-mistake')).toHaveCount(1);
  await expect(page.locator('.move-cell .quality-blunder')).toHaveCount(1);
  // Viewing must not infer: capture the foreground count before navigating
  // and require it unchanged after. (A fixed count would encode the focus
  // window; the batch covers the rest server-side now.)
  const inferred = () => app.requests.filter(request => request.engine === '/evaluate').length;
  const settled = inferred();
  await page.locator('.move-cell').nth(2).click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('.balance-white-tag')).toHaveText('7%');
  await expect(page.locator('.balance-black-tag')).toHaveText('93%');
  await expect(page.locator('.balance-draw-tag')).toHaveCount(0);
  await expect(page.locator('.balance-track')).toHaveAccessibleName(/White 7%.*Draw 0%.*Black 93%.*estimated White winning chance 7%/);
  await page.locator('.insight-panel').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('completed-review.png'), fullPage: true });
  expect(app.errors).toEqual([]);
  expect(inferred()).toBe(settled);
});
for (const width of [320, 1440]) {
  test(`analysis container spaces both sides of section dividers at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await bootReview(page);
    for (const tab of ['Move analysis', 'Moves to review']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      const sections = await page.locator('.insight-panel > .analysis-tabs:visible, .insight-panel > .analysis-section:visible').evaluateAll(elements => elements.map(el => {
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        return { top: rect.top, bottom: rect.bottom, border: parseFloat(style.borderTopWidth), contentTop: el.firstElementChild!.getBoundingClientRect().top };
      }));
      expect(sections).toHaveLength(3);
      for (let index = 1; index < sections.length; index++) {
        expect(sections[index].border).toBe(1);
        expect(sections[index].top - sections[index - 1].bottom).toBeCloseTo(12, 0);
        expect(sections[index].contentTop - sections[index].top - sections[index].border).toBeCloseTo(12, 0);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`analysis-spacing-${width}-${tab.replace(' ', '-')}.png`), fullPage: true });
    }
  });
}

test('move analysis summarizes the game below the engines and links mistakes from moves to review', async ({ page }, info) => {
  const app = await bootReview(page);
  await expect(page.locator('#objective-rating')).toHaveValue('2400');
  await expect(page.getByRole('tabpanel', { name: 'Move analysis', exact: true })).toBeVisible();
  await expect(page.locator('.overview-partial')).toContainText('Summary covers reviewed moves only');
  await expect(page.getByRole('region', { name: 'White move quality', exact: true })).toBeVisible();
  await expect(page.locator('.accuracy-value')).toHaveCount(0);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.locator('.review-coverage')).toHaveCount(0);
  await expect(page.locator('.overview-partial')).toHaveCount(0);
  await expect(page.locator('.quality-counts li')).toHaveCount(18);
  await expect(page.locator('.accuracy-summary')).not.toContainText('You');
  await page.getByRole('tab', { name: 'Moves to review', exact: true }).click();
  await expect(page.locator('.review-issue')).toHaveCount(2);
  await page.screenshot({ path: info.outputPath('overview-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review 2. Nf3 · White · Blunder', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('#insight-content').getByRole('button', { name: 'Explore Nf3 (played) from before this move', exact: true })).toBeVisible();
  await expect(page.locator('.balance-white-tag')).toHaveText('7%');
  await expect(page.locator('.balance-black-tag')).toHaveText('93%');
  await expect(page.locator('.balance-draw-tag')).toHaveCount(0);
  expect(app.errors).toEqual([]);
});

test('tabs support keyboard navigation without stepping the board and link inaccuracies on mobile', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const app = await bootReview(page, '1. e4 e5 2. Nf3 Nc6', [0,0,100,0,0]);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  // Quiescence: the foreground pair-ensure drains against batch filing in a
  // ~40ms race window, so capture the baseline only after the inference
  // count settles (stable across 3x200ms). Intent unchanged: tabbing itself
  // must issue nothing.
  let settled = -1, stableRounds = 0;
  while (stableRounds < 3) {
    await page.waitForTimeout(200);
    const count = app.requests.length;
    if (count === settled) stableRounds++;
    else { settled = count; stableRounds = 0; }
  }
  const before = app.requests.length;
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Moves to review', exact: true })).toBeFocused();
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  await expect(page.locator('.review-issue')).toHaveCount(2);
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Moves to review', exact: true })).toBeFocused();
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  expect(app.requests).toHaveLength(before);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('overview-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Review 1… e5 · Black · Inaccuracy', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Move analysis', exact: true })).toBeVisible();
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('#insight-content').getByRole('button', { name: 'Explore e5 (played) from before this move', exact: true })).toBeVisible();
  expect(app.errors).toEqual([]);
});

test('moves to review distinguishes empty games, no issues, and explored lines', async ({ page }) => {
  await bootReview(page, '1. e4 e5', [0,0,0]);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await page.getByRole('tab', { name: 'Moves to review', exact: true }).click();
  await expect(page.getByText('No inaccuracies, mistakes, blunders, or allowed mates found.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).click();
  const board = (await page.locator('#board cg-board').boundingBox())!;
  await page.mouse.click(board.x + board.width * 3.5 / 8, board.y + board.height * 6.5 / 8);
  await page.mouse.click(board.x + board.width * 3.5 / 8, board.y + board.height * 4.5 / 8);
  await page.getByRole('tab', { name: 'Moves to review', exact: true }).click();
  await expect(page.locator('.tab-action').getByRole('button', { name: 'Analyze explored line' })).toBeVisible();
  // No return button: step back to the fork, then Next continues original.
  await page.locator('#analysis-prev').click();
  await page.locator('#analysis-next').click();
  await expect(page.getByLabel('Explored variation', { exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Game overview' })).toBeVisible();
  await page.getByRole('tab', { name: 'Moves to review', exact: true }).click();
  await expect(page.getByText('No inaccuracies, mistakes, blunders, or allowed mates found.', { exact: true })).toBeVisible();
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-pgn').fill('1. d4');
  await page.locator('#load-analysis').click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.locator('#mode-analysis').click();
  await page.locator('#analysis-controls').getByRole('button', { name: 'Starting position', exact: true }).click();
  await page.locator('#load-analysis').click();
  await page.getByRole('tab', { name: 'Move analysis', exact: true }).click();
  await expect(page.getByText('Play or load some moves to see a move summary.', { exact: true })).toBeVisible();
  await expect(page.locator('.accuracy-value')).toHaveCount(0);
});

for (const width of [1440, 360]) test(`move analysis restores evaluation graph at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const app = await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Evaluation graph', exact: true })).toBeVisible();
  await expect(page.locator('.chart-line')).toHaveCount(4);
  await expect(page.locator('.chart-point:disabled')).toHaveCount(0);
  await expect(page.locator('.chart-dot-mistake')).toHaveCount(1);
  await expect(page.locator('.chart-dot-blunder')).toHaveCount(1);
  await expect(page.locator('.chart-point').nth(3)).toHaveAccessibleName(/2\. Nf3 · White.*White winning chance.*Blunder/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`overview-graphs-${width}.png`), fullPage: true });
  await page.locator('.chart-point').nth(3).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('.review-charts')).toHaveCount(1);
  await expect(page.locator('.chart-point[aria-current="step"]')).toHaveAccessibleName(/2\. Nf3/);
  await expect(page.getByRole('tab', { name: 'Move accuracy', exact: true })).toHaveCount(0);
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('.chart-point').nth(4)).toHaveAccessibleName(/2… Nc6 · Black.*7\.6% White winning chance.*Best/);
  await page.locator('.chart-point').nth(4).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 5 / 5');
  await expect(page.locator('.balance-white-tag')).toHaveText('8%');
  await expect(page.locator('.balance-black-tag')).toHaveText('92%');
  await expect(page.locator('.balance-draw-tag')).toHaveCount(0);
  await expect(page.locator('.chart-point[aria-current="step"]')).toHaveAccessibleName(/2… Nc6/);
  expect(app.errors).toEqual([]);
});

test('move analysis graphs leave unreviewed positions as gaps', async ({ page }) => {
  await bootReview(page);
  await expect(page.locator('#objective-rating')).toHaveValue('2400');
  await expect(page.getByRole('region', { name: 'Evaluation graph', exact: true })).toBeVisible();
  await expect(page.locator('.chart-point i')).toHaveCount(2);
  await expect(page.locator('.chart-line')).toHaveCount(1);
  await expect(page.locator('.chart-point').nth(2).locator('i')).toHaveCount(0);
});

test('move analysis shows only your moves with your decision points on the graphs', async ({ page }) => {
  const app = await bootReview(page);
  await page.evaluate(key => {
    const snapshot = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ ...snapshot, ownGame: true, perspective: 'black' }));
  }, KEYS.snapshot);
  await page.reload();
  await expect(page.locator('.accuracy-card')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Black move quality · You', exact: true })).toContainText('Black move quality · You');
  await expect(page.getByRole('region', { name: 'White move quality', exact: true })).toHaveCount(0);
  await expect(page.locator('.quality-counts li')).toHaveCount(9);
  await expect(page.locator('.chart-point i')).toHaveCount(1);
  await expect(page.locator('.chart-point:disabled')).toHaveCount(0);
  await expect(page.locator('.chart-line')).toHaveCount(0);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await expect(page.locator('.quality-counts li')).toHaveCount(9);
  await page.getByRole('tab', { name: 'Moves to review', exact: true }).click();
  await expect(page.locator('.review-issue')).toHaveCount(1);
  await expect(page.locator('.issue-move small')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review 1… e5 · Black · You · Mistake', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Move analysis', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('.chart-point i')).toHaveCount(2);
  await expect(page.locator('.chart-line')).toHaveCount(1);
  expect(await page.locator('.chart-point span').allTextContents()).toEqual(['1…', '2…']);
  await expect(page.locator('.chart-point i')).toHaveCount(2);
  await expect(page.locator('.chart-line')).toHaveCount(1);
  expect(await page.locator('.chart-point span').allTextContents()).toEqual(['1…', '2…']);
  await expect(page.locator('.chart-point:disabled')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Black move quality · You', exact: true })).toContainText('Black move quality · You');
  expect(app.errors).toEqual([]);
});

test('analysis tabs stay visible while panel content scrolls', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  const tabs = page.getByRole('tablist', { name: 'Game analysis views', exact: true });
  const before = await tabs.boundingBox();
  await page.locator('#analysis-panel-moves').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => page.locator('#analysis-panel-moves').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await tabs.boundingBox()).toEqual(before);
  await expect(tabs).toBeInViewport();
});

test('unlisted played moves have no fallback below either prediction list', async ({ page }) => {
  await bootReview(page, '1. d4 d5');
  // Step to the position after the played move: the panel judges d4 from its
  // before-position, where the top predictions genuinely exclude it.
  await page.locator('#analysis-first').click();
  await page.locator('#analysis-next').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 3');
  await expect(page.locator('#insight-content .candidate-list')).toContainText('e4');
  await expect(page.locator('.engine-duo')).not.toContainText('Played d4');
  await expect(page.locator('.engine-duo .candidate-list')).not.toContainText(['d4', 'd4']);
});

test('checkmate fills the bar for the winning side', async ({ page }) => {
  await bootReview(page, '1. f3 e5 2. g4 Qh4#');
  await expect(page.locator('.balance-track')).toHaveAccessibleName('Black wins · White 0% · Draw 0% · Black 100% · estimated White winning chance 0%');
  await expect(page.locator('.balance-white')).toHaveCSS('height', '0px');
});

test('blunder and mistake destinations carry board badges', async ({ page }) => {
  await bootReview(page);
  await page.locator('#analysis-first').click();
  await page.locator('#analysis-next').click();
  await page.locator('#analysis-next').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('#board').getByText('?', { exact: true })).toBeVisible();
  await page.locator('#analysis-next').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 4 / 5');
  await expect(page.locator('#board').getByText('??', { exact: true })).toBeVisible();
});
test('server-cached positions skip inference after reload', async ({ page }) => {
  const app = await bootReview(page);
  await expect(page.locator('#objective-rating')).toHaveValue('2400');
  // Both engines at the before/current pair must finish before reloading:
  // fast+full Stockfish plus display and grading Maia rows.
  await expect.poll(() => app.evaluations.size).toBe(8);
  const calls = app.requests.length;
  await page.reload();
  // The loaded line restores from the snapshot with the import panel closed;
  // cached positions resolve without new inference.
  await expect(page.locator('#objective-rating')).toHaveValue('2400');
  await expect(page.locator('.candidate-list li')).not.toHaveCount(0);
  expect(app.requests).toHaveLength(calls);
  expect(app.errors).toEqual([]);
});
test('completed analysis restores automatically across reload without inference', async ({ page }) => {
  const app = await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  const inferred = () => app.requests.filter(request => request.engine === '/move' || request.engine === '/move/analysis' || request.engine === '/evaluate').length;
  // Settle first: foreground prime trails the instant-mock batch by design
  // (priority-lane delay), so a synchronous request count here would race
  // it. Rendered candidates prove values landed; the count below only needs
  // to be unchanged by the reload, whatever foreground fired pre-reload.
  await expect(page.locator('.candidate-list li').first()).toBeVisible();
  const before = inferred();
  await page.reload();
  // No click: the fresh record primes itself from the server eval cache.
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await expect(page.locator('.candidate-list li').first()).toBeVisible();
  expect(inferred()).toBe(before);
});
test('partially evicted analysis restores cached positions and gates the rest', async ({ page }) => {
  const app = await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  // Evict every Maia row server-side: Stockfish stays cached.
  const evicted = [...app.evaluations].filter(([, entry]) => entry.engine === 'maia').map(([hash]) => hash);
  expect(evicted.length).toBeGreaterThan(0);
  for (const hash of evicted) app.evaluations.delete(hash);
  const inferred = (engine: string) => app.requests.filter(request => request.engine === engine).length;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Analyze entire game' })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /of \d+ positions cached/ })).toHaveCount(0);
  // Quiescence: the mount pair-ensure peeks full-row coverage at +200ms
  // against the instant prime filing it — order decides whether the viewed
  // pair's fast row fetches live. Wait past the debounce for prime coverage
  // (candidates prove the viewed pair landed) so the measured window starts
  // settled; intent unchanged (resubmit must cover evicted Maia rows with
  // zero new Stockfish inference).
  await expect(page.locator('.candidate-list li').first()).toBeVisible();
  await page.waitForTimeout(600);
  const evalsBefore = inferred('/evaluate');
  const jobsBefore = app.batches.size;
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  // Every evicted Maia position is gated behind the new batch: the fresh
  // submit must cover each evicted row (foreground only primes the viewed
  // position, so per-request inference is the wrong place to look for them).
  // Set membership instead of exact counts: the insight single and the
  // foreground may legitimately re-request the viewed position alongside the
  // batch, so duplicates are allowed but omissions are not.
  const resubmitted = new Set(
    [...app.batches.values()].slice(jobsBefore)
      .flatMap(job => job.requests)
      .map(request => evaluationIdentity(request.engine, request)),
  );
  expect(evicted.every(hash => resubmitted.has(hash))).toBe(true);
  expect(inferred('/evaluate') - evalsBefore).toBe(0);
});
test('changed analysis settings gate the missing positions behind a new batch', async ({ page }) => {
  await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await expect(page.locator('#analysis-rating')).toBeVisible();
  await page.locator('#analysis-rating').selectOption('1800');
  await expect(page.getByRole('button', { name: 'Analyze entire game' })).toBeVisible();
  // No parallel record layer remains: completion derives from cached rows, so
  // no record banner can appear for the previous settings.
  await expect(page.locator('.analysis-record')).toHaveCount(0);
});
test('mixed arrow sources retain their own endpoints', async ({ page }, info) => {
  await bootReview(page);
  // Display Maia and objective (2400) lanes share /move/analysis: split by elo so the
  // white actual, red display, and blue objective arrows diverge.
  await page.route('http://maia.test/move**', route => {
    const body = route.request().postDataJSON();
    const move = body?.elo_maia === 2400 ? 'd2d4' : 'g1f3';
    return route.fulfill({ json: { move, top_moves: [{ move, prob: .6, wdl: [.2,.3,.5] }], wdl: [.2,.3,.5], model_used: '79m', degraded: false } });
  });
  await atStart(page);
  const endpoints = await lines(page).evaluateAll(elements => elements.map(el => `${el.getAttribute('x1')},${el.getAttribute('y1')}:${el.getAttribute('x2')},${el.getAttribute('y2')}`));
  expect(new Set(endpoints).size).toBe(3);
  // Arrows project forward from the viewed position, but the panel judges the
  // displayed move from its before-position: step forward to read predictions.
  await page.locator('#analysis-next').click();
  await expect(page.locator('#objective-rating')).toHaveValue('2400');
  await expect(page.locator('.insight-panel')).toContainText('Nf3');
  await page.locator('.insight-panel').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ path: info.outputPath('mixed-arrows.png'), fullPage: true });
});
test('current position balance replaces the win-rate sections', async ({ page }) => {
  await bootReview(page);
  await expect(page.locator('.balance-white-tag')).toHaveText('8%');
  await expect(page.locator('.balance-black-tag')).toHaveText('92%');
  await expect(page.locator('.balance-draw-tag')).toHaveCount(0);
  // The evaluation graph lives in Move analysis now, so the section
  // renders before any review — the foreground pair settles one segment
  // immediately (dot coverage is asserted in the gaps test below).
  await expect(page.locator('.win-hero')).toHaveCount(0);
  await expect(page.locator('.chart-line')).toHaveCount(1);
  await expect(page.getByText('Unreviewed', { exact: false })).toHaveCount(0);
  await expect(page.locator('[title*="Unreviewed"], [aria-label*="Unreviewed"], .quality-unreviewed')).toHaveCount(0);
});
test('analysis progress replaces the analyze button while running without a cancel option', async ({ page }) => {
  await bootReview(page);
  await expect(page.locator('#objective-rating')).toHaveValue('2400');
  // Hold the batch event stream AND the status endpoint open: the client
  // reconciles from ground-truth status on mount (not just live ticks), so
  // holding the stream alone no longer keeps the job observably running —
  // the instant-mock status would finish it first. Holding both keeps the
  // submit-time optimism ("Analyzing 0 of N…") on screen deterministically
  // instead of racing the instant-mock finish. (Holding foreground fetches
  // cannot stall a server batch; whole-game inference runs server-side now.)
  const heldEvents: Route[] = [];
  const heldStatus: Route[] = [];
  await page.route('http://maia.test/reviews/*/events', route => { heldEvents.push(route); });
  await page.route(url => {
    if (url.host !== 'maia.test') return false;
    const segments = url.pathname.slice('/reviews/'.length).split('/');
    return url.pathname.startsWith('/reviews/') && segments.length === 1 && segments[0].length > 0;
  }, route => { heldStatus.push(route); });
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect.poll(() => heldEvents.length).toBeGreaterThan(0);
  await expect.poll(() => heldStatus.length).toBeGreaterThan(0);
  await expect(page.locator('.tab-action').getByRole('status')).toHaveText(/Analyzing \d+ of \d+…/);
  await expect(page.getByRole('button', { name: 'Analyze entire game' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel analysis' })).toHaveCount(0);
  for (const route of heldStatus) {
    const match = /\/reviews\/([^/]+)$/.exec(new URL(route.request().url()).pathname);
    const progress = { job_id: match?.[1] ?? 'mock-batch-1', total: 10, done: 10, failed: 0, cancelled: false, finished: true };
    await route.fulfill({ json: progress });
  }
  for (const route of heldEvents) {
    const match = /\/reviews\/([^/]+)\/events/.exec(route.request().url());
    const progress = { job_id: match?.[1] ?? 'mock-batch-1', total: 10, done: 10, failed: 0, cancelled: false, finished: true };
    await route.fulfill({ body: `data: ${JSON.stringify({ progress })}\n\n`, contentType: 'text/event-stream' });
  }
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await expect(page.locator('.tab-action').getByRole('status')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel analysis' })).toHaveCount(0);
});
for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 360, height: 800 }, { width: 390, height: 844 }]) {
  test(`review geometry, arrows and balance ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport); await bootReview(page); await atStart(page);
    await page.getByRole('button', { name: 'Analyze entire game' }).click();
    await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.insight-panel')!.scrollTop = 0; });
    const box = (await page.locator('#board').boundingBox())!;
    expect(box.width).toBeGreaterThan(300); expect(box.width).toBeCloseTo(box.height, 0);
    for (const rect of await page.locator('.player-strip, .move-navigation, .board-actions').evaluateAll(elements => elements.map(el => { const rect = el.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom }; }))) {
      expect(rect.top).toBeGreaterThanOrEqual(0); expect(rect.bottom).toBeLessThanOrEqual(viewport.height);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const row = await page.locator('.analysis-tabs [role="tab"], .tab-action button').evaluateAll(elements => elements.map(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    expect(Math.max(...row.map(r => r.top))).toBeLessThan(Math.min(...row.map(r => r.bottom)));
    const bar = (await page.locator('.balance-track').boundingBox())!;
    expect(bar.height).toBeGreaterThan(bar.width * 5);
    const squares = (await page.locator('#board cg-board').boundingBox())!;
    expect(bar.x).toBeCloseTo(squares.x + squares.width, 0);
    expect(bar.y).toBeCloseTo(squares.y, 0);
    expect(bar.height).toBeCloseTo(squares.height, 0);
    const white = (await page.locator('.balance-white').boundingBox())!;
    expect(white.y + white.height).toBeCloseTo(bar.y + bar.height, 0);
    // Analysis board defaults to auto orientation (reviewed side at bottom, white here) with no flip button.
    await expect(page.locator('#flip-board')).toHaveCount(0);
    await expect(page.locator('#board .cg-wrap')).toHaveClass(/orientation-white/);
    await page.screenshot({ path: info.outputPath(`review-${viewport.width}.png`), fullPage: true });
  });
}
test('evaluation bar follows rendered board dimensions on resize and fractional pixel density', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1103, height: 857 }, deviceScaleFactor: 1.25 });
  const page = await context.newPage();
  await bootReview(page);
  for (const viewport of [{ width: 1103, height: 857 }, { width: 393, height: 851 }, { width: 1281, height: 901 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const board = (await page.locator('#board cg-board').boundingBox())!;
      const bar = (await page.locator('.balance-track').boundingBox())!;
      return Math.max(Math.abs(bar.x - board.x - board.width), Math.abs(bar.y - board.y), Math.abs(bar.height - board.height));
    }).toBeLessThan(.1);
  }
  await context.close();
});

test('terminal repetition skips Maia and keeps the local draw result', async ({ page }) => {
  const app = await bootReview(page, '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8');
  await expect(page.locator('.balance-track')).toHaveAccessibleName('Draw · White 0% · Draw 100% · Black 0% · estimated White winning chance 50%');
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Cancel analysis' })).toHaveCount(0);
  expect(app.requests.some(request => request.moves.length === 8)).toBe(false);
});
test('touch move selection updates the position balance', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); await bootReview(page);
  await page.getByRole('button', { name: 'Analyze entire game' }).tap();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  await page.locator('.move-cell').nth(0).tap();
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 5');
  await page.locator('.move-cell').nth(1).tap();
  await expect(page.locator('#analysis-index')).toHaveText('Position 3 / 5');
  await expect(page.locator('#board svg.cg-shapes line')).toHaveCount(3);
  await context.close();
});
test('explored branches keep the original line badges', async ({ page }) => {
  const app = await bootReview(page, '1. e4 e5 2. Nf3 Nc6', [20,20,200,-700,-680]);
  await page.getByRole('button', { name: 'Analyze entire game' }).click();
  await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled();
  // Mainline badges settled: two Best, one Mistake, one Blunder.
  await expect(page.locator('.move-cell .quality-best')).toHaveCount(2);
  // Branch from the root via the second Maia candidate.
  await page.locator('#analysis-first').click();
  await expect(page.locator('#analysis-index')).toHaveText('Position 1 / 5');
  const candidates = page.locator('section[aria-label="Maia analysis"] li:not(.candidate-header) .candidate-reading');
  await expect(candidates).toHaveCount(2);
  await candidates.nth(1).click();
  await expect(page.locator('.original-move')).toHaveCount(4);
  // The continuation keeps every badge it showed on the mainline.
  await expect(page.locator('.original-move .quality-best')).toHaveCount(2);
  await expect(page.locator('.original-move .quality-mistake')).toHaveCount(1);
  await expect(page.locator('.original-move .quality-blunder')).toHaveCount(1);
  expect(app.errors).toEqual([]);
});
for (const bit of [0, 1]) test(`random side resolves once with crypto bit ${bit}`, async ({ page }) => {
  await page.addInitScript(bit => { let calls = 0; crypto.getRandomValues = ((array: Uint32Array) => { calls++; array[0] = bit; (window as any).randomSideCalls = calls; return array; }) as typeof crypto.getRandomValues; }, bit);
  await bootReview(page); await page.locator('#mode-play').click();
  await page.getByRole('radio', { name: 'Random' }).check();
  await page.locator('#start-game').click();
  await expect(page.locator('#board .cg-wrap')).toHaveClass(new RegExp(`orientation-${bit ? 'black' : 'white'}`));
  await page.locator('#new-game').click(); await page.getByRole('radio', { name: 'Random' }).check();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).randomSideCalls)).toBe(1);
  await expect.poll(() => page.evaluate(key => {
    const raw = localStorage.getItem(key);
    const settings = raw ? JSON.parse(raw) : null;
    return typeof settings?.userColor === 'string' ? settings.userColor : null;
  }, KEYS.settings)).toBe(bit ? 'black' : 'white');
});
test('custom arrow colors and widths repaint shafts and heads', async ({ page }) => {
  const app = await bootReview(page); await atStart(page);
  const strokes = () => lines(page).evaluateAll(elements => elements.map(el => ({ color: el.getAttribute('stroke'), width: el.getAttribute('stroke-width') })));
  await expect.poll(async () => (await strokes()).length).toBe(3);
  expect(await strokes()).toEqual([
    { color: '#ffffff', width: '0.1875' },
    { color: '#ef4444', width: '0.125' },
    { color: '#3b82f6', width: '0.0625' },
  ]);
  // Seed custom arrows (width 64 = full square => stroke-width 1) and reload:
  // the board remounts with fresh marker defs, so shafts and heads agree.
  await page.evaluate(key => {
    localStorage.setItem(key, JSON.stringify({
      actual: { color: '#00ff00', width: 64 },
      maia: { color: '#ff00ff', width: 32 },
      objective: { color: '#0000ff', width: 16 },
      candidate: { color: '#d6b85c', width: 2 },
    }));
  }, KEYS.arrows);
  await page.reload();
  await expect(page.locator('#analysis-index')).toHaveText('Position 1 / 5');
  await expect.poll(async () => (await strokes()).length).toBe(3);
  expect(await strokes()).toEqual([
    { color: '#00ff00', width: '1' },
    { color: '#ff00ff', width: '0.5' },
    { color: '#0000ff', width: '0.25' },
  ]);
  const heads = await page.locator('#board svg.cg-shapes defs marker path').evaluateAll(elements => elements.map(el => el.getAttribute('fill')));
  expect(heads).toEqual(expect.arrayContaining(['#00ff00', '#ff00ff', '#0000ff']));
  // Settings controls reflect and persist the seeded values.
  await page.locator('#mode-settings').click();
  await expect(page.locator('#arrow-maia-color')).toHaveValue('#ff00ff');
  await expect(page.locator('#arrow-actual-width')).toHaveValue('64');
  await page.locator('#arrow-objective-width-number').fill('20');
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).objective.width, KEYS.arrows)).toBe(20);
  await page.reload();
  await expect(page.locator('#arrow-objective-width-number')).toHaveValue('20');
  expect(app.errors).toEqual([]);
});
test('past arrow basis shows prior-move options and persists', async ({ page }) => {
  const app = await bootReview(page); await atStart(page);
  const endpoints = () => lines(page).evaluateAll(elements => elements.map(el => `${el.getAttribute('x1')},${el.getAttribute('y1')}:${el.getAttribute('x2')},${el.getAttribute('y2')}`));
  // Next-move basis at the root projects the first-move options.
  await expect.poll(async () => (await endpoints()).length).toBe(3);
  const nextRoot = await endpoints();
  // Past-move basis at the root has no prior move, so no arrows.
  await page.locator('#mode-settings').click();
  await page.locator('div[role="radiogroup"][aria-labelledby="arrows-basis-label"] label', { hasText: 'Past move' }).click();
  await expect(page.locator('#arrow-basis-past')).toBeChecked();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), 'maia-board.arrow-basis.v1')).toBe('"past"');
  await page.goBack();
  await expect(lines(page)).toHaveCount(0);
  // Step forward: past arrows show the e2e4 options from the before-position,
  // which differ from the next-move e7e5 projections at the same ply.
  await page.locator('#analysis-next').click();
  await expect.poll(async () => (await endpoints()).length).toBe(3);
  const pastPly1 = await endpoints();
  await page.evaluate(() => localStorage.setItem('maia-board.arrow-basis.v1', '"next"'));
  await page.reload();
  await expect(page.locator('#analysis-index')).toHaveText('Position 2 / 5');
  await expect.poll(async () => (await endpoints()).length).toBe(3);
  const nextPly1 = await endpoints();
  // Past ply-1 options all follow the played e2e4 (no loss there), while the
  // next-move projections at ply 1 include the objective sidestep. Past at
  // ply 1 matches next at the root: the same e2e4 decision.
  expect(new Set(pastPly1).size).toBe(1);
  expect(pastPly1).not.toEqual(nextPly1);
  expect(pastPly1).toEqual(nextRoot);
  // Basis setting survives reload.
  await page.locator('#mode-settings').click();
  await expect(page.locator('#arrow-basis-next')).toBeChecked();
  expect(app.errors).toEqual([]);
});
