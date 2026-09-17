import { MaiaApiError, requestMove, type MoveResponse } from './api';
import { clampMaiaElo } from './BoardTools';
import type { Evaluation } from './reviewMetrics';
import { EvaluationStore, evaluationStore, evaluationRequest, fastReviewSettings, fetchEvaluation, reviewKey, resolveSettings, stablePositionKey,
  type Engine, type EvaluationResult, type Job, type ReviewNode, type ReviewSettings, type SettingsInput } from './evaluationStore';
export { EvaluationStore, buildPrimeJobs, fastReviewSettings, fastStockfishSettings, fetchEvaluation, parseEvaluation, primeWithPriority, reorderJobsForPriority, resolveSettings, reviewKey, reviewNodes, stablePositionKey,
  type Engine, type EvaluationResult, type Job, type ReviewNode, type ReviewSettings, type SettingsInput } from './evaluationStore';

export function subscribeNone(): () => void { return () => undefined; }

// Abort scope: one lineKey owns its foreground work. Batch jobs are never
// cancelled: scope change only drops local optimism.
// lineKey = hash(initialFen + moves). A line change or unmount aborts the
// previous scope's controller (foreground signal). Backgrounding never aborts.
export type LineScope = { lineKey: string; controller: AbortController; signal: AbortSignal };
export function createLineScope(lineKey: string): LineScope {
  const controller = new AbortController();
  return { lineKey, controller, signal: controller.signal };
}
export function cancelScope(scope: LineScope): void {
  scope.controller.abort();
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
  private running: Record<Engine, Set<Running>> = { sf: new Set(), maia: new Set() };
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
  result(engine: 'sf', node: ReviewNode, settings: ReviewSettings): EvaluationResult | undefined;
  result(engine: 'maia', node: ReviewNode, settings: ReviewSettings): MoveResponse | undefined;
  result(engine: Engine, node: ReviewNode, settings: ReviewSettings): EvaluationResult | MoveResponse | undefined;
  result(engine: Engine, node: ReviewNode, settings: ReviewSettings): EvaluationResult | MoveResponse | undefined {
    return this.store.result(engine, node, settings);
  }
  error(engine: Engine, node: ReviewNode, settings: ReviewSettings) { return this.failures.get(reviewKey(engine, node, settings)); }
  // Server-batch failures live in the same map so the UI has one error
  // source. Keys from the previous batch are dropped; unrelated (foreground)
  // failures are left alone.
  replaceFailures(keys: Set<string>, errors: Map<string, string>) {
    for (const key of keys) this.failures.delete(key);
    for (const [key, message] of errors) this.failures.set(key, message);
    this.notify();
  }
  // Provisional first-paint read for the display layer: full MPV2 when
  // present, else the fast MPV1 row. Score/verdict render from fast;
  // coverage and the candidate-list completeness check use exact result().
  provisionalSfResult(node: ReviewNode, settings: ReviewSettings): EvaluationResult | undefined {
    return this.store.provisionalSfResult(node, settings);
  }
  private job(engine: Engine, node: ReviewNode, settings: ReviewSettings, fast = false): Job | null {
    if (node.outcome || node.ply > 256) return null;
    return { engine, node, settings, key: reviewKey(engine, node, settings), ...(fast ? { fast: true as const } : {}) };
  }
  private finished(job: Job) { return !!this.store.peek(job.engine, job.key) || this.failures.has(job.key); }
  // Queue-only calls return void synchronously; signal calls return coverage.
  // Passing signal makes this ensure call abortable: aborting removes its
  // queued jobs and aborts its running jobs. Omitting signal queues
  // latest-wins foreground work; the next priority ensure replaces queued
  // work only and lets running work land.
  ensure(
    nodes: ReviewNode[],
    settings: SettingsInput,
    opts: { priority?: boolean; engines?: Engine[]; signal?: AbortSignal; priorityPlies?: readonly number[]; fastFirst?: boolean } = {},
  ): Promise<{ total: number; covered: number }> | void {
    const { priority = false, engines: enginesOpt, signal, priorityPlies, fastFirst = false } = opts;
    const wanted = enginesOpt ?? [...engines];
    if (priority) {
      const desired: Job[] = [];
      // Fast-then-refine (foreground focus/current only, never bulk prime):
      // queue fast MPV1 jobs ahead of the full MPV2 jobs on the sf lane so
      // rank-1 lands first (~250ms) and the full list refines after (~750ms).
      // Maia lanes queue once as before. Skip fast when full already settles
      // (no extra fetch) or when fast already settles (queue full only).
      const useFast = fastFirst && wanted.includes('sf');
      if (useFast) {
        const fastJobs: Job[] = [];
        const fullJobs: Job[] = [];
        for (const node of nodes) {
          const fullSettings = resolveSettings(settings, node);
          const full = this.job('sf', node, fullSettings);
          if (!full) continue;
          if (this.store.peek('sf', full.key)) continue;
          const fastSettings = fastReviewSettings(fullSettings);
          if (fastSettings) {
            const fast = this.job('sf', node, fastSettings, true);
            if (fast && fast.key !== full.key && !this.store.peek('sf', fast.key)) fastJobs.push(fast);
          }
          fullJobs.push(full);
        }
        desired.push(...fastJobs, ...fullJobs);
        for (const node of nodes) for (const engine of wanted) {
          if (engine === 'sf') continue;
          const job = this.job(engine, node, resolveSettings(settings, node));
          if (job) desired.push(job);
        }
      } else {
        for (const node of nodes) for (const engine of wanted) {
          const job = this.job(engine, node, resolveSettings(settings, node));
          if (job) desired.push(job);
        }
      }
      // Latest-wins within this workspace: the new set replaces queued work
      // for the same engines. Running work continues (non-preemptive server
      // slot) and lands via its generation below.
      for (const engine of wanted) this.pending[engine].clear();
      for (const job of desired) {
        this.failures.delete(job.key);
        this.pending[job.engine].set(job.key, { job });
      }
      if (signal) {
        const keys = new Set(desired.map(job => job.key));
        if (signal.aborted) {
          for (const job of desired) this.pending[job.engine].delete(job.key);
          for (const engine of wanted) this.abortKeys(engine, keys);
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
            for (const engine of wanted) this.abortKeys(engine, keys);
            this.notify();
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      // Supersede drops only still-queued work (pending cleared above). The
      // server slot is non-preemptive: running work always completes and
      // caches, so aborting only blinds this tab to a paid-for answer. Let
      // running fetches continue; pump starts the newest wanted work
      // concurrently (deduplicated by key below).
      wanted.forEach(engine => this.pump(engine));
      this.notify();
    }
    if (signal && !priority) return this.restore(nodes, settings, signal, wanted, priorityPlies);
    if (signal && priority) {
      // Priority + signal callers that also need coverage use the restore
      // path through the same signal; foreground abort stays signal-driven.
      // Fire-and-forget is the common case, so only return coverage when the
      // caller asked for a non-priority restore. Priority callers that need
      // coverage call ensure twice (once priority, once with signal only).
      // A focus-first restore can still be requested alongside foreground
      // work by passing priorityPlies: queue the live pair above, then
      // restore settled rows focus-first below. The second phase dedupes via
      // the store cache check, so no duplicate fetch storm.
      if (priorityPlies?.length) return this.restore(nodes, settings, signal, wanted, priorityPlies);
    }
  }
  // Focus-first restore entry point: prime the focus/current plies alone so
  // the visible pair settles without waiting for full-line chunks, then prime
  // the full line in the background. Sequential awaits + the store's cache
  // check mean the second phase skips already-settled focus rows (no duplicate
  // storm); chunk limits (1024 req / 4 MiB) still apply per prime call.
  primeWithPriority(
    nodes: ReviewNode[],
    settings: SettingsInput,
    signal: AbortSignal,
    priorityPlies: readonly number[],
    wanted: Engine[] = [...engines],
  ): Promise<{ total: number; covered: number }> {
    return this.restore(nodes, settings, signal, wanted, priorityPlies);
  }
  private async restore(nodes: ReviewNode[], settings: SettingsInput, signal: AbortSignal, wanted: Engine[], priorityPlies?: readonly number[]) {
    const keys = new Map(nodes.filter(node => !node.outcome).flatMap(node => wanted.map(engine => [reviewKey(engine, node, resolveSettings(settings, node)), engine] as const)));
    for (const [key, engine] of keys) this.restoring.set(key, { count: (this.restoring.get(key)?.count ?? 0) + 1, engine });
    this.notify();
    try {
      if (priorityPlies?.length) {
        // Two-phase focus-first: a small priority-only lookup settles the
        // visible pair fast; the full-line prime that follows reuses those
        // rows from the store cache (existing cache check dedupes, so the
        // second POST carries misses only). Both phases honor the store's
        // 1024-request / 4 MiB chunking, so throttling is unchanged.
        const prioritySet = new Set(priorityPlies);
        const focusNodes = nodes.filter(node => prioritySet.has(node.ply));
        if (focusNodes.length && focusNodes.length < nodes.length) {
          await this.store.prime(focusNodes, settings, [...wanted], signal);
          signal.throwIfAborted();
        }
        // Reordered full-line prime: any still-missing priority jobs (focus
        // == full line, or a race that settled nothing) still lead the first
        // chunk. Parse/cache logic is identical — only job order differs.
        await this.store.prime(nodes, settings, [...wanted], signal, priorityPlies);
      } else {
        await this.store.prime(nodes, settings, [...wanted], signal);
      }
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
    return keys;
  }
  isPending(engine: Engine, node: ReviewNode, settings: ReviewSettings): boolean {
    const key = reviewKey(engine, node, settings);
    if (node.outcome || this.store.peek(engine, key) || this.failures.has(key)) return false;
    return this.restoring.has(key) || this.pending[engine].has(key);
  }
  retry() {
    for (const engine of engines) this.abort(engine);
    this.failures.clear();
    engines.forEach(engine => this.pump(engine)); this.notify();
  }
  private abort(engine: Engine) {
    const runs = [...this.running[engine]];
    this.running[engine].clear();
    for (const run of runs) run.controller.abort();
  }
  private abortKeys(engine: Engine, keys: ReadonlySet<string>) {
    for (const run of [...this.running[engine]]) {
      if (keys.has(run.job.key)) {
        this.running[engine].delete(run);
        run.controller.abort();
      }
    }
  }
  private pump(engine: Engine) {
    const runningKeys = new Set([...this.running[engine]].map(run => run.job.key));
    const entry = [...this.pending[engine].values()].find(entry => !this.finished(entry.job) && !runningKeys.has(entry.job.key));
    if (!entry) return;
    const job = entry.job;
    const running: Running = { job, controller: new AbortController() };
    this.running[engine].add(running);
    void this.execute(job, running.controller.signal).then(result => {
      // Generation check: explicitly aborted work (retry/scope abort) left
      // the set and is dropped. Superseded-but-continuing work stays in the
      // set and always lands — the content-keyed store makes landing safe,
      // and takebacks may reuse the same rows.
      if (!this.running[engine].has(running)) return;
      // execute resolves sf jobs with Evaluations and maia jobs with
      // MoveResponses; presence of top_moves discriminates the union so each
      // lane stores a proven shape. A mismatch is unreachable — drop it
      // rather than poison the content-keyed store.
      if (job.engine === 'sf') {
        if ('top_moves' in result) return;
        this.store.store('sf', job.key, result);
      } else {
        if (!('top_moves' in result)) return;
        this.store.store('maia', job.key, result);
      }
    }).catch(error => {
      if (!this.running[engine].has(running) || running.controller.signal.aborted) return;
      // A superseded focus request was replaced by a newer one; the newer
      // request covers the position, so this is not a failure to surface.
      if (error instanceof MaiaApiError && error.code === 'superseded') return;
      // Fast failure never blocks the full refine and never surfaces: drop
      // the fast queue entry so the lane advances to the full job next.
      // error() reads only the full key, so nothing surfaces. Without the
      // delete, finished() stays false and the lane would retry fast forever.
      if (job.fast) {
        this.pending[engine].delete(job.key);
        return;
      }
      this.failures.set(job.key, error instanceof Error ? error.message : 'Analysis failed.');
    }).finally(() => {
      // A late completion belongs to its generation, even for the same key.
      if (!this.running[engine].has(running)) return;
      this.running[engine].delete(running); this.pump(engine); this.notify();
    });
  }
  private async execute(job: Job, signal: AbortSignal): Promise<Evaluation | MoveResponse> {
    if (job.engine === 'sf') return fetchEvaluation(job.node, signal, this.fetcher, job.settings.stockfish);
    const request = evaluationRequest('maia', job.node, job.settings);
    return requestMove({ fen: request.fen, moves: request.moves, initial_fen: request.initial_fen,
      elo_maia: clampMaiaElo(job.settings.eloMaia), elo_user: clampMaiaElo(job.settings.eloUser), model: job.settings.model, maia_color: job.node.turn }, this.fetcher, signal);
  }
}
