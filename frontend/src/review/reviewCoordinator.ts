import {
  BotApiError,
  requestEngineAnalysis,
  requestMove,
  type MoveRequest,
  type MoveResponse,
} from '../eval/api';
import { ceilElo } from '../board/BoardTools';
// Canonical terms: see spec/GLOSSARY.md.
// transport = shared JSON-POST sender (evaluationTransport); coordinator =
// stateless foreground firer (this class): every ask fires immediately, the
// backend owns admission, order, and dedup-by-key
// (backend/internal/sched/scheduler.go). Server execution is detached:
// granted ops validate+store even after the client stops waiting. Display is
// keyed (posId/reviewKey/lineKey) so stale answers are ignored, not shown.
import type { Evaluation } from './reviewMetrics';
import {
  EvaluationStore,
  evaluationStore,
  fastReviewSettings,
  fetchEvaluation,
  reviewKey,
  resolveSettings,
  splitValueElos,
  type Engine,
  type EvaluationResult,
  type Job,
  type ReviewNode,
  type ReviewSettings,
  type SettingsInput,
} from '../eval/evaluationStore';
export {
  EvaluationStore,
  fastStockfishSettings,
  fastReviewSettings,
  fetchEvaluation,
  moverSettings,
  parseEvaluation,
  resolveSettings,
  reviewKey,
  reviewNodes,
  stablePositionKey,
  type Engine,
  type EvaluationResult,
  type Job,
  type ReviewNode,
  type ReviewSettings,
  type SettingsInput,
} from '../eval/evaluationStore';

export function subscribeNone(): () => void {
  return () => undefined;
}

// One shared never-aborted signal for stateless fires. Foreground asks are
// never cancelled client-side (no navigate-away abort): the shared transport
// deadline still bounds stalls, the server joins same-key arrivals, and rows
// land content-keyed. There is no foreground AbortScope.
const liveSignal: AbortSignal = new AbortController().signal;

const engines = ['sf', 'maia'] as const;

