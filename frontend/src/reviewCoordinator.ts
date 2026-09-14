import { Chess } from 'chess.js';
import { requestMove, type MoveResponse } from './api';
import { replay } from './domain';
import { terminalEvaluation, type Evaluation } from './reviewMetrics';
import { stockfishPolicy } from './stockfishSettings';
import {
  cacheHash, EvaluationStore, fetchEvaluation, reviewKey, resolveSettings,
  type Engine, type Job, type ReviewNode, type ReviewSettings, type SettingsInput,
} from './evaluationStore';

// Backwards-compatible re-exports: existing import sites keep importing keys,
// transport helpers, and types from here. New code imports the store directly.
export {
  cacheHash, EvaluationStore, fetchEvaluation, MAIA_REF, maiaCacheKeyForMoveRequest,
  parseEvaluation, resolveSettings, reviewKey,
  type Engine, type Job, type ReviewNode, type ReviewSettings, type SettingsInput,
} from './evaluationStore';

// Per-position timing trace for batch slowdown diagnosis. `ply` is the
// in-game position index (node.moves.length), the x-axis for second-half
// cliffs. `detail` carries the engine identity that explains the cost:
// the full Stockfish search policy (mpv/time/depth) or Maia model@elo.
// `source` separates real inference (`live`) from `server-cache` and
// `memory` hits: a batch that starts fast then crawls is the signature of
// a settings change that invalidated one engine's cache half (e.g. Stockfish
// time 750→2000 keeps every Maia key but misses every SF key). Line-count
// changes are asymmetric: fewer lines reuse larger-mpv rows sliced down
// (4→2 hits, approximately), while more lines always re-run (2→4 misses).
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
// Stall budgets. Maia inference may legally run up to the backend's 120s move
// window, so a lane is only declared stale past that plus margin. Mobile
// background freezes (timers and sockets stall while promises stay pending)
// are detected on return instead: jobs that straddled a long hide are
// re-issued, since their sockets may be dead while the promises never settle.
export const JOB_STALL_MS = 150_000;
export const RESUME_ABORT_AFTER_HIDDEN_MS = 10_000;

// No-op subscription for hooks whose coordinator is idle (suspended with
// nothing displayed from it): settles must not re-render a tree showing
// nothing from this coordinator. Resubscribing on activation re-reads the
// snapshot, so no update is missed across the switch.
export function subscribeNone(): () => void {
  return () => undefined;
}
// Each lane has one in-flight job. Foreground replacement coalesces scrubbing;
// batch work is pulled one node at a time only when the foreground is empty.

