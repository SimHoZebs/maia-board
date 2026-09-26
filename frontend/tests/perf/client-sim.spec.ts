import { test, expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';
import { replay } from '../../src/domain';
import { EvaluationFixture } from '../evaluation-fixture';
import { defaultStockfishSettings, stockfishPolicy } from '../../src/stockfishSettings';

const SEARCH_POLICY = stockfishPolicy(defaultStockfishSettings);
// Seeded random client: same seed replays the same line, so runs are
// comparable over time. Defaults target a 40-ply line: long enough
// that batch time, scrub latency, and move-list/chart render cost show
// scaling pressure, short enough to finish in ~1 minute on simulated
// inference. PERF_PLIES up to 200 (batch cap is 256 plies); past ~80 plies
// the 4-minute test timeout may need a bump in playwright.perf.config.ts.
const SEED = Number(process.env.PERF_SEED || 1);
const TARGET_PLIES = Math.min(Number(process.env.PERF_PLIES || 40), 200);
const PLAY_MOVES = Number(process.env.PERF_PLAY_MOVES || 4);
const BUILD_DIR = process.env.MAIA_BUILD_DIR || 'dist-browser';
const MAIA_LIVE_MS = Number(process.env.PERF_MAIA_MS || 900);
const SF_LIVE_MS = Number(process.env.PERF_SF_MS || 750);
const CACHE_HIT_MS = Number(process.env.PERF_CACHE_MS || 25);
const EVAL_GET_MS = 15;

type NetRow = { engine: 'maia' | 'sf'; ply: number; cache: 'live' | 'hit'; simulatedMs: number; wallMs: number };
type StepRow = { step: string; ms: number };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Deterministic PRNG so a seed always deals the same line.
function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random legal line in UCI, stopping early only if the game actually ends.
function randomLine(seed: number, plies: number): string[] {
  const rng = mulberry32(seed);
  const game = new Chess();
  const moves: string[] = [];
  while (moves.length < plies && !game.isGameOver()) {
    const legal = game.moves({ verbose: true });
    const pick = legal[Math.floor(rng() * legal.length)];
    if (pick.promotion) game.move({ from: pick.from, to: pick.to, promotion: pick.promotion });
    else game.move({ from: pick.from, to: pick.to });
    moves.push(`${pick.from}${pick.to}${pick.promotion ?? ''}`);
  }
  return moves;
}

function lineToPgn(moves: string[]): string {
  const game = new Chess();
  for (const move of moves) {
    const from = move.slice(0, 2), to = move.slice(2, 4), promotion = move[4];
    if (promotion) game.move({ from, to, promotion });
    else game.move({ from, to });
  }
  const movetext = game.pgn().split('\n').filter(line => !line.startsWith('[') && line.trim() !== '').join(' ');
  return movetext.replace(/\s+(1-0|0-1|1\/2-1\/2|\*)\s*$/, '');
}

async function square(page: Page, key: string) {
  const board = page.locator('#board cg-board');
  await board.scrollIntoViewIfNeeded();
  const bounds = (await board.boundingBox())!;
  const black = await page.locator('#board .cg-wrap').evaluate(el => el.classList.contains('orientation-black'));
  const file = key.charCodeAt(0) - 97, rank = Number(key[1]) - 1;
  return { x: bounds.x + (black ? 7 - file + 0.5 : file + 0.5) * bounds.width / 8, y: bounds.y + (black ? rank + 0.5 : 7 - rank + 0.5) * bounds.height / 8 };
}

async function clickMove(page: Page, from: string, to: string) {
  const a = await square(page, from), b = await square(page, to);
  await page.mouse.click(a.x, a.y);
  await page.mouse.click(b.x, b.y);
}

async function storedMoves(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const repository = JSON.parse(localStorage.getItem('maia-board.games.v2') || 'null');
    return repository?.games.find((game: any) => game.id === repository.currentId)?.moves ?? [];
  });
}

