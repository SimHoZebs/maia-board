import { MaiaApiError, requestMove, type MoveResponse } from './api';
import type { Evaluation } from './reviewMetrics';
import { EvaluationStore, evaluationStore, evaluationRequest, fetchEvaluation, reviewKey, resolveSettings, stablePositionKey,
  type Engine, type EvaluationResult, type Job, type ReviewNode, type ReviewSettings, type SettingsInput } from './evaluationStore';
export { EvaluationStore, fetchEvaluation, parseEvaluation, resolveSettings, reviewKey, reviewNodes, stablePositionKey,
  type Engine, type EvaluationResult, type Job, type ReviewNode, type ReviewSettings, type SettingsInput } from './evaluationStore';

export const JOB_STALL_MS = 150_000;
export const RESUME_ABORT_AFTER_HIDDEN_MS = 10_000;
export function subscribeNone(): () => void { return () => undefined; }
type Pending = { job: Job };
type Running = { job: Job; controller: AbortController; started: number };
const engines = ['sf', 'maia'] as const;

// One keyed queue per engine for interactive (foreground) work: immediate
// priority requests preempt each other latest-wins. Whole-game batches run
// on the server (see batchReview); this scheduler never queues them, so it
// stays a small foreground pump plus the cache-restore path.
export class ReviewCoordinator {
  readonly store: EvaluationStore;
  private pending: Record<Engine, Map<string, Pending>> = { sf: new Map(), maia: new Map() };
  private running: Partial<Record<Engine, Running>> = {};
  private failures = new Map<string, string>();
  private restoring = new Map<string, { count: number; engine: Engine }>();
  private restores = new Set<AbortController>();
  private listeners = new Set<() => void>();
  private version = 0;
  private active = true;
  constructor(private fetcher: typeof fetch = (input, init) => fetch(input, init), store?: EvaluationStore) {
    // An injected transport is an isolated test/application scope. Normal
    // workspace construction shares the app's settled-result store.
    this.store = store ?? (arguments.length ? new EvaluationStore(fetcher) : evaluationStore);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const unsubscribe = this.store.subscribe(listener);
    return () => { this.listeners.delete(listener); unsubscribe(); };
  };
  snapshot = () => this.version + this.store.version;
  private notify() { this.version++; this.listeners.forEach(listener => listener()); }
  result<E extends Engine>(engine: E, node: ReviewNode, settings: ReviewSettings): (E extends 'sf' ? EvaluationResult : MoveResponse) | undefined { return this.store.result(engine, node, settings); }
  error(engine: Engine, node: ReviewNode, settings: ReviewSettings) { return this.failures.get(reviewKey(engine, node, settings)); }
  // Server-batch failures live in the same map so the UI has one error
  // source. Keys from the previous batch are dropped; unrelated (foreground)
  // failures are left alone.
  replaceFailures(keys: Set<string>, errors: Map<string, string>) {
    for (const key of keys) this.failures.delete(key);
    for (const [key, message] of errors) this.failures.set(key, message);
    this.notify();
  }
  private job(engine: Engine, node: ReviewNode, settings: ReviewSettings): Job | null {
    if (node.outcome || node.ply > 256) return null;
    return { engine, node, settings, key: reviewKey(engine, node, settings) };
  }
  private finished(job: Job) { return !!this.store.peek(job.engine, job.key) || this.failures.has(job.key); }
  // Queue-only calls return void synchronously; signal calls return coverage.
  ensure(
    nodes: ReviewNode[],
    settings: SettingsInput,
    opts: { priority?: boolean; engines?: Engine[]; signal?: AbortSignal } = {},
  ): Promise<{ total: number; covered: number }> | void {
    const { priority = false, engines: enginesOpt, signal } = opts;
    const wanted = (enginesOpt ?? [...engines]) as Engine[];
    if (priority) {
      this.active = true;
      this.clearForeground();
      const desired: Job[] = [];
      for (const node of nodes) for (const engine of wanted) {
        const job = this.job(engine, node, resolveSettings(settings, node));
        if (job) desired.push(job);
      }
      for (const job of desired) {
        this.failures.delete(job.key);
        this.pending[job.engine].set(job.key, { job });
      }
      for (const engine of wanted) {
        const current = this.running[engine];
        const waiting = [...this.pending[engine].values()].some(entry => !this.finished(entry.job));
        if (current && waiting && !this.pending[engine].get(current.job.key)) this.abort(engine);
      }
      wanted.forEach(engine => this.pump(engine));
      this.notify();
    }
    if (signal) return this.restore(nodes, settings, signal, wanted);
  }
  clearForeground() {
    for (const engine of engines) this.pending[engine].clear();
  }
  suspend() {
    this.active = false;
    this.restores.forEach(controller => controller.abort());
    for (const engine of engines) { this.abort(engine); this.pending[engine].clear(); }
    this.notify();
  }
  private async restore(nodes: ReviewNode[], settings: SettingsInput, signal: AbortSignal, wanted: Engine[]) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort, { once: true });
    this.restores.add(controller);
    const keys = new Map(nodes.filter(node => !node.outcome).flatMap(node => wanted.map(engine => [reviewKey(engine, node, resolveSettings(settings, node)), engine] as const)));
    for (const [key, engine] of keys) this.restoring.set(key, { count: (this.restoring.get(key)?.count ?? 0) + 1, engine });
    this.notify();
    try {
      await this.store.prime(nodes, settings, [...wanted], controller.signal);
      return this.store.primeCoverage(nodes, settings, [...wanted]);
    } finally {
      this.restores.delete(controller); signal.removeEventListener('abort', abort);
      for (const [key, engine] of keys) { const count = this.restoring.get(key)!.count - 1; if (count) this.restoring.set(key, { count, engine }); else this.restoring.delete(key); }
      this.notify();
    }
  }
  sfPendingKeys(): Set<string> {
    const keys = new Set([...this.restoring].filter(([, entry]) => entry.engine === 'sf').map(([key]) => key));
    for (const { job } of this.pending.sf.values()) if (!this.finished(job)) keys.add(job.key);
    const running = this.running.sf;
    if (running && !this.finished(running.job)) keys.add(running.job.key);
    return keys;
  }
  isPending(engine: Engine, node: ReviewNode, settings: ReviewSettings): boolean {
    const key = reviewKey(engine, node, settings);
    if (node.outcome || this.store.peek(engine, key) || this.failures.has(key)) return false;
    return this.restoring.has(key) || this.active && (this.pending[engine].has(key) || this.running[engine]?.job.key === key);
  }
  retry() {
    for (const engine of engines) this.abort(engine);
    this.failures.clear();
    engines.forEach(engine => this.pump(engine)); this.notify();
  }
  resume(hiddenMs = 0) {
    if (!this.active) return;
    for (const engine of engines) {
      const running = this.running[engine];
      if (running && (hiddenMs > RESUME_ABORT_AFTER_HIDDEN_MS || Date.now() - running.started > JOB_STALL_MS)) this.abort(engine);
      this.pump(engine);
    }
    this.notify();
  }
  private abort(engine: Engine) {
    const running = this.running[engine];
    delete this.running[engine];
    running?.controller.abort();
  }
  private pump(engine: Engine) {
    if (!this.active || this.running[engine]) return;
    const entry = [...this.pending[engine].values()].find(entry => !this.finished(entry.job));
    if (!entry) return;
    const job = entry.job;
    const running: Running = { job, controller: new AbortController(), started: Date.now() };
    this.running[engine] = running;
    void this.execute(job, running.controller.signal).then(result => {
      if (this.running[engine] !== running) return;
      if (engine === 'sf') this.store.store('sf', job.key, result as Evaluation);
      else this.store.store('maia', job.key, result as MoveResponse);
    }).catch(error => {
      if (this.running[engine] !== running || running.controller.signal.aborted) return;
      // A superseded focus request was replaced by a newer one; the newer
      // request covers the position, so this is not a failure to surface.
      if (error instanceof MaiaApiError && error.code === 'superseded') return;
      this.failures.set(job.key, error instanceof Error ? error.message : 'Analysis failed.');
    }).finally(() => {
      // A late completion belongs to its generation, even for the same key.
      if (this.running[engine] !== running) return;
      delete this.running[engine]; this.pump(engine); this.notify();
    });
  }
  private async execute(job: Job, signal: AbortSignal): Promise<Evaluation | MoveResponse> {
    if (job.engine === 'sf') return fetchEvaluation(job.node, signal, this.fetcher, job.settings.stockfish);
    const request = evaluationRequest('maia', job.node, job.settings);
    return requestMove({ fen: request.fen, moves: request.moves, initial_fen: request.initial_fen,
      elo_maia: job.settings.eloMaia, elo_user: job.settings.eloUser, model: job.settings.model, maia_color: job.node.turn }, this.fetcher, signal);
  }
}