// Stateless foreground: every desired key fires its own ask immediately —
// no FIFO, no dedup, no abort. The server joins same-key arrivals
// (Scheduler.Acquire), serves cache hits, and drops only via 409; 503s ride
// the transport busy-retry. Rows land content-keyed, so a stale landing can
// only settle rows the current line still wants, and takebacks replay from
// cache. The only retry entry is retry() below, which refires recorded
// foreground failures; batch failures heal through the batch resubmit.
export class ReviewCoordinator {
  readonly store: EvaluationStore;
  private inflight = new Map<string, { engine: Engine; count: number }>();
  private failures = new Map<string, string>();
  private failedJobs = new Map<string, Job>();
  private listeners = new Set<() => void>();
  private version = 0;
  constructor(
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
    store?: EvaluationStore,
  ) {
    // An injected transport is an isolated test/application scope. Normal
    // workspace construction shares the app's settled-result store.
    this.store = store ?? (arguments.length ? new EvaluationStore(fetcher) : evaluationStore);
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    const unsubscribe = this.store.subscribe(listener);
    return () => {
      this.listeners.delete(listener);
      unsubscribe();
    };
  };
  snapshot = () => this.version + this.store.version;
  private notify() {
    this.version++;
    this.listeners.forEach(listener => listener());
  }
  result(engine: 'sf', node: ReviewNode, settings: ReviewSettings): EvaluationResult | undefined;
  result(engine: 'maia', node: ReviewNode, settings: ReviewSettings): MoveResponse | undefined;
  result(
    engine: Engine,
    node: ReviewNode,
    settings: ReviewSettings,
  ): EvaluationResult | MoveResponse | undefined;
  result(
    engine: Engine,
    node: ReviewNode,
    settings: ReviewSettings,
  ): EvaluationResult | MoveResponse | undefined {
    return this.store.result(engine, node, settings);
  }
  error(engine: Engine, node: ReviewNode, settings: ReviewSettings) {
    return this.failures.get(reviewKey(engine, node, settings));
  }
  // Server-batch failures live in the same map so the UI has one error
  // source. Keys from the previous batch are dropped; unrelated (foreground)
  // failures are left alone. Batch errors carry no job: the batch resubmit
  // heals them, not retry() below.
  replaceFailures(keys: Set<string>, errors: Map<string, string>) {
    for (const key of keys) {
      this.failures.delete(key);
      this.failedJobs.delete(key);
    }
    for (const [key, message] of errors) {
      this.failures.set(key, message);
      this.failedJobs.delete(key);
    }
    this.notify();
  }
  // Provisional first-paint read for the display layer: full MPV1 when
  // present, else the fast 250ms MPV1 row. Score/verdict render from fast;
  // coverage and the candidate-list completeness check use exact result().
  provisionalSfResult(node: ReviewNode, settings: ReviewSettings): EvaluationResult | undefined {
    return this.store.provisionalSfResult(node, settings);
  }
  private job(
    engine: Engine,
    node: ReviewNode,
    settings: ReviewSettings,
    fast = false,
  ): Job | null {
    if (node.outcome || node.ply > 256) return null;
    return {
      engine,
      node,
      settings,
      key: reviewKey(engine, node, settings),
      ...(fast ? { fast: true as const } : {}),
    };
  }
  // Priority calls return void synchronously; signal calls return coverage.
  // Foreground work fires statelessly in arrival order with no dedup:
  // re-requesting an in-flight key fires again and the server joins the
  // arrivals, so nothing is ever dropped client-side. Drops happen only
  // server-side (409), which the callers' retry sweeps heal.
  ensure(
    nodes: ReviewNode[],
    settings: SettingsInput,
    opts: {
      priority?: boolean;
      engines?: Engine[];
      signal?: AbortSignal;
      priorityPlies?: readonly number[];
      fastFirst?: boolean;
    } = {},
  ): Promise<{ total: number; covered: number }> | void {
    const {
      priority = false,
      engines: enginesOpt,
      signal,
      priorityPlies,
      fastFirst = false,
    } = opts;
    const wanted = enginesOpt ?? [...engines];
    if (priority) {
      // Fast-then-refine (foreground focus/current only, never bulk
      // restore): the 250ms MPV1 ask fires first and the full MPV1 ask fires
      // when it settles — pair-local order only, no generic machinery. Bot
      // lanes fire alongside as before. Skip fast when full already settles
      // (no extra fetch) or when fast already settles (fire full only).
      if (fastFirst && wanted.includes('sf')) {
        for (const node of nodes) {
          for (const engine of wanted) {
            if (engine === 'sf') continue;
            const other = this.job(engine, node, resolveSettings(settings, node));
            if (!other) continue;
            if (this.store.peek(other.engine, other.key)) {
              this.failures.delete(other.key);
              this.failedJobs.delete(other.key);
            } else {
              this.fireOne(other);
            }
          }
          const full = this.job('sf', node, resolveSettings(settings, node));
          if (!full) continue;
          if (this.store.peek('sf', full.key)) {
            this.failures.delete(full.key);
            this.failedJobs.delete(full.key);
            continue;
          }
          const fastSettings = fastReviewSettings(resolveSettings(settings, node));
          const fast = fastSettings ? this.job('sf', node, fastSettings, true) : null;
          if (fast && fast.key !== full.key && !this.store.peek('sf', fast.key)) {
            this.fireFastThenFull(fast, full);
          } else {
            this.fireOne(full);
          }
        }
      } else {
        for (const node of nodes)
          for (const engine of wanted) {
            const job = this.job(engine, node, resolveSettings(settings, node));
            if (!job) continue;
            if (this.store.peek(job.engine, job.key)) {
              this.failures.delete(job.key);
              this.failedJobs.delete(job.key);
              continue;
            }
            this.fireOne(job);
          }
      }
      this.notify();
    }
    if (signal && !priority) return this.restore(nodes, settings, signal, wanted, priorityPlies);
    if (signal && priority) {
      // Priority + signal callers that also need coverage use the restore
      // path through the same signal; the foreground fire above is already
      // stateless. A focus-first restore can still be requested alongside
      // foreground work by passing priorityPlies: the bulk lookup settles
      // the visible pair first, then the remainder reuses those rows from
      // cache.
      if (priorityPlies !== undefined && priorityPlies.length > 0)
        return this.restore(nodes, settings, signal, wanted, priorityPlies);
    }
  }
  // Single restore entry: settled rows come from the store's restore path;
  // the coordinator adds only display pending accounting (kept, so spinners
  // hold while the lookup settles). The signal is transport hygiene for
  // unmount/deactivation only — a line change never aborts a restore.
  async restore(
    nodes: ReviewNode[],
    settings: SettingsInput,
    signal: AbortSignal,
    wanted: Engine[] = [...engines],
    priorityPlies?: readonly number[],
  ): Promise<{ total: number; covered: number }> {
    const keys = new Map(
      nodes
        .filter(node => !node.outcome)
        .flatMap(node =>
          wanted.map(
            engine => [reviewKey(engine, node, resolveSettings(settings, node)), engine] as const,
          ),
        ),
    );
    for (const [key, engine] of keys) this.track(engine, key);
    this.notify();
    try {
      return await this.store.restore(nodes, settings, [...wanted], signal, priorityPlies);
    } finally {
      for (const [key] of keys) this.untrack(key);
      this.notify();
    }
  }
  sfPendingKeys(): Set<string> {
    return this.pendingKeys('sf');
  }
  botPendingKeys(): Set<string> {
    return this.pendingKeys('maia');
  }
  // Display-only pending: in-flight keys per engine (foreground fires plus
  // restores). Never gates firing — refires always go out and the server
  // joins them.
  private pendingKeys(engine: Engine): Set<string> {
    const keys = new Set<string>();
    for (const [key, entry] of this.inflight) if (entry.engine === engine) keys.add(key);
    return keys;
  }
  isPending(engine: Engine, node: ReviewNode, settings: ReviewSettings): boolean {
    const key = reviewKey(engine, node, settings);
    if (node.outcome || this.store.peek(engine, key) || this.failures.has(key)) return false;
    return this.inflight.has(key);
  }
  // Stateless refire: recorded foreground failures fire again immediately.
  // Batch failures heal through the batch resubmit, not here.
  retry() {
    const jobs = [...this.failedJobs.values()];
    this.failures.clear();
    this.failedJobs.clear();
    for (const job of jobs) {
      if (job.node.outcome || job.node.ply > 256) continue;
      if (this.store.peek(job.engine, job.key)) continue;
      this.fireOne(job);
    }
    this.notify();
  }
  private track(engine: Engine, key: string) {
    const prior = this.inflight.get(key);
    this.inflight.set(key, { engine, count: (prior?.count ?? 0) + 1 });
    this.notify();
  }
  private untrack(key: string) {
    const entry = this.inflight.get(key);
    if (!entry) return;
    if (entry.count > 1) this.inflight.set(key, { engine: entry.engine, count: entry.count - 1 });
    else this.inflight.delete(key);
    this.notify();
  }
  private fireOne(job: Job) {
    // Re-issuing clears the recorded failure up front so the spinner, not
    // the stale message, shows while the refire settles.
    this.failures.delete(job.key);
    this.failedJobs.delete(job.key);
    this.track(job.engine, job.key);
    void this.execute(job)
      .then(result => this.land(job, result))
      .catch(error => this.recordFailure(job, error))
      .finally(() => this.untrack(job.key));
  }
  // Pair-local order only: the fast ask fires, and the full ask fires when
  // it settles (success or failure) unless the full row settled meanwhile.
  private fireFastThenFull(fast: Job, full: Job) {
    this.failures.delete(fast.key);
    this.failedJobs.delete(fast.key);
    this.failures.delete(full.key);
    this.failedJobs.delete(full.key);
    this.track(fast.engine, fast.key);
    void this.execute(fast)
      .then(
        result => this.land(fast, result),
        error => this.recordFailure(fast, error),
      )
      .finally(() => {
        this.untrack(fast.key);
        // Cache-first refine: a batch or restore may have settled the full
        // row while the fast ask was in flight.
        if (!this.store.peek(full.engine, full.key)) this.fireOne(full);
      });
  }
  private land(job: Job, result: Evaluation | MoveResponse) {
    // execute resolves sf jobs with Evaluations and bot jobs with
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
    this.failures.delete(job.key);
    this.failedJobs.delete(job.key);
  }
  private recordFailure(job: Job, error: unknown) {
    // A superseded focus request was replaced by a newer one; the newer
    // request covers the position, so this is not a failure to surface.
    // The heal sweeps still cover the key when nothing does.
    if (error instanceof BotApiError && error.code === 'superseded') return;
    // Fast failure never blocks the full refine and never surfaces: the
    // fast→full chain fires the full ask regardless.
    if (job.fast) return;
    this.failures.set(job.key, error instanceof Error ? error.message : 'Analysis failed.');
    this.failedJobs.set(job.key, job);
    this.notify();
  }
  private async execute(job: Job): Promise<Evaluation | MoveResponse> {
    if (job.engine === 'sf')
      return fetchEvaluation(job.node, liveSignal, this.fetcher, job.settings.stockfish);
    // Single-position endpoint (OUT OF SCOPE for the line-oriented batch
    // change): still sends the full prefix per request.
    const prefix = job.node.timeline.moves.slice(0, job.node.ply);
    const split = splitValueElos(job.settings);
    const valueElos = {
      ...(split.valueBotElo !== undefined ? { value_elo_maia: split.valueBotElo } : {}),
      ...(split.valueUserElo !== undefined ? { value_elo_user: split.valueUserElo } : {}),
    };
    // Retrospective analysis rides the Focus lane (POST /move/analysis),
    // never the play lane — it fires alongside the live reply every move.
    // Stateless asks share the server lanes; the scheduler orders them.
    return requestEngineAnalysis(
      {
        fen: job.node.fen,
        moves: prefix,
        initial_fen: job.node.initialFen,
        elo_maia: ceilElo(job.settings.botElo),
        elo_user: ceilElo(job.settings.userElo),
        ...valueElos,
        model: job.settings.model,
        maia_color: job.node.turn,
      },
      this.fetcher,
      liveSignal,
    );
  }
  // Play /move, stateless: every live reply fires its own ask with the shared
  // transport deadline. Latest-wins lives server-side (the Play lane 409s a
  // superseded reply). Replies are never cached: play payloads carry
  // per-game sampling settings, so they must not settle content-keyed
  // review rows. Analysis never touches this path (POST /move/analysis →
  // Focus), so a live reply is only ever superseded by a newer live reply.
  async playMove(payload: MoveRequest): Promise<MoveResponse & { cached?: boolean }> {
    return requestMove(payload, this.fetcher);
  }
}