test('client sim: boot, play, review batch, scrub, hover, branch, history', async ({ page }, testInfo) => {
  const steps: StepRow[] = [];
  const net: NetRow[] = [];
  const errors: string[] = [];
  // React commits per interaction: boot, deep-link boot, play moves, line
  // load, whole batch, scrub clicks, rating change, hover previews, branch
  // explore + scrub, history mount, saved-game review switch.
  // Counts test whether re-renders multiply; durations test whether each
  // render gets more expensive as the line grows.
  let bootCommits = 0;
  let bootCommitMs = 0;
  let bootSummary: Summary | null = null;
  let deepBootCommits = 0;
  let deepBootCommitMs = 0;
  let deepBootSummary: Summary | null = null;
  let lineLoadCommits = 0;
  let lineLoadCommitMs = 0;
  let lineLoadSummary: Summary | null = null;
  let ratingCommits = 0;
  let ratingCommitMs = 0;
  let ratingSummary: Summary | null = null;
  let exploreCommits = 0;
  let exploreCommitMs = 0;
  let exploreSummary: Summary | null = null;
  const branchScrubCommits: number[] = [];
  const branchScrubMs: number[] = [];
  const hoverCommits: number[] = [];
  const hoverCommitMs: number[] = [];
  let historyCommits = 0;
  let historyCommitMs = 0;
  let historySummary: Summary | null = null;
  let reviewSwitchCommits = 0;
  let reviewSwitchCommitMs = 0;
  let reviewSwitchSummary: Summary | null = null;
  let startCommits = 0;
  let startCommitMs = 0;
  let startSummary: Summary | null = null;
  const playCommits: number[] = [];
  const playCommitMs: number[] = [];
  const playBoardMs: number[] = [];
  const playSummaries: Summary[] = [];
  let batchCommits = 0;
  let batchCommitMs = 0;
  let batchBoardMs = 0;
  let batchInsightMs = 0;
  let batchSummary: Summary | null = null;
  const scrubCommits: number[] = [];
  const scrubCommitMs: number[] = [];
  const scrubBoardMs: number[] = [];
  const scrubInsightMs: number[] = [];
  const scrubSummaries: Summary[] = [];
  page.on('pageerror', error => errors.push(error.message));

  // Seeded saved games so the history surface renders a realistic list and
  // the review action can load one while a line is already open. Prefixes of
  // one legal Ruy Lopez line, so every game parses.
  const seedLine = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5', 'a4b3', 'd7d6', 'c2c3', 'e8g8', 'h2h3', 'c6a5', 'f3g5', 'a5b3', 'a2b3', 'h7h6', 'g5f3'];
  const seedDoc = {
    schema: 2,
    games: Array.from({ length: 25 }, (_, i) => ({
      id: `perf-seed-${i}`,
      createdAt: '2026-09-10T00:00:00Z',
      moves: seedLine.slice(0, 8 + (i % 16)),
      settings: { userColor: 'white', eloMaia: 1600, eloUser: 1600, model: '79m' },
    })),
    currentId: null, pending: [], recovery: [],
  };

  // Perf observers must install before any app code runs. Arming
  // `window.__perfCommits` also switches on the CommitRecorder profiler in
  // main.tsx; without it the app renders exactly as in production.
  await page.addInitScript((seed: unknown) => {
    (window as unknown as { __perfCommits: unknown[] }).__perfCommits = [];
    (window as unknown as { __perfLongtasks: unknown[] }).__perfLongtasks = [];
    (window as unknown as { __perfShifts: { value: number }[] }).__perfShifts = [];
    try { localStorage.setItem('maia-board.games.v2', JSON.stringify(seed)); } catch { /* private mode */ }
    (window as unknown as { __perfCommits: unknown[] }).__perfCommits = [];
    (window as unknown as { __perfLongtasks: unknown[] }).__perfLongtasks = [];
    (window as unknown as { __perfShifts: { value: number }[] }).__perfShifts = [];
    try {
      new PerformanceObserver(list => {
        (window as unknown as { __perfLongtasks: unknown[] }).__perfLongtasks.push(
          ...list.getEntries().map(e => ({ duration: e.duration, startTime: e.startTime, name: e.name })),
        );
      }).observe({ entryTypes: ['longtask'] });
    } catch { /* Chromium always has longtask; older builds skip */ }
    try {
      new PerformanceObserver(list => {
        (window as unknown as { __perfShifts: { value: number }[] }).__perfShifts.push(
          ...list.getEntries().map(e => ({ value: (e as unknown as { value: number }).value })),
        );
      }).observe({ entryTypes: ['layout-shift'], buffered: true } as PerformanceObserverInit);
    } catch { /* layout-shift optional */ }
  }, seedDoc);

  const timed = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try { return await fn(); }
    finally { steps.push({ step, ms: Date.now() - start }); }
  };

  // React commits since arming. Deltas around one interaction (plus a frame
  // settle) count the re-renders that interaction caused; summing
  // actualDuration over the same window measures how expensive they were.
  // (Durations are live on the profiling bundle the sim runs on.) Entries
  // carry the profiler id (`maia-board` root, `app` shell, `chrome`
  // header/controls, `board-stage`, `insight-panel`), so each window also attributes cost per
  // region. Region durations overlap their root commit: compare regions
  // against each other, never sum them.
  type CommitEntry = { id: string; ms: number };
  const commitSlice = (before: number): Promise<CommitEntry[]> =>
    page.evaluate((from) => {
      const log = (window as unknown as { __perfCommits?: { id: string; actualDuration: number }[] }).__perfCommits ?? [];
      return log.slice(from).map(c => ({ id: c.id, ms: Math.round((c.actualDuration || 0) * 10) / 10 }));
    }, before);
  // Navigation-safe variant: a full goto re-arms the log (addInitScript),
  // so a pre-goto mark can exceed the fresh log. A mark past the end means a
  // reset happened — everything in the log belongs to this navigation.
  const commitSliceReset = (before: number): Promise<CommitEntry[]> =>
    page.evaluate((from) => {
      const log = (window as unknown as { __perfCommits?: { id: string; actualDuration: number }[] }).__perfCommits ?? [];
      return log.slice(from <= log.length ? from : 0).map(c => ({ id: c.id, ms: Math.round((c.actualDuration || 0) * 10) / 10 }));
    }, before);
  const summarize = (slice: CommitEntry[]) => {
    const byId: Record<string, { count: number; ms: number }> = {};
    for (const c of slice) {
      const e = (byId[c.id] ??= { count: 0, ms: 0 });
      e.count++;
      e.ms = Math.round((e.ms + c.ms) * 10) / 10;
    }
    const pick = (id: string) => byId[id] ?? { count: 0, ms: 0 };
    return { byId, root: pick('maia-board'), app: pick('app'), chrome: pick('chrome'), board: pick('board-stage'), insight: pick('insight-panel') };
  };
  type Summary = ReturnType<typeof summarize>;
  // Average per-id render ms over a set of per-interaction summaries.
  const avgIdMs = (summaries: Summary[], id: 'app' | 'chrome' | 'board' | 'insight' | 'root') =>
    avg(summaries.map(s => s[id].ms));
  const commitMark = () =>
    page.evaluate(() => (window as unknown as { __perfCommits?: unknown[] }).__perfCommits?.length ?? 0);
  const settleFrames = () =>
    page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

  // Read-through backend emulation with simulated inference latency. Hits
  // answer in CACHE_HIT_MS with the X-Eval-Cache header; misses pay the
  // live budget and file the row, mirroring the Go contract.
  const evaluations = new EvaluationFixture();
  // Bulk line-oriented endpoints (current contract): the line ships once,
  // entries carry ply. Values are generated from the request FEN so every
  // row passes parseEvaluation/parseMoveResponse; rows cache by engine +
  // fen + settings so batch submit populates and lookup primes hit.
  let batchTotal = 0;
  const batchJobId = 'perf-job-1';
  let batchSubmitted = false;
  const bulkCache = new Map<string, unknown>();
  const bulkKey = (req: any) => JSON.stringify(req.engine === 'sf'
    ? ['sf', req.fen, req.settings ?? defaultStockfishSettings]
    : ['maia', req.fen, req.elo_maia, req.elo_user, req.model, req.value_elo_maia ?? null, req.value_elo_user ?? null]);
  const bulkValue = (req: any): unknown | null => {
    let legal: string[];
    try {
      legal = new Chess(req.fen).moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
    } catch { return null; }
    if (!legal.length) return null;
    if (req.engine === 'sf') {
      const settings = req.settings ?? defaultStockfishSettings;
      const count = Math.max(1, Math.min(settings.lines ?? 2, legal.length));
      const moves = legal.slice(0, count);
      const lines = moves.map((move: string, index: number) => ({ move, score: { type: 'cp', value: 20 - index * 10 }, depth: 12 }));
      return { engine: 'Stockfish 19', search_policy: stockfishPolicy(settings), terminal: null, depth: 12, best_move: lines[0].move, score: lines[0].score, lines };
    }
    const candidates = legal.slice(0, 2);
    return { move: candidates[0], top_moves: candidates.map(move => ({ move, prob: 0.3, wdl: [0.2, 0.3, 0.5] })), wdl: [0.2, 0.3, 0.5], model_used: req.model ?? '79m', degraded: false };
  };
  await page.route('http://maia.test/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/evaluations/lookup') {
      const body = route.request().postDataJSON();
      // Before the batch submit, report cache misses so the analysis page
      // stays in the pre-batch "Analyze entire game" state the sim clicks.
      // After submit, serve generated rows so the batch prime settles.
      if (!batchSubmitted) {
        await sleep(EVAL_GET_MS);
        await route.fulfill({ json: { results: [] } });
        return;
      }
      const requests = body?.requests ?? [];
      const results: { index: number; value: unknown }[] = [];
      for (let index = 0; index < requests.length; index++) {
        const req = requests[index];
        const key = bulkKey(req);
        let value = bulkCache.get(key);
        if (value === undefined) {
          const generated = bulkValue(req);
          if (generated === null) continue;
          bulkCache.set(key, generated);
          net.push({ engine: req.engine, ply: req.ply, cache: 'live', simulatedMs: req.engine === 'maia' ? MAIA_LIVE_MS : SF_LIVE_MS, wallMs: EVAL_GET_MS });
          value = generated;
        } else {
          net.push({ engine: req.engine, ply: req.ply, cache: 'hit', simulatedMs: CACHE_HIT_MS, wallMs: EVAL_GET_MS });
        }
        results.push({ index, value });
      }
      await sleep(EVAL_GET_MS);
      await route.fulfill({ json: { results } });
      return;
    }
    if (path === '/reviews' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      const requests = body?.requests ?? [];
      for (const req of requests) {
        const key = bulkKey(req);
        if (!bulkCache.has(key)) {
          const generated = bulkValue(req);
          if (generated !== null) bulkCache.set(key, generated);
        }
      }
      batchTotal = requests.length;
      batchSubmitted = true;
      await route.fulfill({ json: { job_id: batchJobId, total: requests.length, cached: 0, pending: requests.length }, status: 202 });
      return;
    }
    if (path === `/reviews/${batchJobId}/events`) {
      const progress = { job_id: batchJobId, total: batchTotal, done: batchTotal, failed: 0, finished: true };
      await route.fulfill({ body: `data: ${JSON.stringify({ progress })}\n\n`, contentType: 'text/event-stream' });
      return;
    }
    if (path === `/reviews/${batchJobId}`) {
      await route.fulfill({ json: { job_id: batchJobId, total: batchTotal, done: batchTotal, failed: 0, finished: true } });
      return;
    }
    if (path === '/openings') {
      const moves = route.request().postDataJSON()?.moves;
      await route.fulfill({ json: { matches: [], book_flags: Array.isArray(moves) ? moves.map(() => false) : [] } });
      return;
    }
    if (path === '/move' || path === '/move/analysis' || path === '/evaluate') {
      const payload = route.request().postDataJSON();
      const engine = path === '/evaluate' ? 'sf' : 'maia';
      const hit = evaluations.get(engine, payload);
      const wallStart = Date.now();
      if (hit) {
        await sleep(CACHE_HIT_MS);
        net.push({ engine, ply: payload.moves.length, cache: 'hit', simulatedMs: CACHE_HIT_MS, wallMs: Date.now() - wallStart });
        await route.fulfill({ json: hit.value, headers: { 'X-Eval-Cache': 'hit' } });
        return;
      }
      const liveMs = engine === 'maia' ? MAIA_LIVE_MS : SF_LIVE_MS;
      await sleep(liveMs);
      const game = replay(payload.moves, payload.initial_fen);
      const legal = game.moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
      const preferred = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'f1a4', 'g8f6'][payload.moves.length];
      const best = (preferred && legal.includes(preferred)) ? preferred : legal[0];
      // Mirror production: one row per legal move, at most two. Duplicating
      // the only legal move into a second rank trips the app's
      // duplicate-rank validation and fails the job (rightly).
      const sfMoves = [best, ...legal.filter(m => m !== best)].slice(0, 2);
      const value = engine === 'maia'
        ? { move: best, top_moves: [{ move: best, prob: 0.6, wdl: [0.2, 0.3, 0.5] }], wdl: [0.2, 0.3, 0.5], model_used: payload.model, degraded: false }
        : (() => {
            const settings = payload.settings ?? defaultStockfishSettings;
            const count = Math.max(1, Math.min(settings.lines ?? 2, sfMoves.length));
            const moves = sfMoves.slice(0, count);
            const lines = moves.map((move, index) => ({ move, score: { type: 'cp', value: index === 0 ? 20 : 0 }, depth: 12 }));
            return {
              engine: 'Stockfish 19', search_policy: stockfishPolicy(settings), depth: 12, terminal: null,
              best_move: lines[0].move, score: lines[0].score, lines,
            };
          })();
      evaluations.set(engine, payload, value);
      net.push({ engine, ply: payload.moves.length, cache: 'live', simulatedMs: liveMs, wallMs: Date.now() - wallStart });
      await route.fulfill({ json: value });
      return;
    }
    if (path === '/games' || path.startsWith('/games/')) {
      if (route.request().method() === 'GET' && path === '/games') {
        await route.fulfill({ json: { games: [], current_id: null, total: 0 } });
        return;
      }
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        await route.fulfill({ json: { ...body, created_at: 'now', updated_at: 'now' } });
        return;
      }
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    const filename = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    await route.fulfill({
      body: await readFile(resolve(BUILD_DIR, filename)),
      contentType: filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html',
    });
  });

  // 0. Deep-link boot: initialization with a line already in the URL (the
  // share-link path: timeline build + focus-fetch renders on first paint).
  // A full navigation resets the armed log, so the pre-goto mark (0 here)
  // doubles as the slice origin.
  const deepLine = randomLine(SEED ^ 0x51ab, 40);
  const deepPositions = deepLine.length + 1;
  await timed('analysis: deep-link boot (40-ply line)', async () => {
    const commitsBefore = await commitMark();
    await page.goto(`http://maia.test/analyze?moves=${deepLine.join(',')}`);
    await expect(page.locator('#analysis-index')).toHaveText(`Position ${deepPositions} / ${deepPositions}`, { timeout: 30_000 });
    await expect(page.locator('#insight-content')).toBeVisible({ timeout: 60_000 });
    await settleFrames();
    const stats = summarize(await commitSliceReset(commitsBefore));
    deepBootCommits = stats.root.count;
    deepBootCommitMs = Math.round(stats.root.ms);
    deepBootSummary = stats;
  });

  // 1. Play random legal moves via real board clicks, one Maia reply each.
  const playRng = mulberry32(SEED ^ 0x9e3779b9);
  await timed('play: boot to setup screen', async () => {
    const commitsBefore = await commitMark();
    await page.goto('http://maia.test/play');
    await expect(page.locator('#start-game')).toBeVisible();
    await settleFrames();
    const stats = summarize(await commitSliceReset(commitsBefore));
    bootCommits = stats.root.count;
    bootCommitMs = Math.round(stats.root.ms);
    bootSummary = stats;
  });
  await timed('play: start game', async () => {
    const commitsBefore = await commitMark();
    await page.locator('#start-game').click();
    await expect(page.locator('#board cg-board')).toHaveCount(1);
    await settleFrames();
    const stats = summarize(await commitSlice(commitsBefore));
    startCommits = stats.root.count;
    startCommitMs = Math.round(stats.root.ms);
    startSummary = stats;
  });
  const played: string[] = await timed('play: random moves + maia replies', async () => {
    const made: string[] = [];
    for (let i = 0; i < PLAY_MOVES; i++) {
      if (await page.locator('.game-result').count()) break;
      const legal = replay(await storedMoves(page)).moves({ verbose: true });
      if (!legal.length) break;
      const pick = legal[Math.floor(playRng() * legal.length)];
      const uci = `${pick.from}${pick.to}${pick.promotion ?? ''}`;
      const maiaBefore = net.filter(r => r.engine === 'maia').length;
      const commitsBefore = await commitMark();
      await clickMove(page, pick.from, pick.to);
      if (uci.length === 5) {
        await expect(page.locator('#promotion-dialog')).toBeVisible({ timeout: 10_000 });
        await page.locator(`[data-promotion="${uci[4]}"]`).click();
      }
      await expect.poll(async () =>
        (await page.locator('.game-result').count()) > 0 || net.filter(r => r.engine === 'maia').length > maiaBefore,
      ).toBe(true);
      if (await page.locator('.game-result').count()) break;
      await expect(page.locator('.turn-indicator')).toHaveText('To move', { timeout: 30_000 });
      await settleFrames();
      const playStats = summarize(await commitSlice(commitsBefore));
      playCommits.push(playStats.root.count);
      playCommitMs.push(Math.round(playStats.root.ms));
      playBoardMs.push(Math.round(playStats.board.ms));
      playSummaries.push(playStats);
      made.push(uci);
    }
    return made;
  });

  // 2. Analysis: seeded random long line, then the whole-game batch. This is
  // the scaling signal: per-ply inference rows in the network log and the
  // coordinator's first-half/second-half split show where long games sag.
  const line = randomLine(SEED, TARGET_PLIES);
  const positions = line.length + 1;
  await timed(`analysis: load random line (${line.length} plies)`, async () => {
    const commitsBefore = await commitMark();
    await page.locator('#mode-analysis').click();
    await page.locator('#analysis-pgn').fill(lineToPgn(line));
    await page.locator('#load-analysis').click();
    await expect(page.locator('#analysis-index')).toHaveText(`Position ${positions} / ${positions}`);
    await settleFrames();
    const stats = summarize(await commitSlice(commitsBefore));
    lineLoadCommits = stats.root.count;
    lineLoadCommitMs = Math.round(stats.root.ms);
    lineLoadSummary = stats;
  });
  await timed('analysis: full batch', async () => {
    const commitsBefore = await commitMark();
    await page.getByRole('button', { name: 'Analyze entire game' }).click();
    await expect(page.getByRole('button', { name: 'Analyzed' })).toBeDisabled({ timeout: 180_000 });
    await settleFrames();
    const batchStats = summarize(await commitSlice(commitsBefore));
    batchCommits = batchStats.root.count;
    batchCommitMs = Math.round(batchStats.root.ms);
    batchBoardMs = Math.round(batchStats.board.ms);
    batchInsightMs = Math.round(batchStats.insight.ms);
    batchSummary = batchStats;
  });

  // 3. Scrub the finished line: per-click index-change latency is the
  // interaction signal that matters for "board feels slow" reports, and the
  // per-click commit counts test whether re-renders grow with line length.
  const scrubMs: number[] = [];
  const cells = page.locator('.move-cell');
  const count = await cells.count();
  for (let i = 0; i < count; i++) {
    const start = Date.now();
    const commitsBefore = await commitMark();
    await cells.nth(i).click();
    await expect(page.locator('#analysis-index')).toContainText(`Position ${i + 2} / ${positions}`);
    await settleFrames();
    const clickStats = summarize(await commitSlice(commitsBefore));
    scrubMs.push(Date.now() - start);
    scrubCommits.push(clickStats.root.count);
    scrubCommitMs.push(Math.round(clickStats.root.ms));
    scrubBoardMs.push(Math.round(clickStats.board.ms));
    scrubInsightMs.push(Math.round(clickStats.insight.ms));
    scrubSummaries.push(clickStats);
  }
  steps.push({ step: `analysis: scrub ${count} positions`, ms: scrubMs.reduce((a, b) => a + b, 0) });

  // 4. Foreground latency after a settings change (no second batch).
  await timed('analysis: rating change foreground', async () => {
    const commitsBefore = await commitMark();
    await page.locator('#analysis-rating').selectOption('1800');
    await expect(page.getByRole('heading', { name: 'Maia • 1800', exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('updating to 1800')).toHaveCount(0);
    await settleFrames();
    const stats = summarize(await commitSlice(commitsBefore));
    ratingCommits = stats.root.count;
    ratingCommitMs = Math.round(stats.root.ms);
    ratingSummary = stats;
  });

  // 5. Candidate hover sweep: each mouseenter dispatches a preview render and
  // each row change clears the last one — a sweep is a small render storm.
  // Buttons only: the list header shares the .candidate-reading class on a
  // static span.
  await timed('analysis: candidate hover sweep', async () => {
    const rows = page.locator('.insight-panel button.candidate-reading');
    const hovered = Math.min(await rows.count(), 6);
    expect(hovered).toBeGreaterThan(0);
    for (let i = 0; i < hovered; i++) {
      const commitsBefore = await commitMark();
      await rows.nth(i).hover();
      await settleFrames();
      const stats = summarize(await commitSlice(commitsBefore));
      hoverCommits.push(stats.root.count);
      hoverCommitMs.push(Math.round(stats.root.ms));
    }
    await page.mouse.move(8, 8);
    await settleFrames();
  });

  // 6. Branch: explore the top candidate at the tip. The scrub already ends
  // at the tip, so Last is disabled there — no need to click it.
  await timed('analysis: explore branch', async () => {
    const commitsBefore = await commitMark();
    await expect(page.locator('#analysis-index')).toContainText(`Position ${positions} / ${positions}`);
    const explore = page.getByRole('button', { name: /^Explore / }).first();
    await explore.click();
    await expect(page.getByLabel('Explored variation', { exact: true })).toBeVisible();
    await settleFrames();
    const stats = summarize(await commitSlice(commitsBefore));
    exploreCommits = stats.root.count;
    exploreCommitMs = Math.round(stats.root.ms);
    exploreSummary = stats;
  });

  // 7. Branch scrub: views while the branch is live, so the
  // mainline-continuation second grading pass is active too.
  await timed('analysis: branch scrub', async () => {
    const targets = [
      page.locator('.variation-line .move-cell').first(),
      page.locator('.original-line .move-cell').first(),
      page.locator('.original-line .move-cell').nth(3),
    ];
    for (const target of targets) {
      if (await target.count() === 0) continue;
      const commitsBefore = await commitMark();
      await target.click();
      await settleFrames();
      const stats = summarize(await commitSlice(commitsBefore));
      branchScrubCommits.push(stats.root.count);
      branchScrubMs.push(Math.round(stats.root.ms));
    }
  });

  // 8. History with a realistic list, then a loaded→loaded switch: analyzing
  // a saved game while a line is open takes the own-game (pinned-Elo) path.
  await timed('history: open with 25 saved games', async () => {
    const commitsBefore = await commitMark();
    await page.locator('#mode-history').click();
    await expect.poll(async () => page.locator('.saved-game').count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(25);
    await settleFrames();
    const stats = summarize(await commitSlice(commitsBefore));
    historyCommits = stats.root.count;
    historyCommitMs = Math.round(stats.root.ms);
    historySummary = stats;
  });
  await timed('history: analyze saved game while line open', async () => {
    const commitsBefore = await commitMark();
    await page.locator('.saved-open').first().click();
    await expect(page.locator('#board cg-board')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('#analysis-index')).toBeVisible({ timeout: 30_000 });
    await settleFrames();
    const stats = summarize(await commitSlice(commitsBefore));
    reviewSwitchCommits = stats.root.count;
    reviewSwitchCommitMs = Math.round(stats.root.ms);
    reviewSwitchSummary = stats;
  });

  const perf = await page.evaluate(() => ({
    longtasks: (window as unknown as { __perfLongtasks: { duration: number }[] }).__perfLongtasks ?? [],
    shifts: (window as unknown as { __perfShifts: { value: number }[] }).__perfShifts ?? [],
  }));
  const longtaskMs = perf.longtasks.map(t => Math.round(t.duration)).sort((a, b) => a - b);
  const cls = perf.shifts.reduce((a, s) => a + (s.value || 0), 0);
  const sortedScrub = [...scrubMs].sort((a, b) => a - b);
  const pct = (arr: number[], p: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0);
  const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);
  // Early-vs-late splits: a rising trend here confirms per-interaction cost
  // growing with line length. Thirds keep both ends well away from edges.
  const third = (arr: number[]) => Math.max(1, Math.floor(arr.length / 3));
  const earlyCommits = avg(scrubCommits.slice(0, third(scrubCommits)));
  const lateCommits = avg(scrubCommits.slice(-third(scrubCommits)));
  const earlyCommitMs = avg(scrubCommitMs.slice(0, third(scrubCommitMs)));
  const lateCommitMs = avg(scrubCommitMs.slice(-third(scrubCommitMs)));
  const earlyBoardMs = avg(scrubBoardMs.slice(0, third(scrubBoardMs)));
  const lateBoardMs = avg(scrubBoardMs.slice(-third(scrubBoardMs)));
  const earlyInsightMs = avg(scrubInsightMs.slice(0, third(scrubInsightMs)));
  const lateInsightMs = avg(scrubInsightMs.slice(-third(scrubInsightMs)));
  const earlyWallMs = avg(scrubMs.slice(0, third(scrubMs)));
  const lateWallMs = avg(scrubMs.slice(-third(scrubMs)));
  // Per-region early/late render-ms: partitions each click's React work into
  // app shell (App body + hooks + router), chrome (header/controls), board
  // stage (board, move list, strips) and insight rail (candidates, charts).
  const scrubEarly = scrubSummaries.slice(0, third(scrubSummaries));
  const scrubLate = scrubSummaries.slice(-third(scrubSummaries));
  const regionAvgs = (ss: Summary[]) =>
    ({ app: avgIdMs(ss, 'app'), chrome: avgIdMs(ss, 'chrome'), board: avgIdMs(ss, 'board'), insight: avgIdMs(ss, 'insight'), root: avgIdMs(ss, 'root') });

  const metrics = {
    config: { seed: SEED, targetPlies: TARGET_PLIES, actualPlies: line.length, playMoves: played, MAIA_LIVE_MS, SF_LIVE_MS, CACHE_HIT_MS, buildDir: BUILD_DIR, inference: 'mocked', cleanPreRefactorBaseline: false },
    steps,
    scrubClickMs: { count: scrubMs.length, p50: pct(sortedScrub, 50), p95: pct(sortedScrub, 95), max: Math.max(0, ...scrubMs), earlyAvg: earlyWallMs, lateAvg: lateWallMs, perClick: scrubMs },
    commits: {
      boot: bootCommits,
      bootCommitMs,
      bootRegions: bootSummary?.byId ?? {},
      start: startCommits,
      startCommitMs,
      startRegions: startSummary?.byId ?? {},
      deepBoot: deepBootCommits,
      deepBootCommitMs,
      deepBootRegions: deepBootSummary?.byId ?? {},
      lineLoad: lineLoadCommits,
      lineLoadCommitMs,
      lineLoadRegions: lineLoadSummary?.byId ?? {},
      ratingChange: ratingCommits,
      ratingChangeCommitMs: ratingCommitMs,
      ratingChangeRegions: ratingSummary?.byId ?? {},
      explore: exploreCommits,
      exploreCommitMs,
      exploreRegions: exploreSummary?.byId ?? {},
      branchScrubPerClick: branchScrubCommits,
      branchScrubMsPerClick: branchScrubMs,
      hoverPerPreview: hoverCommits,
      hoverMsPerPreview: hoverCommitMs,
      historyMount: historyCommits,
      historyMountCommitMs: historyCommitMs,
      historyMountRegions: historySummary?.byId ?? {},
      reviewSwitch: reviewSwitchCommits,
      reviewSwitchCommitMs: reviewSwitchCommitMs,
      reviewSwitchRegions: reviewSwitchSummary?.byId ?? {},
      playPerMove: playCommits,
      playCommitMs,
      playBoardMs,
      batch: batchCommits,
      batchCommitMs,
      batchBoardMs,
      batchInsightMs,
      scrubPerClick: scrubCommits,
      scrubCommitMsPerClick: scrubCommitMs,
      scrubBoardMsPerClick: scrubBoardMs,
      scrubInsightMsPerClick: scrubInsightMs,
      scrubEarlyAvg: earlyCommits,
      scrubLateAvg: lateCommits,
      scrubEarlyCommitMsAvg: earlyCommitMs,
      scrubLateCommitMsAvg: lateCommitMs,
      scrubEarlyBoardMsAvg: earlyBoardMs,
      scrubLateBoardMsAvg: lateBoardMs,
      scrubEarlyInsightMsAvg: earlyInsightMs,
      scrubLateInsightMsAvg: lateInsightMs,
      scrubEarlyRegions: regionAvgs(scrubEarly),
      scrubLateRegions: regionAvgs(scrubLate),
      batchRegions: batchSummary?.byId ?? {},
      playRegions: playSummaries.map(s => s.byId),
      note: 'The sim runs on the profiling bundle (npm run test:perf), so counts and durations are both live. Region durations overlap their root commit: compare, never sum.',
    },
    network: {
      calls: net.length,
      maiaLive: net.filter(r => r.engine === 'maia' && r.cache === 'live').length,
      sfLive: net.filter(r => r.engine === 'sf' && r.cache === 'live').length,
      hits: net.filter(r => r.cache === 'hit').length,
      byPly: net.map(r => [r.engine, r.ply, r.cache, r.wallMs]),
    },
    longtasks: { count: longtaskMs.length, p50: pct(longtaskMs, 50), p95: pct(longtaskMs, 95), max: Math.max(0, ...longtaskMs) },
    cls: Math.round(cls * 1000) / 1000,
    errors,
  };
  const outPath = testInfo.outputPath('perf-metrics.json');
  await writeFile(outPath, JSON.stringify(metrics, null, 2));
  await testInfo.attach('perf-metrics', { path: outPath, contentType: 'application/json' });
  const earlyRegions = regionAvgs(scrubEarly);
  const lateRegions = regionAvgs(scrubLate);
  const regionLine = (r: typeof earlyRegions) => `app ${r.app} chrome ${r.chrome} board ${r.board} insight ${r.insight} root ${r.root}`;
  testInfo.annotations.push(
    { type: 'perf-boot', description: `boot ${bootCommits}/${bootCommitMs}ms ${JSON.stringify(bootSummary?.byId ?? {})}, start ${startCommits}/${startCommitMs}ms ${JSON.stringify(startSummary?.byId ?? {})}` },
    { type: 'perf-boot-deep', description: `deep-link ${deepBootCommits}/${deepBootCommitMs}ms ${JSON.stringify(deepBootSummary?.byId ?? {})}, line-load ${lineLoadCommits}/${lineLoadCommitMs}ms, review-switch ${reviewSwitchCommits}/${reviewSwitchCommitMs}ms, history-mount ${historyCommits}/${historyCommitMs}ms` },
    { type: 'perf-hover-branch', description: `hover/click [${hoverCommits.join(', ')}] ms [${hoverCommitMs.join(', ')}], explore ${exploreCommits}/${exploreCommitMs}ms, branch-scrub [${branchScrubCommits.join(', ')}]/[${branchScrubMs.join(', ')}]ms, rating ${ratingCommits}/${ratingCommitMs}ms` },
    { type: 'perf-scrub', description: `wall early/late ${earlyWallMs}/${lateWallMs}ms p95 ${metrics.scrubClickMs.p95}ms` },
    { type: 'perf-regions', description: `render-ms early [${regionLine(earlyRegions)}] late [${regionLine(lateRegions)}], batch ${JSON.stringify(batchSummary?.byId ?? {})}` },
    { type: 'perf-commits', description: `count early/late ${earlyCommits}/${lateCommits} per click, root-ms early/late ${earlyCommitMs}/${lateCommitMs} (board ${earlyBoardMs}/${lateBoardMs}, insight ${earlyInsightMs}/${lateInsightMs}), batch ${batchCommits}/${batchCommitMs}ms (board ${batchBoardMs}, insight ${batchInsightMs}), play [${playCommits.join(', ')}]` },
    { type: 'perf-longtasks', description: `count ${metrics.longtasks.count} p95 ${metrics.longtasks.p95}ms max ${metrics.longtasks.max}ms` },
    { type: 'perf-network', description: `${metrics.network.calls} calls (maia-live ${metrics.network.maiaLive}, sf-live ${metrics.network.sfLive}, hits ${metrics.network.hits})` },
  );
  // eslint-disable-next-line no-console
  console.log(`[perf] ${line.length} plies | deep-boot ${deepBootCommits}/${deepBootCommitMs}ms boot ${bootCommits}/${bootCommitMs}ms | scrub wall early/late ${earlyWallMs}/${lateWallMs}ms | hover [${hoverCommits.join(',')}] branch [${branchScrubCommits.join(',')}] | history ${historyCommits}/${historyCommitMs}ms switch ${reviewSwitchCommits}/${reviewSwitchCommitMs}ms | longtasks ${metrics.longtasks.count} | net ${metrics.network.calls}`);

  expect(errors).toEqual([]);
  expect(bootCommits).toBeGreaterThan(0);
  expect(deepBootCommits).toBeGreaterThan(0);
  expect(lineLoadCommits).toBeGreaterThan(0);
  expect(batchCommits).toBeGreaterThan(0);
  expect(branchScrubCommits.length).toBeGreaterThan(0);
  expect(historyCommits).toBeGreaterThan(0);
  expect(reviewSwitchCommits).toBeGreaterThan(0);
  expect(evaluations.entries.size + bulkCache.size).toBeGreaterThanOrEqual(positions);
});
