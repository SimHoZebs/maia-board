import { Chess } from 'chess.js';
import { parseMoveResponse, requestMove, type MoveResponse, type MaiaModel } from './api';
import { replay } from './domain';
import { terminalEvaluation, type Evaluation, type Score } from './reviewMetrics';
import { stockfishPolicy, type StockfishSettings } from './stockfishSettings';

export type ReviewNode = { initialFen: string; moves: string[]; fen: string };
export type ReviewSettings = { eloMaia: number; eloUser: number; model: MaiaModel; stockfish?: StockfishSettings };
export type Engine = 'sf' | 'maia';
// Per-position timing trace for batch slowdown diagnosis. `ply` is the
// in-game position index (node.moves.length), the x-axis for second-half
// cliffs. `detail` carries the engine identity that explains the cost:
// the full Stockfish search policy (mpv/time/depth) or Maia model@elo.
// `source` separates real inference (`live`) from `server-cache` and
// `memory` hits: a batch that starts fast then crawls is the signature of
// a settings change that invalidated one engine's cache half (e.g. Stockfish
// lines 2→4 keeps every Maia key but misses every SF key).
export type JobSource = 'memory' | 'server-cache' | 'live';
export type JobTiming = {
  engine: Engine; ply: number; detail: string;
  source: JobSource; ms: number; retries: number; batched: boolean; failed?: boolean;
};
export type EngineTimingSummary = {
  live: number; liveAvgMs: number; liveMaxMs: number;
  serverHits: number; memHits: number; failed: number;
  firstHalfAvgMs: number | null; secondHalfAvgMs: number | null;
  liveMsByPly: [number, number][];
};
export type BatchTimingSummary = {
  total: number; done: number; failed: number;
  byEngine: Record<Engine, EngineTimingSummary>;
};
type Result = Evaluation | MoveResponse;
type Job = { key: string; engine: Engine; node: ReviewNode; settings: ReviewSettings };
// Stall budgets. Maia inference may legally run up to the backend's 120s move
// window, so a lane is only declared stale past that plus margin. Mobile
// background freezes (timers and sockets stall while promises stay pending)
// are detected on return instead: jobs that straddled a long hide are
// re-issued, since their sockets may be dead while the promises never settle.
export const JOB_STALL_MS = 150_000;
export const RESUME_ABORT_AFTER_HIDDEN_MS = 10_000;
const CACHE_PROBE_MS = 30_000;
export const MAIA_REF = '1e13597c42d4858b7cfd7cfdae01e297263364b2';
export function reviewKey(engine: Engine, node: ReviewNode, settings: ReviewSettings): string {
  return JSON.stringify([new Chess(node.initialFen).fen(), node.moves, engine === 'sf' ? stockfishPolicy(settings.stockfish) : [settings.eloMaia, settings.eloUser, settings.model, MAIA_REF]]);
}
class Lru<T> {
  private values = new Map<string, { value: T; expires: number }>();
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return;
    this.values.delete(key);
    if (entry.expires < Date.now()) return;
    this.values.set(key, entry); return entry.value;
  }
  peek(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry || entry.expires < Date.now()) return;
    return entry.value;
  }
  set(key: string, value: T, ttl = Infinity) {
    this.values.delete(key); this.values.set(key, { value, expires: Date.now() + ttl });
    if (this.values.size > 512) this.values.delete(this.values.keys().next().value!);
  }
}
function isScore(value: unknown): value is Score {
  if (!value || typeof value !== 'object') return false;
  const score = value as Score;
  return (score.type === 'cp' || score.type === 'mate') && Number.isFinite(score.value) && (score.type !== 'mate' || score.value !== 0 || score.winning_side === 'white' || score.winning_side === 'black');
}
function sameScore(a: Score, b: Score): boolean {
  return a.type === b.type && a.value === b.value && (a.type !== 'mate' || a.winning_side === b.winning_side);
}
// Deterministic non-crypto hash for cache keys. Cache identity must be stable
// across browsers, and crypto.subtle is unavailable on plain-HTTP LAN origins,
// so collision resistance against adversaries is traded for determinism. At a
// few thousand rows the accidental-collision odds are negligible, and a hit
// still passes full response validation before use.
export function cacheHash(key: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

export function parseEvaluation(body: unknown, settings?: StockfishSettings): Evaluation {
  if (!body || typeof body !== 'object') throw new Error('Stockfish returned an incomplete evaluation.');
  const value = body as Evaluation & { engine?: unknown; search_policy?: unknown };
  if (value.engine !== 'Stockfish 19' || value.search_policy !== stockfishPolicy(settings) || !Number.isInteger(value.depth) || value.depth < 0 || !isScore(value.score) || ![null, 'white_win', 'black_win', 'draw'].includes(value.terminal) || !(value.best_move === null || typeof value.best_move === 'string') || !Array.isArray(value.lines)) throw new Error('Stockfish returned an incomplete evaluation.');
  if (value.terminal !== null) {
    if (value.best_move !== null || value.lines.length !== 0 || value.depth !== 0) throw new Error('Stockfish returned an incomplete evaluation.');
    if (value.terminal === 'draw') {
      if (value.score.type !== 'cp' || value.score.value !== 0) throw new Error('Stockfish returned an incomplete evaluation.');
    } else {
      const winner = value.terminal === 'white_win' ? 'white' : 'black';
      if (value.score.type !== 'mate' || value.score.value !== 0 || value.score.winning_side !== winner) throw new Error('Stockfish returned an incomplete evaluation.');
    }
  } else {
    if (value.lines.length < 1 || value.lines.length > (settings?.lines ?? 2)) throw new Error('Stockfish returned an incomplete evaluation.');
    if (typeof value.best_move !== 'string' || value.best_move !== value.lines[0].move) throw new Error('Stockfish returned an incomplete evaluation.');
    // Ranks must be distinct moves. A duplicated first move marks two rows
    // "played" and, through duplicate React keys, strands a stale row in the
    // list on navigation. Rejecting here turns cached corrupt rows into
    // misses, so live re-inference overwrites them with clean data.
    if (new Set(value.lines.map(line => line.move)).size !== value.lines.length) throw new Error('Stockfish returned an incomplete evaluation.');
    if (!value.lines.every(line => typeof line.move === 'string' && isScore(line.score) && Number.isInteger(line.depth) && line.depth >= 1)) throw new Error('Stockfish returned an incomplete evaluation.');
    const depths = value.lines.map(line => line.depth);
    if (value.depth < Math.min(...depths) || value.depth < 1) throw new Error('Stockfish returned an incomplete evaluation.');
    if (!sameScore(value.score, value.lines[0].score)) throw new Error('Stockfish returned an incomplete evaluation.');
  }
  return value;
}

export async function fetchEvaluation(node: ReviewNode, signal: AbortSignal, fetcher: typeof fetch = fetch, settings?: StockfishSettings): Promise<Evaluation> {
  let response: Response;
  try {
    response = await fetcher('/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen: node.fen, moves: node.moves, initial_fen: node.initialFen, ...(settings ? { settings } : {}) }), signal });
  } catch (error) {
    if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
    throw new Error('Stockfish is unreachable. Check that the server is running on your LAN.');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Stockfish returned unreadable data.');
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message : `Stockfish request failed (${response.status}).`;
    throw new Error(message);
  }
  return parseEvaluation(body, settings);
}
// Each lane has one in-flight job. Foreground replacement coalesces scrubbing;
// batch work is pulled one node at a time only when the foreground is empty.
export class ReviewCoordinator {
  private cache = { sf: new Lru<Evaluation>(), maia: new Lru<MoveResponse>() };
  private failures = new Map<string, string>();
  private foreground: Record<Engine, Job[]> = { sf: [], maia: [] };
  private running: Partial<Record<Engine, Job>> = {};
  private startedAt: Partial<Record<Engine, number>> = {};
  private controllers: Partial<Record<Engine, AbortController>> = {};
  private batch: { nodes: ReviewNode[]; settings: ReviewSettings; cursor: Record<Engine, number>; total: number; completed: Set<string>; degradedMaia: boolean } | null = null;
  private listeners = new Set<() => void>();
  private active = true;
  // Timing ring for the current/last batch plus foreground jobs. Inspect in
  // DevTools via the coordinator (e.g. `timings.filter(t => t.engine === 'sf')`)
  // or read the one-line `[review] batch timing` summary logged on completion.
  timings: JobTiming[] = [];
  private summaryLogged = false;
  // Keys that ran live inference during the current batch run. A batch-lane
  // skip over one of these is just cursor catch-up after its own completion,
  // not a cache hit, so it must not record a memory row.
  private executedKeys = new Set<string>();
  version = 0;
  constructor(private fetcher: typeof fetch = (input, init) => fetch(input, init)) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private emit() { this.version++; this.listeners.forEach(listener => listener()); }
  result<E extends Engine>(engine: E, node: ReviewNode, settings: ReviewSettings): (E extends 'sf' ? Evaluation : MoveResponse) | undefined {
    return this.cache[engine].peek(reviewKey(engine, node, settings)) as (E extends 'sf' ? Evaluation : MoveResponse) | undefined;
  }
  error(engine: Engine, node: ReviewNode, settings: ReviewSettings) { return this.failures.get(reviewKey(engine, node, settings)); }
  private job(engine: Engine, node: ReviewNode, settings: ReviewSettings): Job | null {
    const terminal = terminalEvaluation(replay(node.moves, node.initialFen));
    if (terminal) {
      if (engine === 'sf') this.cache.sf.set(reviewKey(engine, node, settings), { ...terminal, search_policy: stockfishPolicy(settings.stockfish) });
      return null;
    }
    return { engine, node, settings, key: reviewKey(engine, node, settings) };
  }
  foregroundAt(nodes: ReviewNode[], settings: ReviewSettings) {
    this.active = true;
    for (const engine of ['sf', 'maia'] as const) {
      this.foreground[engine] = nodes.slice(0, engine === 'sf' ? 2 : 1).flatMap(node => {
        const job = this.job(engine, node, settings); return job ? [job] : [];
      });
      // Preempt in-flight batch work only when the viewed position still needs
      // results: lanes are single-slot and one slow inference would otherwise
      // stall navigation. Jobs already targeting the new foreground, and batch
      // jobs when everything viewed is done, are left to finish undisturbed.
      const running = this.running[engine];
      const waiting = this.foreground[engine].some(job => !this.finished(job));
      if (running && waiting && !this.foreground[engine].some(job => job.key === running.key)) {
        this.controllers[engine]?.abort();
      }
      this.pump(engine);
    }
    this.emit();
  }
  clearForeground() { this.foreground = { sf: [], maia: [] }; }
  // Play-mode move feedback: Stockfish only, never Maia. A dedicated
  // coordinator per hook owns this lane so play evaluations cannot contend
  // with real play replies on the Maia workers or leak into analysis.
  foregroundSfOnly(nodes: ReviewNode[], settings: ReviewSettings) {
    this.active = true;
    this.foreground.maia = [];
    this.foreground.sf = nodes.slice(0, 2).flatMap(node => {
      const job = this.job('sf', node, settings); return job ? [job] : [];
    });
    const running = this.running.sf;
    const waiting = this.foreground.sf.some(job => !this.finished(job));
    if (running && waiting && !this.foreground.sf.some(job => job.key === running.key)) {
      this.controllers.sf?.abort();
    }
    this.pump('sf');
    this.emit();
  }
  retrySfOnly(nodes: ReviewNode[], settings: ReviewSettings) {
    for (const node of nodes) this.failures.delete(reviewKey('sf', node, settings));
    this.foregroundSfOnly(nodes, settings);
  }
  suspend() { this.active = false; this.clearForeground(); this.batch = null; this.emit(); }
  startBatch(nodes: ReviewNode[], settings: ReviewSettings) {
    if (nodes.length > 257) return;
    const total = nodes.reduce((count, node) => count + (terminalEvaluation(replay(node.moves, node.initialFen)) ? 0 : 2), 0);
    this.batch = { nodes, settings, total, cursor: { sf: 0, maia: 0 }, completed: new Set(), degradedMaia: false };
    this.timings = []; this.summaryLogged = false; this.executedKeys = new Set();
    this.active = true; this.pump('sf'); this.pump('maia'); this.emit();
  }
  // True once a fallback Maia answer settles inside the running batch.
  // Read at completion time: degraded rows expire from memory within seconds
  // and are never persisted server-side, so a post-hoc cache peek would miss
  // them and mislabel fallback batches as clean.
  batchDegraded() { return this.batch?.degradedMaia ?? false; }
  get progress() {
    if (!this.batch) return null;
    const failed = this.batch.nodes.reduce((count, node) => count + Number(!!this.error('sf', node, this.batch!.settings)) + Number(!!this.error('maia', node, this.batch!.settings)), 0);
    return { done: this.batch.completed.size, total: this.batch.total, failed, running: this.batch.completed.size < this.batch.total };
  }
  private recordTiming(job: Job, source: JobSource, ms: number, retries: number, failed = false) {
    const inBatch = this.batch?.nodes.some(node => reviewKey(job.engine, node, this.batch!.settings) === job.key) ?? false;
    this.timings.push({
      engine: job.engine, ply: job.node.moves.length,
      detail: job.engine === 'sf' ? stockfishPolicy(job.settings.stockfish) : `${job.settings.model}@${job.settings.eloMaia}`,
      source, ms: Math.max(0, Math.round(ms)), retries, batched: inBatch, ...(failed ? { failed: true as const } : {}),
    });
    if (this.timings.length > 2048) this.timings.splice(0, this.timings.length - 2048);
  }
  // Aggregates the current batch's timings for the completion log and tests.
  // firstHalfAvgMs vs secondHalfAvgMs splits live jobs by ply order: a slow
  // second half here reproduces the reported cliff independent of cache skew.
  batchTimingSummary(): BatchTimingSummary | null {
    if (!this.batch) return null;
    const live = this.progress!;
    const byEngine = Object.fromEntries((['sf', 'maia'] as const).map(engine => {
      const rows = this.timings.filter(timing => timing.engine === engine && timing.batched && !timing.failed);
      const liveRows = rows.filter(timing => timing.source === 'live').sort((a, b) => a.ply - b.ply);
      const liveMs = liveRows.map(timing => timing.ms);
      const avg = (values: number[]) => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
      const half = Math.ceil(liveMs.length / 2);
      return [engine, {
        live: liveMs.length,
        liveAvgMs: avg(liveMs) ?? 0,
        liveMaxMs: liveMs.length ? Math.max(...liveMs) : 0,
        serverHits: rows.filter(timing => timing.source === 'server-cache').length,
        memHits: rows.filter(timing => timing.source === 'memory').length,
        failed: this.timings.filter(timing => timing.engine === engine && timing.batched && timing.failed).length,
        firstHalfAvgMs: avg(liveMs.slice(0, half)),
        secondHalfAvgMs: avg(liveMs.slice(half)),
        liveMsByPly: liveRows.map(timing => [timing.ply, timing.ms] as [number, number]),
      } satisfies EngineTimingSummary];
    })) as Record<Engine, EngineTimingSummary>;
    return { total: live.total, done: live.done, failed: live.failed, byEngine };
  }
  private maybeLogBatchSummary() {
    if (!this.batch || this.summaryLogged || this.batch.completed.size < this.batch.total) return;
    this.summaryLogged = true;
    console.info('[review] batch timing', JSON.stringify(this.batchTimingSummary()));
  }
  retry() {
    // Abort in-flight lanes first: a wedged job (socket dead, promise never
    // settling) would otherwise keep `running` set and the pumps below would
    // no-op, leaving Retry a dead button. Aborted jobs are not marked failed
    // or completed; the finally handler re-pumps them from the reset cursor.
    for (const engine of ['sf', 'maia'] as const) this.controllers[engine]?.abort();
    this.failures.clear();
    if (this.batch) { this.batch.cursor = { sf: 0, maia: 0 }; this.batch.completed.clear(); this.batch.degradedMaia = false; }
    this.timings = []; this.summaryLogged = false; this.executedKeys = new Set();
    this.pump('sf'); this.pump('maia'); this.emit();
  }
  // Re-establish progress after the tab returns from the background. Aborts
  // jobs that straddled a long hide (their sockets may be dead while the
  // promises never settle) or outlived the stall budget, then re-pumps both
  // lanes. Aborted jobs stay at the cursor and retry; nothing is marked
  // failed. Never starts new work: with no in-memory batch (e.g. after a
  // reload) this only re-pumps an empty foreground, so restores still never
  // infer.
  resume(hiddenMs = 0) {
    if (!this.active) return;
    const now = Date.now();
    for (const engine of ['sf', 'maia'] as const) {
      if (!this.running[engine] || this.startedAt[engine] === undefined) continue;
      if (hiddenMs > RESUME_ABORT_AFTER_HIDDEN_MS || now - this.startedAt[engine]! > JOB_STALL_MS) {
        this.controllers[engine]?.abort();
      }
    }
    this.pump('sf'); this.pump('maia'); this.emit();
  }
  private finished(job: Job) { return !!this.cache[job.engine].peek(job.key) || this.failures.has(job.key); }
  private next(engine: Engine): Job | undefined {
    const foreground = this.foreground[engine].find(job => !this.finished(job));
    if (foreground) return foreground;
    const batch = this.batch;
    if (!batch) return;
    // Peek without consuming: an aborted or superseded job stays at the cursor
    // and is retried later instead of being lost. Only finished work advances it.
    while (batch.cursor[engine] < batch.nodes.length) {
      const job = this.job(engine, batch.nodes[batch.cursor[engine]], batch.settings);
      if (!job) { batch.cursor[engine]++; continue; }
      if (this.finished(job)) {
        batch.completed.add(job.key); batch.cursor[engine]++;
        // Cursor catch-up after this run's own live completion is not a hit.
        if (!this.executedKeys.has(job.key)) this.recordTiming(job, 'memory', 0, 0);
        // Memory-served fallback answers must flag the batch too: without
        // re-execution the settle handler never sees them, yet the batch
        // results still contain degraded rows unfit for recording.
        if (engine === 'maia' && (this.cache.maia.peek(job.key) as MoveResponse | undefined)?.degraded) batch.degradedMaia = true;
        continue;
      }
      return job;
    }
  }
  private pump(engine: Engine) {
    if (!this.active || this.running[engine]) return;
    const job = this.next(engine);
    if (!job) return;
    const controller = new AbortController();
    this.controllers[engine] = controller;
    this.running[engine] = job;
    this.startedAt[engine] = Date.now();
    const signal = controller.signal;
    void this.execute(job, signal).then(({ result, source, retries }) => {
      if (signal.aborted) return;
      this.executedKeys.add(job.key);
      this.recordTiming(job, source, Date.now() - (this.startedAt[engine] ?? Date.now()), retries);
      if (engine === 'sf') this.cache.sf.set(job.key, result as Evaluation);
      else {
        const degraded = (result as MoveResponse).degraded;
        this.cache.maia.set(job.key, result as MoveResponse, degraded ? 30_000 : Infinity);
        if (degraded && this.batch?.nodes.some(node => reviewKey(engine, node, this.batch!.settings) === job.key)) this.batch.degradedMaia = true;
      }
    }).catch(error => {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      this.executedKeys.add(job.key);
      this.recordTiming(job, 'live', Date.now() - (this.startedAt[engine] ?? Date.now()), 0, true);
      this.failures.set(job.key, error instanceof Error ? error.message : 'Analysis failed.');
      if (this.failures.size > 512) this.failures.delete(this.failures.keys().next().value!);
    }).finally(() => {
      if (this.controllers[engine]?.signal === signal) delete this.controllers[engine];
      const aborted = signal.aborted;
      delete this.running[engine];
      delete this.startedAt[engine];
      if (!aborted && this.batch?.nodes.some(node => reviewKey(engine, node, this.batch!.settings) === job.key)) this.batch.completed.add(job.key);
      this.pump(engine); this.emit(); this.maybeLogBatchSummary();
    });
  }
  // Prime memory caches from the server eval cache without inference. Reads
  // only: positions missing server-side stay missing for an explicit,
  // user-gated batch, so evicted rows can never trigger automatic engine
  // work. Terminals resolve locally and count as covered.
  async primeLine(nodes: ReviewNode[], settings: ReviewSettings, signal: AbortSignal): Promise<{ covered: number; total: number }> {
    const terminals = new Set<ReviewNode>();
    const pending: Job[] = [];
    for (const node of nodes) {
      const terminal = terminalEvaluation(replay(node.moves, node.initialFen));
      if (terminal) {
        terminals.add(node);
        this.cache.sf.set(reviewKey('sf', node, settings), { ...terminal, search_policy: stockfishPolicy(settings.stockfish) });
        continue;
      }
      for (const engine of ['sf', 'maia'] as const) {
        const key = reviewKey(engine, node, settings);
        if (!this.cache[engine].peek(key)) pending.push({ engine, node, settings, key });
      }
    }
    const lanes = Array.from({ length: Math.min(8, pending.length) }, async () => {
      while (pending.length) {
        signal.throwIfAborted();
        const job = pending.shift()!;
        const hit = await this.readServerCache(job, signal).catch(error => {
          if (error instanceof DOMException && error.name === 'AbortError') throw error;
          return undefined;
        });
        // Server rows are never degraded (fallbacks are not persisted), so a
        // validated hit is safe to keep indefinitely.
        if (hit) {
          if (job.engine === 'sf') this.cache.sf.set(job.key, hit as Evaluation);
          else this.cache.maia.set(job.key, hit as MoveResponse, Infinity);
        }
      }
    });
    await Promise.all(lanes);
    let covered = 0;
    for (const node of nodes) {
      if (this.cache.sf.peek(reviewKey('sf', node, settings)) &&
        (terminals.has(node) || this.cache.maia.peek(reviewKey('maia', node, settings)))) covered++;
    }
    this.emit();
    return { covered, total: nodes.length };
  }
  private async readServerCache(job: Job, signal: AbortSignal): Promise<Result | undefined> {
    let response: Response;
    // Cache probes are fast SQLite lookups; a probe that never settles (dead
    // socket after backgrounding) must degrade to a miss, never wedge the
    // lane or a prime. The race timer rejects independently of the fetcher so
    // it also covers fetchers that ignore the abort signal. A timeout falls
    // through to live inference, which re-probes before inferring.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([
        this.fetcher(`/evaluations/${cacheHash(job.key)}`, { signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DOMException('Timed out', 'TimeoutError')), CACHE_PROBE_MS);
        }),
      ]);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (response.status === 404) return undefined;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;
    const record = body as { engine?: unknown; value?: unknown };
    if (record.engine !== job.engine) return undefined;
    try {
      return job.engine === 'sf' ? parseEvaluation(record.value, job.settings.stockfish) : parseMoveResponse(record.value);
    } catch {
      return undefined;
    }
  }

  private storeServerCache(job: Job, result: Result): void {
    void (async () => {
      try {
        await this.fetcher(`/evaluations/${cacheHash(job.key)}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine: job.engine, key: job.key, value: result }),
        });
      } catch {
        // Best-effort: the memory cache still serves this session.
      }
    })();
  }

  private async execute(job: Job, signal: AbortSignal): Promise<{ result: Result; source: 'server-cache' | 'live'; retries: number }> {
    // Retry only busy responses, at most twice. Waiting remains in this lane so
    // another request cannot overtake a server job that has not been released.
    let retries = 0;
    const retryFetch: typeof fetch = async (input, init) => {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const response = await this.fetcher(input, { ...init, signal });
        if (response.status !== 503 || attempt === 2) return response;
        retries++;
        const header = response.headers.get('Retry-After');
        const seconds = header ? Number(header) : 1;
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header!) - Date.now();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, Math.max(1000, Number.isFinite(delay) ? delay : 1000));
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
        });
      }
    };
    const hit = await this.readServerCache(job, signal).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return undefined;
    });
    if (hit) return { result: hit, source: 'server-cache', retries };
    if (job.engine === 'sf') {
      const result = await fetchEvaluation(job.node, signal, retryFetch, job.settings.stockfish);
      this.storeServerCache(job, result);
      return { result, source: 'live', retries };
    }
    const result = await requestMove({ fen: job.node.fen, moves: job.node.moves, initial_fen: job.node.initialFen, elo_maia: job.settings.eloMaia, elo_user: job.settings.eloUser, model: job.settings.model, maia_color: new Chess(job.node.fen).turn() === 'w' ? 'white' : 'black' }, retryFetch, signal);
    // Fallback answers expire in memory within seconds; persisting them would
    // let a degraded stand-in masquerade as the requested model indefinitely.
    if (!result.degraded) this.storeServerCache(job, result);
    return { result, source: 'live', retries };
  }
}