// Thin prioritized scheduler over an EvaluationStore: foreground pair,
// play FIFO queue, batch cursor, abort/preemption, retries, stall resume,
// progress, and timing. It writes settled data only through store() on job
// completion and fail() on job failure — it cannot clear or invalidate rows,
// so foreground swaps and suspends never disturb the analysis UI's data.
export class ReviewCoordinator {
  readonly store: EvaluationStore;
  private foreground: Record<Engine, Job[]> = { sf: [], maia: [] };
  // FIFO queue for play-mode Stockfish move feedback. Unlike foreground
  // replacement (LIFO, preemptive: right for analysis scrubbing, where only
  // the viewed position matters), every committed user ply needs an eventual
  // evaluation, so playing faster than one eval must enqueue rather than
  // supersede. Served in ply order after the foreground, before the batch.
  private playQueue: Job[] = [];
  private running: Partial<Record<Engine, Job>> = {};
  private startedAt: Partial<Record<Engine, number>> = {};
  private controllers: Partial<Record<Engine, AbortController>> = {};
  private batch: { nodes: ReviewNode[]; settings: SettingsInput; cursor: Record<Engine, number>; total: number; completed: Set<string>; degradedMaia: boolean } | null = null;
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
  constructor(private fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.store = new EvaluationStore(fetcher);
  }
  subscribe = (listener: () => void) => this.store.subscribe(listener);
  snapshot = () => this.store.snapshot();
  get version() { return this.store.version; }
  result<E extends Engine>(engine: E, node: ReviewNode, settings: ReviewSettings): (E extends 'sf' ? Evaluation : MoveResponse) | undefined {
    return this.store.result(engine, node, settings);
  }
  error(engine: Engine, node: ReviewNode, settings: ReviewSettings) { return this.store.error(engine, node, settings); }
  private job(engine: Engine, node: ReviewNode, settings: ReviewSettings): Job | null {
    const terminal = terminalEvaluation(replay(node.moves, node.initialFen));
    if (terminal) {
      this.store.seedTerminal(node, settings, terminal);
      return null;
    }
    return { engine, node, settings, key: reviewKey(engine, node, settings) };
  }
  // maiaDepth covers the analysis split-view: the panel judges the displayed
  // move (its before-position) while the arrows project forward from the
  // viewed position, so the foreground fetches Maia for both. Defaults to 1
  // (viewed position only).
  foregroundAt(nodes: ReviewNode[], settings: SettingsInput, maiaDepth = 1) {
    this.active = true;
    for (const engine of ['sf', 'maia'] as const) {
      this.foreground[engine] = nodes.slice(0, engine === 'sf' ? 2 : maiaDepth).flatMap(node => {
        const job = this.job(engine, node, resolveSettings(settings, node)); return job ? [job] : [];
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
    this.store.notify();
  }
  clearForeground() { this.foreground = { sf: [], maia: [] }; }
  // Play-mode move feedback: Stockfish only, never Maia. A dedicated
  // coordinator per hook owns this lane so play evaluations cannot contend
  // with real play replies on the Maia workers or leak into analysis.
  foregroundSfOnly(nodes: ReviewNode[], settings: SettingsInput) {
    this.active = true;
    this.foreground.maia = [];
    this.foreground.sf = nodes.slice(0, 2).flatMap(node => {
      const job = this.job('sf', node, resolveSettings(settings, node)); return job ? [job] : [];
    });
    const running = this.running.sf;
    const waiting = this.foreground.sf.some(job => !this.finished(job));
    if (running && waiting && !this.foreground.sf.some(job => job.key === running.key)) {
      this.controllers.sf?.abort();
    }
    this.pump('sf');
    this.store.notify();
  }
  retrySfOnly(nodes: ReviewNode[], settings: SettingsInput) {
    for (const node of nodes) this.store.clearFailure(reviewKey('sf', node, resolveSettings(settings, node)));
    this.foregroundSfOnly(nodes, settings);
  }
  // Reconcile the play queue with the current line in ply order: drop queued
  // (never running) jobs the line no longer needs — takebacks, new games,
  // Stockfish policy changes — and append missing ones. Past failures for
  // still-desired positions are cleared so the next sync retries them instead
  // of leaving a permanent hole in the move list. Never aborts: the running
  // job is cheaper to finish (~750ms) than to discard and starve.
  syncPlayQueue(nodes: ReviewNode[], settings: SettingsInput) {
    this.active = true;
    this.foreground.maia = [];
    const desired = new Map<string, Job>();
    for (const node of nodes) {
      const job = this.job('sf', node, resolveSettings(settings, node));
      if (job && !desired.has(job.key)) desired.set(job.key, job);
    }
    for (const key of desired.keys()) this.store.clearFailure(key);
    this.playQueue = this.playQueue.filter(queued => desired.has(queued.key) && !this.finished(queued));
    for (const job of desired.values()) {
      // The lane drives execute()'s fetch order (exact-first for play).
      job.lane = 'play';
      if (this.finished(job)) continue;
      if (this.running.sf?.key === job.key) continue;
      if (this.playQueue.some(queued => queued.key === job.key)) continue;
      this.playQueue.push(job);
    }
    this.pump('sf');
    this.store.notify();
  }
  clearPlayQueue() { this.playQueue = []; }
  // Resolved play-queue sync. Same contract as syncPlayQueue, but terminals
  // arrive precomputed from the caller's single progressive pass (history-aware
  // via the walking instance, repetition included), so no per-node replay
  // happens here. Used only by the play hook; batch/prime/foreground paths
  // keep replay-based job() resolution untouched.
  syncPlayQueueResolved(items: { node: ReviewNode; terminal: Evaluation | null }[], settings: SettingsInput) {
    this.active = true;
    this.foreground.maia = [];
    const desired = new Map<string, { job: Job; terminal: Evaluation | null }>();
    for (const { node, terminal } of items) {
      const resolved = resolveSettings(settings, node);
      const key = reviewKey('sf', node, resolved);
      if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
        // Dev/test invariant: fen must agree with moves (live requests enforce
        // the same agreement server-side via position_mismatch). Never runs in
        // production, where a per-item replay would restore the cliff this
        // method avoids.
        if (replay(node.moves, node.initialFen).fen() !== new Chess(node.fen).fen()) {
          throw new Error(`syncPlayQueueResolved: stale fen for ${key}`);
        }
      }
      if (!desired.has(key)) desired.set(key, { job: { engine: 'sf', node, settings: resolved, key }, terminal });
    }
    for (const key of desired.keys()) this.store.clearFailure(key);
    // Terminal seeding mirrors job(): sf rows persist under the caller's
    // search policy; terminal positions never enter any lane.
    for (const { job, terminal } of desired.values()) {
      if (terminal) this.store.seedTerminal(job.node, job.settings, terminal);
    }
    this.playQueue = this.playQueue.filter(queued => desired.has(queued.key) && !this.finished(queued));
    for (const { job } of desired.values()) {
      // The lane drives execute()'s fetch order (exact-first for play).
      job.lane = 'play';
      if (this.finished(job)) continue;
      if (this.running.sf?.key === job.key) continue;
      if (this.playQueue.some(queued => queued.key === job.key)) continue;
      this.playQueue.push(job);
    }
    this.pump('sf');
    this.store.notify();
  }
  suspend() { this.active = false; this.clearForeground(); this.clearPlayQueue(); this.batch = null; this.store.notify(); }
  // Server-cache restore entry points. Reads only — see the store.
  primeLine(nodes: ReviewNode[], settings: SettingsInput, signal: AbortSignal) {
    return this.store.primeLine(nodes, settings, signal);
  }
  primePositions(items: { node: ReviewNode; terminal: Evaluation | null }[], settings: SettingsInput, signal: AbortSignal) {
    return this.store.primePositions(items, settings, signal);
  }
  startBatch(nodes: ReviewNode[], settings: SettingsInput) {
    if (nodes.length > 257) return;
    const total = nodes.reduce((count, node) => count + (terminalEvaluation(replay(node.moves, node.initialFen)) ? 0 : 2), 0);
    this.batch = { nodes, settings, total, cursor: { sf: 0, maia: 0 }, completed: new Set(), degradedMaia: false };
    this.timings = []; this.summaryLogged = false; this.executedKeys = new Set();
    this.active = true; this.pump('sf'); this.pump('maia'); this.store.notify();
  }
  // True once a fallback Maia answer settles inside the running batch.
  // Read at completion time: degraded rows expire from memory within seconds
  // and are never persisted server-side, so a post-hoc cache peek would miss
  // them and mislabel fallback batches as clean.
  batchDegraded() { return this.batch?.degradedMaia ?? false; }
  private batchKey(engine: Engine, node: ReviewNode): string | null {
    if (!this.batch) return null;
    return reviewKey(engine, node, resolveSettings(this.batch.settings, node));
  }
  private inBatch(job: Job): boolean {
    if (!this.batch) return false;
    return this.batch.nodes.some(node => this.batchKey(job.engine, node) === job.key);
  }
  get progress() {
    if (!this.batch) return null;
    const failed = this.batch.nodes.reduce((count, node) => {
      const settings = resolveSettings(this.batch!.settings, node);
      return count + Number(!!this.error('sf', node, settings)) + Number(!!this.error('maia', node, settings));
    }, 0);
    return { done: this.batch.completed.size, total: this.batch.total, failed, running: this.batch.completed.size < this.batch.total };
  }
  // The single source of truth for "a verdict may still arrive": queued,
  // running, waiting behind the batch cursor, or being restored from the
  // server. Settled and failed keys are excluded, so badges go quiet instead
  // of spinning forever — and the UI needs no per-lane condition that can
  // fall behind when a new async source appears.
  sfPendingKeys(): Set<string> {
    const out = new Set<string>();
    if (this.running.sf && !this.finished(this.running.sf)) out.add(this.running.sf.key);
    for (const job of [...this.foreground.sf, ...this.playQueue]) if (!this.finished(job)) out.add(job.key);
    const batch = this.batch;
    if (batch && batch.completed.size < batch.total) {
      for (const node of batch.nodes) {
        const key = reviewKey('sf', node, resolveSettings(batch.settings, node));
        if (!batch.completed.has(key) && !this.store.failed(key) && !this.store.peek('sf', key)) out.add(key);
      }
    }
    for (const key of this.store.inflightKeys('sf')) out.add(key);
    return out;
  }
  private recordTiming(job: Job, source: JobSource, ms: number, retries: number, failed = false) {
    const inBatch = this.inBatch(job);
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
    if (import.meta.env.DEV) console.info('[review] batch timing', JSON.stringify(this.batchTimingSummary()));
  }
  retry() {
    // Abort in-flight lanes first: a wedged job (socket dead, promise never
    // settling) would otherwise keep `running` set and the pumps below would
    // no-op, leaving Retry a dead button. Aborted jobs are not marked failed
    // or completed; the finally handler re-pumps them from the reset cursor.
    for (const engine of ['sf', 'maia'] as const) this.controllers[engine]?.abort();
    this.store.clearFailures();
    if (this.batch) { this.batch.cursor = { sf: 0, maia: 0 }; this.batch.completed.clear(); this.batch.degradedMaia = false; }
    this.timings = []; this.summaryLogged = false; this.executedKeys = new Set();
    this.pump('sf'); this.pump('maia'); this.store.notify();
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
    this.pump('sf'); this.pump('maia'); this.store.notify();
  }
  private finished(job: Job) { return this.store.finishedKey(job.engine, job.key); }
  private next(engine: Engine): Job | undefined {
    const foreground = this.foreground[engine].find(job => !this.finished(job));
    if (foreground) return foreground;
    // Play feedback drains oldest-first. Finished heads (cached while queued,
    // or failed) are shifted, never executed; an aborted job stays queued and
    // is retried, mirroring the batch cursor's peek-without-consume rule.
    if (engine === 'sf') {
      while (this.playQueue.length) {
        const head = this.playQueue[0];
        if (this.finished(head)) { this.playQueue.shift(); continue; }
        return head;
      }
    }
    const batch = this.batch;
    if (!batch) return;
    // Peek without consuming: an aborted or superseded job stays at the cursor
    // and is retried later instead of being lost. Only finished work advances it.
    while (batch.cursor[engine] < batch.nodes.length) {
      const node = batch.nodes[batch.cursor[engine]];
      const job = this.job(engine, node, resolveSettings(batch.settings, node));
      if (!job) { batch.cursor[engine]++; continue; }
      if (this.finished(job)) {
        batch.completed.add(job.key); batch.cursor[engine]++;
        // Cursor catch-up after this run's own live completion is not a hit.
        if (!this.executedKeys.has(job.key)) this.recordTiming(job, 'memory', 0, 0);
        // Memory-served fallback answers must flag the batch too: without
        // re-execution the settle handler never sees them, yet the batch
        // results still contain degraded rows unfit for recording.
        if (engine === 'maia' && (this.store.peek('maia', job.key) as MoveResponse | undefined)?.degraded) batch.degradedMaia = true;
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
      if (engine === 'sf') this.store.store('sf', job.key, result as Evaluation);
      else {
        const degraded = (result as MoveResponse).degraded;
        this.store.store('maia', job.key, result as MoveResponse, degraded ? 30_000 : Infinity);
        if (degraded && this.inBatch(job)) this.batch!.degradedMaia = true;
      }
    }).catch(error => {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
      this.executedKeys.add(job.key);
      this.recordTiming(job, 'live', Date.now() - (this.startedAt[engine] ?? Date.now()), 0, true);
      this.store.fail(job.key, error instanceof Error ? error.message : 'Analysis failed.');
    }).finally(() => {
      if (this.controllers[engine]?.signal === signal) delete this.controllers[engine];
      const aborted = signal.aborted;
      delete this.running[engine];
      delete this.startedAt[engine];
      // Settled queue jobs leave the queue; aborted ones stay for retry. A
      // pruned-while-running job is already gone, so it is never resurrected.
      if (!aborted && engine === 'sf') this.playQueue = this.playQueue.filter(queued => queued.key !== job.key);
      if (!aborted && this.inBatch(job)) this.batch!.completed.add(job.key);
      this.pump(engine); this.store.notify(); this.maybeLogBatchSummary();
    });
  }

  private async execute(job: Job, signal: AbortSignal): Promise<{ result: Evaluation | MoveResponse; source: 'server-cache' | 'live' | 'memory'; retries: number }> {
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
    // Read-through: the POST carries the cache coordinates the old code
    // used for its separate GET probe + PUT write-back, so one request
    // covers lookup, inference, and persistence. The backend reports hits
    // via X-Eval-Cache; anything else is live inference. Before paying for
    // inference, Stockfish consults downward supersets (memory, then server):
    // a larger-mpv row sliced down satisfies fewer requested lines.
    if (job.engine === 'sf') {
      const mem = this.store.peekSupersetFor(job);
      if (mem) {
        this.store.store('sf', job.key, mem);
        return { result: mem, source: 'memory', retries };
      }
      if (job.lane === 'play') {
        // Play lane: exact-first read-through. Play positions are evaluated at
        // the user's fixed lines setting, so the exact row is the common hit;
        // opening with the analysis-batch superset fan-out costs 3-4 wasted
        // round trips per job on every page load (measured: ~400 probes for a
        // 133-ply game). readServerCache still falls back to larger rows, so
        // established superset reuse keeps working; true misses POST as usual.
        const hit = await this.store.readServerCacheFor(job, signal);
        if (hit) {
          this.store.store('sf', job.key, hit as Evaluation);
          return { result: hit, source: 'server-cache', retries };
        }
      } else if (job.settings.stockfish) {
        // No extra await when supersets are inapplicable (legacy settings
        // without stockfish): the lane keeps its exact previous timing.
        const sup = await this.store.probeSupersetFor(job, signal);
        if (sup) {
          this.store.store('sf', job.key, sup);
          return { result: sup, source: 'server-cache', retries };
        }
      }
      const result = await fetchEvaluation(job.node, signal, retryFetch, job.settings.stockfish, { hash: cacheHash(job.key), key: job.key });
      return { result, source: result.cached ? 'server-cache' : 'live', retries };
    }
    const result = await requestMove({ fen: job.node.fen, moves: job.node.moves, initial_fen: job.node.initialFen, elo_maia: job.settings.eloMaia, elo_user: job.settings.eloUser, model: job.settings.model, maia_color: new Chess(job.node.fen).turn() === 'w' ? 'white' : 'black', cache_hash: cacheHash(job.key), cache_key: job.key }, retryFetch, signal);
    // Fallback answers expire in memory within seconds; the backend never
    // persists them either, so degraded rows stay request-local.
    return { result, source: result.cached ? 'server-cache' : 'live', retries };
  }
}
