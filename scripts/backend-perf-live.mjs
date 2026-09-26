#!/usr/bin/env node
// backend-perf-live.mjs — live-engine backend perf harness.
//
// Drives a REAL backend over HTTP (home-server, tailnet URL, or local
// container) with a seeded chess.js line and records true inference
// latency: cold start, per-ply history scaling, cache hit vs miss,
// whole-line batch drain, foreground-during-batch priority, Stockfish
// search-budget sweep, and 79m vs 5m.
//
// The mock harness (scripts/backend-perf.sh) measures Go overhead with
// stubbed inference. This script measures what mocks cannot: worker
// startup, model load, history-replay cost growth with ply, and how
// different inputs change latency.
//
// Usage:
//   node scripts/backend-perf-live.mjs --url http://debian-server:8080 \
//     --seed 1 --plies 40 --out test-results/backend-perf-live.json
//
// Live positions MUST be real: the worker replays moves from the start
// and rejects triples that do not produce fen (position_mismatch), so
// the line is generated with chess.js (same mulberry32 seed scheme as
// the frontend client sim) and every FEN is a true prefix product.
//
// Miss scenarios use deterministic per-scenario Elo offsets (documented
// in the JSON config) so a lived-in server cache cannot silently turn
// the miss curve into a hit curve. The hit scenario reuses the exact
// miss identities in-process, so hits are guaranteed by construction.
// 503/409/429 responses are RECORDED as extreme-scenario signals, not
// retried into hiding (polls excepted: they retry until finished).
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let Chess;
try {
  ({ Chess } = require(resolve(root, 'frontend/node_modules/chess.js')));
} catch {
  ({ Chess } = require('chess.js'));
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0; state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLine(seed, plies) {
  const rng = mulberry32(seed);
  const game = new Chess();
  const moves = [];
  const fens = [game.fen()];
  while (moves.length < plies && !game.isGameOver()) {
    const legal = game.moves({ verbose: true });
    const pick = legal[Math.floor(rng() * legal.length)];
    game.move({ from: pick.from, to: pick.to, ...(pick.promotion ? { promotion: pick.promotion } : {}) });
    moves.push(`${pick.from}${pick.to}${pick.promotion ?? ''}`);
    fens.push(game.fen());
  }
  return { moves, fens, gameOver: game.isGameOver() };
}

function maiaColor(fen) {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white';
}

function parseArgs(argv) {
  const out = { url: '', seed: 1, plies: 40, eloMaia: 1500, eloUser: 1300, model: '79m',
    sfTime: 750, sfLines: 2, bust: 0, scenarios: 'all', out: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--url') out.url = next ?? '';
    else if (flag === '--seed') out.seed = Number(next);
    else if (flag === '--plies') out.plies = Math.min(Number(next), 256);
    else if (flag === '--elo-maia') out.eloMaia = Number(next);
    else if (flag === '--elo-user') out.eloUser = Number(next);
    else if (flag === '--model') out.model = next ?? '79m';
    else if (flag === '--sf-time') out.sfTime = Number(next);
    else if (flag === '--sf-lines') out.sfLines = Number(next);
    else if (flag === '--cache-bust') out.bust = Number(next);
    else if (flag === '--scenarios') out.scenarios = next ?? 'all';
    else if (flag === '--out') out.out = next ?? '';
    else if (flag === '-h' || flag === '--help') out.help = true;
    else { console.error(`unknown flag: ${flag}`); process.exit(2); }
    if (!['-h', '--help'].includes(flag)) i++;
  }
  return out;
}

const HELP = `Usage: node scripts/backend-perf-live.mjs --url <backend> [options]

  --url <base>        real backend, e.g. http://debian-server:8080 (required)
  --seed N            seeded random line (default 1)
  --plies N           line length, max 256 (default 40)
  --elo-maia N        display Maia Elo (default 1500)
  --elo-user N        display user Elo (default 1300)
  --model 79m|5m      display Maia model (default 79m)
  --sf-time MS        Stockfish time_ms for batch/sweep (default 750)
  --sf-lines N        Stockfish lines for batch/sweep (default 2)
  --cache-bust N      added to both Elos for miss scenarios (default 0).
                      Pass a fresh value per run against a lived-in server
                      so the miss curve cannot silently become hits.
  --scenarios LIST    comma list or 'all' (default all):
                      cold,ply-curve,hit,batch,foreground,lanes,storm,
                      abort,sf-sweep,models,bigbatch,caps
                      lanes = batch draining + Play/Focus/SF foreground timing.
                      storm = same-lane supersede chain + same-key dedup join.
                      abort = client disconnect mid-inference, then re-request
                      (proves detached write-through).
                      bigbatch = 256-ply 3-lane batch (768-entry chunk split).
                      caps = 9 rapid tiny batches (429 admission-cap probe).
  --out PATH          JSON output (default
                      test-results/backend-perf-live-s<seed>-p<plies>.json)
`;

async function post(base, path, body, timeoutMs) {
  const start = Date.now();
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const ms = Date.now() - start;
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  return { status: res.status, ms, cache: res.headers.get('x-eval-cache') ?? null, json };
}

async function get(base, path, timeoutMs) {
  const start = Date.now();
  const res = await fetch(base + path, { signal: AbortSignal.timeout(timeoutMs) });
  const ms = Date.now() - start;
  let json = null;
  try { json = await res.json(); } catch { /* polling a missing job */ }
  return { status: res.status, ms, json };
}

// Per-position Maia display entry, mirroring the client's batch shape
// (buildBatchItems: one entry per engine per node, plus the 2400 grading
// lane appended by the caller).
function maiaEntry(fen, ply, eloMaia, eloUser, model) {
  return { engine: 'maia', fen, ply, elo_maia: eloMaia, elo_user: eloUser, model };
}

// Analyzable prefixes: like the client's buildBatchItems (which skips
// outcome nodes), a terminal final position has no legal moves and the
// worker reports game_over per index — so it is excluded from batch
// entry sets. Returns the position count to cover.
function analyzablePositions(moves, gameOver) {
  return moves.length + 1 - (gameOver ? 1 : 0);
}

let pollBlips = 0;

async function pollBatch(base, jobId, timeoutMs, intervalMs, onSample) {
  const start = Date.now();
  for (;;) {
    let r;
    try {
      r = await get(base, `/reviews/${jobId}`, 30000);
    } catch (err) {
      // Transient connection loss mid-drain (the server keeps working;
      // polling is read-only, so retry and count the blip instead of
      // failing a minutes-long batch on one dropped poll).
      if (++pollBlips > 10 || Date.now() - start > timeoutMs) throw err;
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }
    if (r.status !== 200) throw new Error(`batch poll ${r.status}: ${JSON.stringify(r.json)}`);
    const p = r.json;
    onSample({ elapsedMs: Date.now() - start, done: p.done, total: p.total });
    if (p.finished) return p;
    if (Date.now() - start > timeoutMs) throw new Error(`batch ${jobId} unfinished after ${timeoutMs}ms: ${JSON.stringify(p)}`);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }
  if (!args.url) { console.error('--url is required'); process.exit(2); }
  const base = args.url.replace(/\/$/, '');
  const want = args.scenarios === 'all'
    ? ['cold', 'ply-curve', 'hit', 'batch', 'foreground', 'lanes', 'storm',
       'abort', 'sf-sweep', 'models', 'bigbatch', 'caps']
    : args.scenarios.split(',').map(s => s.trim()).filter(Boolean);

  const { moves, fens, gameOver } = randomLine(args.seed, args.plies);
  const positions = moves.length + 1;
  const line = { initial_fen: START_FEN, moves };
  // Deterministic per-scenario Elo offsets: miss scenarios must not share
  // identities with each other or with earlier runs' defaults.
  const elos = {
    curve: { maia: args.eloMaia + args.bust, user: args.eloUser + args.bust },
    batch: { maia: args.eloMaia + args.bust + 11, user: args.eloUser + args.bust + 11 },
    fgBatch: { maia: args.eloMaia + args.bust + 23, user: args.eloUser + args.bust + 23 },
    fgLive: { maia: args.eloMaia + args.bust + 29, user: args.eloUser + args.bust + 29 },
    abort: { maia: args.eloMaia + args.bust + 150, user: args.eloUser + args.bust + 150 },
    storm: { maia: args.eloMaia + args.bust + 200, user: args.eloUser + args.bust + 200 },
    stormJoin: { maia: args.eloMaia + args.bust + 300, user: args.eloUser + args.bust + 300 },
    lanes: { maia: args.eloMaia + args.bust + 400, user: args.eloUser + args.bust + 400 },
    big: { maia: args.eloMaia + args.bust + 500, user: args.eloUser + args.bust + 500 },
  };
  const results = { config: { url: base, seed: args.seed, targetPlies: args.plies,
    actualPlies: moves.length, positions, gameOver, model: args.model,
    displayElos: elos, sfTime: args.sfTime, sfLines: args.sfLines, inference: 'live' } };

  const ube = (pair) => pair.maia > 5000 || pair.user > 5000 || pair.maia < 0 || pair.user < 0;
  if (Object.values(elos).some(ube)) throw new Error('Elo offsets exceed 0-5000; lower --cache-bust');

  if (want.includes('cold')) {
    // First touch with a unique Elo: measures cold worker startup + model
    // load when the server evicted its workers, else a warm baseline.
    const e = elos.curve;
    const r = await post(base, '/move/analysis',
      { fen: fens[0], moves: [], elo_maia: e.maia + 101, elo_user: e.user + 101, model: args.model, maia_color: maiaColor(fens[0]) }, 600000);
    results.cold = { ms: r.ms, status: r.status, cache: r.cache, modelUsed: r.json?.model_used ?? null, degraded: r.json?.degraded ?? null };
    console.log(`[live] cold ${r.ms}ms status=${r.status} cache=${r.cache}`);
  }

  if (want.includes('ply-curve')) {
    // History-scaling curve: same Elo pair, every prefix is a distinct
    // identity, so all are misses. Rising ms with ply points at
    // ply-correlated cost (history replay, hash pressure); flat points
    // at the inference budget itself.
    const e = elos.curve;
    const curve = [];
    for (let ply = 0; ply < positions; ply++) {
      const r = await post(base, '/move/analysis',
        { fen: fens[ply], moves: moves.slice(0, ply), elo_maia: e.maia, elo_user: e.user, model: args.model, maia_color: maiaColor(fens[ply]) }, 180000);
      curve.push({ ply, ms: r.ms, status: r.status, cache: r.cache,
        code: r.status !== 200 ? r.json?.code ?? null : null,
        modelUsed: r.json?.model_used ?? null, degraded: r.json?.degraded ?? null });
      if (r.status !== 200 && r.json?.code === 'game_over') break;
      if (r.status !== 200 && r.status !== 503) throw new Error(`ply-curve ply ${ply}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    results.plyCurve = curve;
    const ok = curve.filter(p => p.status === 200).map(p => p.ms);
    console.log(`[live] ply-curve ${ok.length}/${curve.length} ok first=${ok[0]}ms last=${ok[ok.length - 1]}ms max=${Math.max(...ok)}ms`);
  }

  if (want.includes('hit')) {
    // Same identities as ply-curve: every 200 must now be a hit served
    // from SQLite without touching an engine.
    const e = elos.curve;
    const hits = [];
    for (let ply = 0; ply < positions; ply++) {
      const r = await post(base, '/move/analysis',
        { fen: fens[ply], moves: moves.slice(0, ply), elo_maia: e.maia, elo_user: e.user, model: args.model, maia_color: maiaColor(fens[ply]) }, 60000);
      hits.push({ ply, ms: r.ms, status: r.status, cache: r.cache });
      if (r.status !== 200) throw new Error(`hit ply ${ply}: ${r.status} ${JSON.stringify(r.json)}`);
    }
    results.hitCurve = hits;
    console.log(`[live] hit max=${Math.max(...hits.map(h => h.ms))}ms hits=${hits.filter(h => h.cache === 'hit').length}/${hits.length}`);
  }

  const submitBatch = async (entrySet, label, bulkLine = line) => {
    // Server caps one submit at 768 entries; a 3-lane 256-ply line is 771,
    // so long lines split into chunk submits (each its own job).
    const chunks = [];
    for (let i = 0; i < entrySet.length; i += 768) chunks.push(entrySet.slice(i, i + 768));
    const jobs = [];
    for (const [ci, chunk] of chunks.entries()) {
      const r = await post(base, '/reviews', { line: bulkLine, requests: chunk }, 60000);
      if (r.status !== 202) throw new Error(`${label} chunk ${ci}: ${r.status} ${JSON.stringify(r.json)}`);
      jobs.push({ ...r.json, chunk: ci });
    }
    return jobs;
  };

  if (want.includes('batch')) {
    // Whole-game batch exactly like the client: SF + display Maia + 2400
    // grading Maia per position (buildBatchItems shape).
    const e = elos.batch;
    const sfSettings = { time_ms: args.sfTime, lines: args.sfLines, depth: 0 };
    const entries = [];
    for (let ply = 0; ply < analyzablePositions(moves, gameOver); ply++) {
      entries.push({ engine: 'sf', fen: fens[ply], ply, settings: sfSettings });
      entries.push(maiaEntry(fens[ply], ply, e.maia, e.user, args.model));
      entries.push(maiaEntry(fens[ply], ply, 2400, 2400, '79m'));
    }
    const start = Date.now();
    const jobs = await submitBatch(entries, 'batch');
    const samples = [];
    let done = 0, failed = 0;
    const errors = {};
    for (const job of jobs) {
      const p = await pollBatch(base, job.job_id, 1800000, 2000,
        s => samples.push({ ...s, job: job.job_id.slice(0, 8) }));
      done += p.done; failed += p.failed; Object.assign(errors, p.errors ?? {});
    }
    results.batch = { entries: entries.length, jobs: jobs.map(j => ({ ...j })),
      wallMs: Date.now() - start, done, failed, errors, samples };
    console.log(`[live] batch ${entries.length} entries ${results.batch.wallMs}ms done=${done} failed=${failed}`);
  }

  if (want.includes('foreground')) {
    // Extreme interaction: a long batch is draining while interactive
    // traffic arrives. Priority says Play > Focus > Batch, so foreground
    // must jump the queue — its latency bounds the "app feels stuck
    // during Analyze entire game" complaint.
    const e = elos.fgBatch, live = elos.fgLive;
    const sfSettings = { time_ms: Math.max(args.sfTime, 2000), lines: args.sfLines, depth: 0 };
    const entries = [];
    for (let ply = 0; ply < analyzablePositions(moves, gameOver); ply++) {
      entries.push({ engine: 'sf', fen: fens[ply], ply, settings: sfSettings });
      entries.push(maiaEntry(fens[ply], ply, e.maia, e.user, args.model));
    }
    const jobs = await submitBatch(entries, 'foreground-batch');
    await new Promise(resolve => setTimeout(resolve, 3000));
    const mid = Math.floor(positions / 2);
    const [focus, sf] = await Promise.all([
      post(base, '/move/analysis',
        { fen: fens[mid], moves: moves.slice(0, mid), elo_maia: live.maia, elo_user: live.user, model: args.model, maia_color: maiaColor(fens[mid]) }, 180000),
      post(base, '/evaluate',
        { fen: fens[mid], moves: moves.slice(0, mid), settings: { time_ms: args.sfTime, lines: 2, depth: 0 } }, 120000),
    ]);
    results.foreground = {
      focus: { ms: focus.ms, status: focus.status, cache: focus.cache },
      sf: { ms: sf.ms, status: sf.status, cache: sf.cache },
    };
    console.log(`[live] foreground-during-batch focus=${focus.ms}ms(${focus.status}) sf=${sf.ms}ms(${sf.status})`);
    for (const job of jobs) await pollBatch(base, job.job_id, 1800000, 5000, () => {});
  }

  if (want.includes('lanes')) {
    // Priority contention with per-lane timing: a batch is draining while
    // one Play, one Focus, and one SF request arrive together, each a
    // forced miss. Play > Focus > Batch must all succeed near single
    // inference latency instead of waiting out the drain.
    const e = elos.lanes;
    const pliesL = Math.min(moves.length, 20);
    const mid = Math.floor(pliesL / 2);
    const laneEntries = [];
    for (let ply = 0; ply <= pliesL && ply < analyzablePositions(moves, gameOver); ply++) {
      laneEntries.push({ engine: 'sf', fen: fens[ply], ply, settings: { time_ms: 2000, lines: 2, depth: 0 } });
      laneEntries.push(maiaEntry(fens[ply], ply, e.maia, e.user, args.model));
    }
    const laneJobs = await submitBatch(laneEntries, 'lanes-batch');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const [play, focus, sf] = await Promise.all([
      post(base, '/move',
        { fen: fens[0], moves: [], elo_maia: e.maia + 1, elo_user: e.user + 1, model: args.model, maia_color: maiaColor(fens[0]) }, 180000),
      post(base, '/move/analysis',
        { fen: fens[mid], moves: moves.slice(0, mid), elo_maia: e.maia + 2, elo_user: e.user + 2, model: args.model, maia_color: maiaColor(fens[mid]) }, 180000),
      post(base, '/evaluate',
        { fen: fens[mid], moves: moves.slice(0, mid), settings: { time_ms: 1000, lines: 2, depth: 0 } }, 120000),
    ]);
    if (play.status !== 200 || focus.status !== 200 || sf.status !== 200) {
      throw new Error(`lanes play=${play.status} focus=${focus.status} sf=${sf.status}`);
    }
    const drainStart = Date.now();
    for (const job of laneJobs) await pollBatch(base, job.job_id, 1800000, 2000, () => {});
    results.lanes = {
      play: { ms: play.ms, status: play.status, cache: play.cache },
      focus: { ms: focus.ms, status: focus.status, cache: focus.cache },
      sf: { ms: sf.ms, status: sf.status, cache: sf.cache },
      batchWallMs: Date.now() - drainStart + 2000,
    };
    console.log(`[live] lanes play=${play.ms}ms focus=${focus.ms}ms sf=${sf.ms}ms`);
  }

  if (want.includes('storm')) {
    // Same-lane pressure, two halves. Distinct keys on one lane fire
    // together: the single slot runs the first arrival and latest-wins
    // keeps only the newest waiter, so the middle arrivals must 409
    // (ErrSuperseded). Same key fired together: dedup join runs one
    // inference and serves every waiter (exactly one miss, rest hits).
    const K = 6;
    const settled = (r) => ({ status: r.status, ms: r.ms, cache: r.cache ?? null, code: r.json?.code ?? null });
    const distinct = await Promise.all(Array.from({ length: K }, (_, i) =>
      post(base, '/move/analysis',
        { fen: fens[0], moves: [], elo_maia: elos.storm.maia + i, elo_user: elos.storm.user + i, model: args.model, maia_color: maiaColor(fens[0]) }, 60000)
        .then(settled, err => ({ status: 'error', ms: -1, cache: null, code: String(err) }))));
    const dCounts = {};
    for (const r of distinct) dCounts[r.status] = (dCounts[r.status] ?? 0) + 1;
    const joinStart = Date.now();
    const joined = await Promise.all(Array.from({ length: K }, () =>
      post(base, '/move/analysis',
        { fen: fens[0], moves: [], elo_maia: elos.stormJoin.maia, elo_user: elos.stormJoin.user, model: args.model, maia_color: maiaColor(fens[0]) }, 60000)
        .then(settled, err => ({ status: 'error', ms: -1, cache: null, code: String(err) }))));
    const joinWall = Date.now() - joinStart;
    const jMisses = joined.filter(r => r.cache === 'miss').length;
    const jHits = joined.filter(r => r.cache === 'hit').length;
    if (!Object.keys(dCounts).every(s => ['200', '409', '503'].includes(s))) {
      throw new Error(`storm distinct unexpected statuses: ${JSON.stringify(distinct)}`);
    }
    if ((dCounts['409'] ?? 0) < 1) throw new Error(`storm distinct never superseded: ${JSON.stringify(dCounts)}`);
    if (!joined.every(r => r.status === 200) || jMisses !== 1 || jHits !== K - 1) {
      throw new Error(`storm join not 1-miss/${K - 1}-hit: ${JSON.stringify(joined)}`);
    }
    results.storm = { distinct: distinct.map(({ status, ms, cache }) => ({ status, ms, cache })),
      distinctCounts: dCounts, joinWallMs: joinWall, joinMisses: jMisses, joinHits: jHits };
    console.log(`[live] storm distinct ${JSON.stringify(dCounts)} join wall=${joinWall}ms misses=${jMisses} hits=${jHits}`);
  }

  if (want.includes('abort')) {
    // Client disconnect mid-inference: the request runs on a detached
    // context, so the result must still write through. Re-requesting the
    // same identity afterwards must be a hit — that hit is the proof.
    const e = elos.abort;
    const body = { fen: fens[0], moves: [], elo_maia: e.maia, elo_user: e.user, model: args.model, maia_color: maiaColor(fens[0]) };
    const ctrl = new AbortController();
    const flight = fetch(base + '/move/analysis', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal })
      .then(() => ({ aborted: false }), () => ({ aborted: true }));
    setTimeout(() => ctrl.abort(), 50);
    const dropped = await flight;
    await new Promise(resolve => setTimeout(resolve, 5000));
    const again = await post(base, '/move/analysis', body, 60000);
    if (again.status !== 200 || again.cache !== 'hit') {
      throw new Error(`abort write-through missing: status=${again.status} cache=${again.cache}`);
    }
    results.abort = { clientAborted: dropped.aborted, second: { ms: again.ms, status: again.status, cache: again.cache } };
    console.log(`[live] abort dropped=${dropped.aborted} re-request=${again.ms}ms cache=${again.cache}`);
  }

  if (want.includes('sf-sweep')) {
    // Search-budget scaling on one mid-line position: every cell is a
    // distinct identity (fresh search), so ms measures engine work.
    const mid = Math.floor(positions / 2);
    const grid = [];
    for (const timeMs of [250, 750, 2000]) {
      for (const lines of [1, 2, 5]) {
        const r = await post(base, '/evaluate',
          { fen: fens[mid], moves: moves.slice(0, mid), settings: { time_ms: timeMs, lines, depth: 0 } }, 120000);
        grid.push({ timeMs, lines, ms: r.ms, status: r.status, cache: r.cache,
          depth: r.json?.depth ?? null });
        console.log(`[live] sf ms=${timeMs} lines=${lines} → ${r.ms}ms status=${r.status} depth=${r.json?.depth ?? '?'}`);
      }
    }
    results.sfSweep = { ply: mid, grid };
  }

  if (want.includes('models')) {
    // 79m vs 5m on the same mid-line position with fresh Elos.
    const mid = Math.floor(positions / 2);
    const rows = [];
    for (const model of ['79m', '5m']) {
      const bump = model === '5m' ? 41 : 43;
      const r = await post(base, '/move/analysis',
        { fen: fens[mid], moves: moves.slice(0, mid),
          elo_maia: args.eloMaia + args.bust + bump, elo_user: args.eloUser + args.bust + bump,
          model, maia_color: maiaColor(fens[mid]) }, 180000);
      rows.push({ model, ms: r.ms, status: r.status, cache: r.cache,
        modelUsed: r.json?.model_used ?? null, degraded: r.json?.degraded ?? null });
    }
    results.models = { ply: mid, rows };
    console.log(`[live] models ${rows.map(r => `${r.model}=${r.ms}ms`).join(' ')}`);
  }

  if (want.includes('bigbatch')) {
    // Max-size extreme: a distinct 256-ply line, 3 lanes per position
    // (771 entries) exercises the 768-entry chunk split against real
    // engines and the full drain curve at the largest supported history.
    const big = randomLine(args.seed + 1000, 256);
    const bigPositions = big.moves.length + 1;
    const bigLine = { initial_fen: START_FEN, moves: big.moves };
    const e = elos.big;
    const sfSettings = { time_ms: args.sfTime, lines: args.sfLines, depth: 0 };
    const entries = [];
    for (let ply = 0; ply < analyzablePositions(big.moves, big.gameOver); ply++) {
      entries.push({ engine: 'sf', fen: big.fens[ply], ply, settings: sfSettings });
      entries.push({ engine: 'maia', fen: big.fens[ply], ply, elo_maia: e.maia, elo_user: e.user, model: args.model });
      entries.push({ engine: 'maia', fen: big.fens[ply], ply, elo_maia: 2400, elo_user: 2400, model: '79m' });
    }
    const start = Date.now();
    const jobs = await submitBatch(entries, 'bigbatch', bigLine);
    const samples = [];
    let done = 0, failed = 0;
    const errors = {};
    for (const job of jobs) {
      const p = await pollBatch(base, job.job_id, 3600000, 5000,
        s => samples.push({ ...s, job: job.job_id.slice(0, 8) }));
      done += p.done; failed += p.failed; Object.assign(errors, p.errors ?? {});
    }
    if (failed !== 0) throw new Error(`bigbatch failed=${failed}: ${JSON.stringify(errors)}`);
    const wallMs = Date.now() - start;
    const half = samples.length ? samples[Math.floor(samples.length / 2)].elapsedMs : -1;
    results.bigbatch = { seed: args.seed + 1000, plies: big.moves.length, positions: bigPositions,
      terminalSkipped: big.gameOver, entries: entries.length, chunks: jobs.length,
      jobs: jobs.map(j => ({ job_id: j.job_id?.slice(0, 8), total: j.total, cached: j.cached, pending: j.pending })),
      wallMs, done, failed, firstHalfMs: half, samples };
    console.log(`[live] bigbatch ${entries.length} entries ${jobs.length} chunks cached=${jobs.map(j => j.cached).join('+')} ${wallMs}ms done=${done} failed=${failed}`);
  }

  if (want.includes('caps')) {
    // Admission-cap probe: 9 rapid tiny batches (2 maia misses each, all
    // distinct) against the 8-unfinished-jobs cap. Over-cap submits must
    // 429 with Retry-After, never 500; accepted jobs must still finish
    // cleanly. Counts are recorded, not asserted — timing decides them.
    const submits = await Promise.all(Array.from({ length: 9 }, (_, i) =>
      post(base, '/reviews', { line, requests: [
        { engine: 'maia', fen: fens[0], ply: 0, elo_maia: args.eloMaia + args.bust + 600 + i, elo_user: args.eloUser + args.bust + 600 + i, model: args.model },
        { engine: 'maia', fen: fens[1], ply: 1, elo_maia: args.eloMaia + args.bust + 600 + i, elo_user: args.eloUser + args.bust + 600 + i, model: args.model },
      ] }, 30000).then(
        r => ({ status: r.status, job: r.json?.job_id ?? null, code: r.json?.code ?? null }),
        err => ({ status: 'error', job: null, code: String(err) }))));
    const counts = {};
    for (const s of submits) counts[s.status] = (counts[s.status] ?? 0) + 1;
    if (!Object.keys(counts).every(s => ['202', '429'].includes(s))) {
      throw new Error(`caps unexpected statuses: ${JSON.stringify(submits)}`);
    }
    for (const s of submits) {
      if (s.status === 202) await pollBatch(base, s.job, 300000, 1000, () => {});
    }
    results.caps = { submits: submits.map(({ status, code }) => ({ status, code })), counts };
    console.log(`[live] caps ${JSON.stringify(counts)}`);
  }

  const outPath = args.out || resolve(root, `test-results/backend-perf-live-s${args.seed}-p${moves.length}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  results.pollBlips = pollBlips;
  writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
}

main().catch(err => { console.error(`FAILED: ${err.message}`); process.exit(1); });
