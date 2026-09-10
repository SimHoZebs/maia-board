import { Chess } from 'chess.js';
import { requestMove, type MoveResponse, type MaiaModel } from './api';
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
export async function fetchEvaluation(node: ReviewNode, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Evaluation> {
  const response = await fetcher('/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen: node.fen, moves: node.moves, initial_fen: node.initialFen }), signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `Stockfish request failed (${response.status}).`);
  if (body.engine !== 'Stockfish 19' || body.search_policy !== SEARCH_POLICY || !Number.isInteger(body.depth) || body.depth < 0 || !isScore(body.score) || ![null, 'white_win', 'black_win', 'draw'].includes(body.terminal) || !(body.best_move === null || typeof body.best_move === 'string') || !Array.isArray(body.lines) || !body.lines.every((line: Evaluation['lines'][number]) => typeof line.move === 'string' && isScore(line.score) && Number.isInteger(line.depth))) throw new Error('Stockfish returned an incomplete evaluation.');
  return body as Evaluation;
}
// Each lane has one in-flight job. Foreground replacement coalesces scrubbing;
// batch work is pulled one node at a time only when the foreground is empty.
export class ReviewCoordinator {
  private cache = { sf: new Lru<Evaluation>(), maia: new Lru<MoveResponse>() };
  private failures = new Map<string, string>();
  private foreground: Record<Engine, Job[]> = { sf: [], maia: [] };
  private running: Partial<Record<Engine, Job>> = {};
  private batch: { jobs: Job[]; cursor: Record<Engine, number>; completed: Set<string>; canceled: boolean } | null = null;
  private listeners = new Set<() => void>();
  private active = true;
  version = 0;
  constructor(private fetcher: typeof fetch = fetch) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  private emit() { this.version++; this.listeners.forEach(listener => listener()); }
  result<E extends Engine>(engine: E, node: ReviewNode, settings: ReviewSettings): (E extends 'sf' ? Evaluation : MoveResponse) | undefined {
    return this.cache[engine].get(reviewKey(engine, node, settings)) as (E extends 'sf' ? Evaluation : MoveResponse) | undefined;
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
  suspend() { this.active = false; this.clearForeground(); this.cancelBatch(); }
  startBatch(nodes: ReviewNode[], settings: ReviewSettings) {
    const jobs = nodes.flatMap(node => (['sf', 'maia'] as const).flatMap(engine => { const job = this.job(engine, node, settings); return job ? [job] : []; }));
    this.batch = { jobs, cursor: { sf: 0, maia: 0 }, completed: new Set(), canceled: false };
    this.active = true; this.pump('sf'); this.pump('maia'); this.emit();
  }
  cancelBatch() { if (this.batch) this.batch.canceled = true; this.emit(); }
  get progress() {
    if (!this.batch) return null;
    return { done: this.batch.completed.size, total: this.batch.jobs.length, running: !this.batch.canceled && this.batch.completed.size < this.batch.jobs.length, canceled: this.batch.canceled };
  }
  retry() { this.failures.clear(); this.pump('sf'); this.pump('maia'); this.emit(); }
  private finished(job: Job) { return !!this.cache[job.engine].get(job.key) || this.failures.has(job.key); }
  private next(engine: Engine): Job | undefined {
    const foreground = this.foreground[engine].find(job => !this.finished(job));
    if (foreground) return foreground;
    const batch = this.batch;
    if (!batch || batch.canceled) return;
    while (batch.cursor[engine] < batch.jobs.length) {
      const job = batch.jobs[batch.cursor[engine]++];
      if (job.engine !== engine) continue;
      if (this.finished(job)) { batch.completed.add(job.key); continue; }
      return job;
    }
  }
  private pump(engine: Engine) {
    if (!this.active || this.running[engine]) return;
    const job = this.next(engine);
    if (!job) return;
    this.running[engine] = job;
    void this.execute(job).then(result => {
      if (engine === 'sf') this.cache.sf.set(job.key, result as Evaluation);
      else this.cache.maia.set(job.key, result as MoveResponse, (result as MoveResponse).degraded ? 30_000 : Infinity);
    }).catch(error => {
      this.failures.set(job.key, error instanceof Error ? error.message : 'Analysis failed.');
      if (this.failures.size > 512) this.failures.delete(this.failures.keys().next().value!);
    }).finally(() => {
      delete this.running[engine];
      if (this.batch?.jobs.some(item => item.key === job.key)) this.batch.completed.add(job.key);
      this.pump(engine); this.emit();
    });
  }
  private async execute(job: Job): Promise<Result> {
    const signal = new AbortController().signal;
    // Retry only busy responses, at most twice. Waiting remains in this lane so
    // another request cannot overtake a server job that has not been released.
    const retryFetch: typeof fetch = async (input, init) => {
      for (let attempt = 0; ; attempt++) {
        const response = await this.fetcher(input, init);
        if (response.status !== 503 || attempt === 2) return response;
        const header = response.headers.get('Retry-After');
        const seconds = header ? Number(header) : 1;
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header!) - Date.now();
        await new Promise(resolve => setTimeout(resolve, Math.max(1000, Number.isFinite(delay) ? delay : 1000)));
      }
    };
    if (job.engine === 'sf') return fetchEvaluation(job.node, signal, retryFetch);
    return requestMove({ fen: job.node.fen, moves: job.node.moves, initial_fen: job.node.initialFen, elo_maia: job.settings.eloMaia, elo_user: job.settings.eloUser, model: job.settings.model, maia_color: new Chess(job.node.fen).turn() === 'w' ? 'white' : 'black' }, retryFetch, signal);
  }
}
