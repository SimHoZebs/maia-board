import { MaiaApiError, requestMove, type MoveResponse } from './api';
import { clampMaiaElo } from './BoardTools';
import type { Evaluation } from './reviewMetrics';
import { EvaluationStore, evaluationStore, evaluationRequest, fetchEvaluation, reviewKey, resolveSettings, stablePositionKey,
  type Engine, type EvaluationResult, type Job, type ReviewNode, type ReviewSettings, type SettingsInput } from './evaluationStore';
import { cancelBatch } from './batchReview';
export { EvaluationStore, fetchEvaluation, parseEvaluation, resolveSettings, reviewKey, reviewNodes, stablePositionKey,
  type Engine, type EvaluationResult, type Job, type ReviewNode, type ReviewSettings, type SettingsInput } from './evaluationStore';

export function subscribeNone(): () => void { return () => undefined; }

// Abort scope: one lineKey owns its foreground work and its batch job.
// lineKey = hash(initialFen + moves). A line change or unmount aborts the
// previous scope's controller (foreground signal) and DELETEs its batch job
// when the job's scope still matches. Backgrounding never aborts: only an
// explicit scope change or unmount cancels.
export type LineScope = { lineKey: string; controller: AbortController; signal: AbortSignal };
export function createLineScope(lineKey: string): LineScope {
  const controller = new AbortController();
  return { lineKey, controller, signal: controller.signal };
}
export function cancelScope(scope: LineScope): void {
  scope.controller.abort();
}
// Game-delete path (owned by another agent): cancel a batch job directly.
// Settled cache rows survive; only the running job is dropped.
export function cancelJob(jobId: string, fetcher: typeof fetch = fetch): Promise<void> {
  return cancelBatch(jobId, fetcher).catch(() => undefined);
}

type Pending = { job: Job };
type Running = { job: Job; controller: AbortController };
const engines = ['sf', 'maia'] as const;

