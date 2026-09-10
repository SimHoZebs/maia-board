import { Chess } from 'chess.js';
import { parseMoveResponse, requestMove, type MoveResponse, type MaiaModel } from './api';
import { replay } from './domain';
import { SEARCH_POLICY, terminalEvaluation, type Evaluation, type Score } from './reviewMetrics';

export type ReviewNode = { initialFen: string; moves: string[]; fen: string };
export type ReviewSettings = { eloMaia: number; eloUser: number; model: MaiaModel };
export type Engine = 'sf' | 'maia';
type Result = Evaluation | MoveResponse;
type Job = { key: string; engine: Engine; node: ReviewNode; settings: ReviewSettings };
const MAIA_REF = '1e13597c42d4858b7cfd7cfdae01e297263364b2';
export function reviewKey(engine: Engine, node: ReviewNode, settings: ReviewSettings): string {
  return JSON.stringify([new Chess(node.initialFen).fen(), node.moves, engine === 'sf' ? SEARCH_POLICY : [settings.eloMaia, settings.eloUser, settings.model, MAIA_REF]]);
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

export function parseEvaluation(body: unknown): Evaluation {
  if (!body || typeof body !== 'object') throw new Error('Stockfish returned an incomplete evaluation.');
  const value = body as Evaluation & { engine?: unknown; search_policy?: unknown };
  if (value.engine !== 'Stockfish 19' || value.search_policy !== SEARCH_POLICY || !Number.isInteger(value.depth) || value.depth < 0 || !isScore(value.score) || ![null, 'white_win', 'black_win', 'draw'].includes(value.terminal) || !(value.best_move === null || typeof value.best_move === 'string') || !Array.isArray(value.lines)) throw new Error('Stockfish returned an incomplete evaluation.');
  if (value.terminal !== null) {
    if (value.best_move !== null || value.lines.length !== 0 || value.depth !== 0) throw new Error('Stockfish returned an incomplete evaluation.');
    if (value.terminal === 'draw') {
      if (value.score.type !== 'cp' || value.score.value !== 0) throw new Error('Stockfish returned an incomplete evaluation.');
    } else {
      const winner = value.terminal === 'white_win' ? 'white' : 'black';
      if (value.score.type !== 'mate' || value.score.value !== 0 || value.score.winning_side !== winner) throw new Error('Stockfish returned an incomplete evaluation.');
    }
  } else {
    if (value.lines.length < 1 || value.lines.length > 2) throw new Error('Stockfish returned an incomplete evaluation.');
    if (typeof value.best_move !== 'string' || value.best_move !== value.lines[0].move) throw new Error('Stockfish returned an incomplete evaluation.');
    if (!value.lines.every(line => typeof line.move === 'string' && isScore(line.score) && Number.isInteger(line.depth) && line.depth >= 1)) throw new Error('Stockfish returned an incomplete evaluation.');
    const depths = value.lines.map(line => line.depth);
    if (value.depth < Math.min(...depths) || value.depth < 1) throw new Error('Stockfish returned an incomplete evaluation.');
    if (!sameScore(value.score, value.lines[0].score)) throw new Error('Stockfish returned an incomplete evaluation.');
  }
  return value;
}

export async function fetchEvaluation(node: ReviewNode, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Evaluation> {
  const response = await fetcher('/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen: node.fen, moves: node.moves, initial_fen: node.initialFen }), signal });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
      ? (body as { message: string }).message : `Stockfish request failed (${response.status}).`;
    throw new Error(message);
  }
  return parseEvaluation(body);
}
// Each lane has one in-flight job. Foreground replacement coalesces scrubbing;
// batch work is pulled one node at a time only when the foreground is empty.
export class ReviewCoordinator {
  private cache = { sf: new Lru<Evaluation>(), maia: new Lru<MoveResponse>() };
  private failures = new Map<string, string>();
  private foreground: Record<Engine, Job[]> = { sf: [], maia: [] };
  private running: Partial<Record<Engine, Job>> = {};
  private controllers: Partial<Record<Engine, AbortController>> = {};
  private batch: { nodes: ReviewNode[]; settings: ReviewSettings; cursor: Record<Engine, number>; total: number; completed: Set<string>; canceled: boolean } | null = null;
  private listeners = new Set<() => void>();
  private active = true;
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
      if (engine === 'sf') this.cache.sf.set(reviewKey(engine, node, settings), terminal);
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
      this.pump(engine);
    }
    this.emit();
  }
  clearForeground() { this.foreground = { sf: [], maia: [] }; }
  suspend() { this.active = false; this.clearForeground(); this.batch = null; this.emit(); }
  startBatch(nodes: ReviewNode[], settings: ReviewSettings) {
    if (nodes.length > 257) return;
    const total = nodes.reduce((count, node) => count + (terminalEvaluation(replay(node.moves, node.initialFen)) ? 0 : 2), 0);
    this.batch = { nodes, settings, total, cursor: { sf: 0, maia: 0 }, completed: new Set(), canceled: false };
    this.active = true; this.pump('sf'); this.pump('maia'); this.emit();
  }
  cancelBatch() { if (this.batch) this.batch.canceled = true; this.emit(); }
  get progress() {
    if (!this.batch) return null;
    const failed = this.batch.nodes.reduce((count, node) => count + Number(!!this.error('sf', node, this.batch!.settings)) + Number(!!this.error('maia', node, this.batch!.settings)), 0);
    return { done: this.batch.completed.size, total: this.batch.total, failed, running: !this.batch.canceled && this.batch.completed.size < this.batch.total, canceled: this.batch.canceled };
  }
  retry() {
    this.failures.clear();
    if (this.batch) { this.batch.cursor = { sf: 0, maia: 0 }; this.batch.completed.clear(); this.batch.canceled = false; }
    this.pump('sf'); this.pump('maia'); this.emit();
  }
  private finished(job: Job) { return !!this.cache[job.engine].peek(job.key) || this.failures.has(job.key); }
  private next(engine: Engine): Job | undefined {
    const foreground = this.foreground[engine].find(job => !this.finished(job));
    if (foreground) return foreground;
    const batch = this.batch;
    if (!batch || batch.canceled) return;
    while (batch.cursor[engine] < batch.nodes.length) {
      const job = this.job(engine, batch.nodes[batch.cursor[engine]++], batch.settings);
      if (!job) continue;
      if (this.finished(job)) { batch.completed.add(job.key); continue; }
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
    const signal = controller.signal;
    void this.execute(job, signal).then(result => {
      if (signal.aborted) return;
      if (engine === 'sf') this.cache.sf.set(job.key, result as Evaluation);
      else this.cache.maia.set(job.key, result as MoveResponse, (result as MoveResponse).degraded ? 30_000 : Infinity);
    }).catch(error => {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      this.failures.set(job.key, error instanceof Error ? error.message : 'Analysis failed.');
      if (this.failures.size > 512) this.failures.delete(this.failures.keys().next().value!);
    }).finally(() => {
      if (this.controllers[engine]?.signal === signal) delete this.controllers[engine];
      const aborted = signal.aborted;
      delete this.running[engine];
      if (!aborted && this.batch?.nodes.some(node => reviewKey(engine, node, this.batch!.settings) === job.key)) this.batch.completed.add(job.key);
      this.pump(engine); this.emit();
    });
  }
  private async readServerCache(job: Job, signal: AbortSignal): Promise<Result | undefined> {
    let response: Response;
    try {
      response = await this.fetcher(`/evaluations/${cacheHash(job.key)}`, { signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return undefined;
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
      return job.engine === 'sf' ? parseEvaluation(record.value) : parseMoveResponse(record.value);
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

  private async execute(job: Job, signal: AbortSignal): Promise<Result> {
    // Retry only busy responses, at most twice. Waiting remains in this lane so
    // another request cannot overtake a server job that has not been released.
    const retryFetch: typeof fetch = async (input, init) => {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        const response = await this.fetcher(input, { ...init, signal });
        if (response.status !== 503 || attempt === 2) return response;
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
    if (hit) return hit;
    if (job.engine === 'sf') {
      const result = await fetchEvaluation(job.node, signal, retryFetch);
      this.storeServerCache(job, result);
      return result;
    }
    const result = await requestMove({ fen: job.node.fen, moves: job.node.moves, initial_fen: job.node.initialFen, elo_maia: job.settings.eloMaia, elo_user: job.settings.eloUser, model: job.settings.model, maia_color: new Chess(job.node.fen).turn() === 'w' ? 'white' : 'black' }, retryFetch, signal);
    // Fallback answers expire in memory within seconds; persisting them would
    // let a degraded stand-in masquerade as the requested model indefinitely.
    if (!result.degraded) this.storeServerCache(job, result);
    return result;
  }
}