// One keyed queue per engine for interactive (foreground) work: immediate
// priority requests preempt each other latest-wins. Whole-game batches run
// on the server (see batchReview); this scheduler never queues them, so it
// stays a small foreground pump plus the cache-restore path. The ONLY
// foreground cancel path is the AbortSignal passed to ensure(); there are no
// clearForeground/suspend/resume entry points.
export class ReviewCoordinator {
  readonly store: EvaluationStore;
  private pending: Record<Engine, Map<string, Pending>> = { sf: new Map(), maia: new Map() };
  private running: Partial<Record<Engine, Running>> = {};
  private failures = new Map<string, string>();
  private restoring = new Map<string, { count: number; engine: Engine }>();
  private listeners = new Set<() => void>();
  private version = 0;
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
  // Passing signal makes this ensure call abortable: aborting removes its
  // queued jobs and aborts its running jobs. Omitting signal queues
  // latest-wins foreground work that the next priority ensure replaces.
  ensure(
    nodes: ReviewNode[],
    settings: SettingsInput,
    opts: { priority?: boolean; engines?: Engine[]; signal?: AbortSignal } = {},
  ): Promise<{ total: number; covered: number }> | void {
    const { priority = false, engines: enginesOpt, signal } = opts;
    const wanted = (enginesOpt ?? [...engines]) as Engine[];
    if (priority) {
      const desired: Job[] = [];
      for (const node of nodes) for (const engine of wanted) {
        const job = this.job(engine, node, resolveSettings(settings, node));
        if (job) desired.push(job);
      }
      // Latest-wins within this workspace: the new set replaces queued work
      // for the same engines. Running stale work is preempted below.
      for (const engine of wanted) this.pending[engine].clear();
      for (const job of desired) {
        this.failures.delete(job.key);
        this.pending[job.engine].set(job.key, { job });
      }
      if (signal) {
        const keys = new Set(desired.map(job => job.key));
        if (signal.aborted) {
          for (const job of desired) this.pending[job.engine].delete(job.key);
          for (const engine of wanted) if (this.running[engine] && keys.has(this.running[engine]!.job.key)) this.abort(engine);
        } else {
          // NOTE: one listener per priority ensure on the long-lived scope
          // signal; stale entries fire once on scope teardown (bounded: tens
          // per line, each scanning its small desired set). If profiling ever
          // shows this hot, track and remove each listener when its desired
          // keys all finish instead of letting teardown sweep them.
          const onAbort = () => {
            for (const job of desired) {
              if (this.pending[job.engine].get(job.key)?.job === job) this.pending[job.engine].delete(job.key);
            }
            for (const engine of wanted) if (this.running[engine] && keys.has(this.running[engine]!.job.key)) this.abort(engine);
            this.notify();
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      for (const engine of wanted) {
        const current = this.running[engine];
        const waiting = [...this.pending[engine].values()].some(entry => !this.finished(entry.job));
        if (current && waiting && !this.pending[engine].get(current.job.key)) this.abort(engine);
      }
      wanted.forEach(engine => this.pump(engine));
      this.notify();
    }
    if (signal && !priority) return this.restore(nodes, settings, signal, wanted);
    if (signal && priority) {
      // Priority + signal callers that also need coverage use the restore
      // path through the same signal; foreground abort stays signal-driven.
      // Fire-and-forget is the common case, so only return coverage when the
      // caller asked for a non-priority restore. Priority callers that need
      // coverage call ensure twice (once priority, once with signal only).
    }
  }
  private async restore(nodes: ReviewNode[], settings: SettingsInput, signal: AbortSignal, wanted: Engine[]) {
    const keys = new Map(nodes.filter(node => !node.outcome).flatMap(node => wanted.map(engine => [reviewKey(engine, node, resolveSettings(settings, node)), engine] as const)));
    for (const [key, engine] of keys) this.restoring.set(key, { count: (this.restoring.get(key)?.count ?? 0) + 1, engine });
    this.notify();
    try {
      await this.store.prime(nodes, settings, [...wanted], signal);
      return this.store.primeCoverage(nodes, settings, [...wanted]);
    } finally {
      for (const [key, engine] of keys) {
        const entry = this.restoring.get(key);
        if (!entry) continue;
        if (entry.count > 1) this.restoring.set(key, { count: entry.count - 1, engine });
        else this.restoring.delete(key);
      }
      this.notify();
    }
  }
  sfPendingKeys(): Set<string> {
    return this.pendingKeys('sf');
  }
  maiaPendingKeys(): Set<string> {
    return this.pendingKeys('maia');
  }
  private pendingKeys(engine: Engine): Set<string> {
    const keys = new Set([...this.restoring].filter(([, entry]) => entry.engine === engine).map(([key]) => key));
    for (const { job } of this.pending[engine].values()) if (!this.finished(job)) keys.add(job.key);
    const running = this.running[engine];
    if (running && !this.finished(running.job)) keys.add(running.job.key);
    return keys;
  }
  isPending(engine: Engine, node: ReviewNode, settings: ReviewSettings): boolean {
    const key = reviewKey(engine, node, settings);
    if (node.outcome || this.store.peek(engine, key) || this.failures.has(key)) return false;
    return this.restoring.has(key) || this.pending[engine].has(key) || this.running[engine]?.job.key === key;
  }
  retry() {
    for (const engine of engines) this.abort(engine);
    this.failures.clear();
    engines.forEach(engine => this.pump(engine)); this.notify();
  }
  // Drop queued (not running) jobs for one engine, optionally limited to a
  // key set. Grants are non-preemptive, so running work still completes and
  // its sentence arrives free. Used by the play fast path: SF-settled
  // non-best moves need no Maia for their badge, so queued Maia predictions
  // for them are pure queue-slot waste.
  cancelQueued(engine: Engine, keys?: ReadonlySet<string>) {
    let dropped = false;
    for (const key of [...this.pending[engine].keys()]) {
      if (keys && !keys.has(key)) continue;
      this.pending[engine].delete(key);
      dropped = true;
    }
    if (dropped) this.notify();
  }
  private abort(engine: Engine) {
    const running = this.running[engine];
    delete this.running[engine];
    running?.controller.abort();
  }
  private pump(engine: Engine) {
    if (this.running[engine]) return;
    const entry = [...this.pending[engine].values()].find(entry => !this.finished(entry.job));
    if (!entry) return;
    const job = entry.job;
    const running: Running = { job, controller: new AbortController() };
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
      elo_maia: clampMaiaElo(job.settings.eloMaia), elo_user: clampMaiaElo(job.settings.eloUser), model: job.settings.model, maia_color: job.node.turn }, this.fetcher, signal);
  }
}
