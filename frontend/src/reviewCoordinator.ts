import { Chess } from 'chess.js';
import { parseMoveResponse, requestMove, type MoveResponse, type MaiaModel } from './api';
import { replay } from './domain';
import { terminalEvaluation, type Evaluation, type Score } from './reviewMetrics';
import { stockfishPolicy, type StockfishSettings } from './stockfishSettings';

export type ReviewNode = { initialFen: string; moves: string[]; fen: string };
export type ReviewSettings = { eloMaia: number; eloUser: number; model: MaiaModel; stockfish?: StockfishSettings };
export type Engine = 'sf' | 'maia';
// A batch may need different Maia identities per position (own games pin
// Maia's moves to the game Elo while the user's moves follow the adjustable
// analysis rating). Callers pass either one shared settings object or a
// resolver returning the settings for each node.
export type SettingsInput = ReviewSettings | ((node: ReviewNode) => ReviewSettings);
function resolveSettings(input: SettingsInput, node: ReviewNode): ReviewSettings {
  return typeof input === 'function' ? input(node) : input;
}
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
type Result = Evaluation | MoveResponse;
type Job = { key: string; engine: Engine; node: ReviewNode; settings: ReviewSettings; lane?: 'play' };
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

// Play-time Maia replies carry the same top_moves/WDL compute as analysis
// batches. Play requests carry these coordinates to POST /move, so the
// read-through backend files them under the identical reviewKey and later
// analysis at the same Elo hits instead of re-inferring. Degraded fallback
// answers are never persisted (matching batch behavior).
export function maiaCacheKeyForMoveRequest(payload: { fen: string; moves: string[]; initial_fen?: string; elo_maia: number; elo_user: number; model: MaiaModel }): { key: string; hash: string } {
  const node: ReviewNode = { initialFen: payload.initial_fen ?? new Chess().fen(), moves: payload.moves, fen: payload.fen };
  const settings: ReviewSettings = { eloMaia: payload.elo_maia, eloUser: payload.elo_user, model: payload.model };
  const key = reviewKey('maia', node, settings);
  return { key, hash: cacheHash(key) };
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

// Superset reuse (downward only). A cached mpvM row with identical time and
// depth settings approximately satisfies an mpvN request (M > N): same
// nominal depth, prefix sliced, policy re-stamped to the requested one. By
// product decision this approximation is served as exact; upward reuse is
// never allowed (fewer lines cannot serve more), and derived rows are
// read-time only — never persisted — so canonical stored rows stay native
// searches.
function witnessSettings(settings: ReviewSettings, lines: number): ReviewSettings | null {
  const sf = settings.stockfish;
  if (!sf || !Number.isInteger(lines) || lines <= sf.lines || lines > 5) return null;
  return { ...settings, stockfish: { ...sf, lines } };
}

function sliceSupersetEvaluation(value: unknown, node: ReviewNode, want: ReviewSettings, witness: ReviewSettings): Evaluation | undefined {
  const wantLines = want.stockfish?.lines;
  if (wantLines === undefined) return undefined;
  let parsed: Evaluation;
  try {
    parsed = parseEvaluation(value, witness.stockfish);
  } catch {
    return undefined;
  }
  // Terminals resolve locally per policy and never need this path.
  if (parsed.terminal !== null) return undefined;
  // A row may legitimately hold fewer lines than its policy when the
  // position has few legal moves: the usable prefix is min(want, legal).
  let legal = 0;
  try {
    legal = new Chess(node.fen).moves().length;
  } catch {
    return undefined;
  }
  const expected = Math.min(wantLines, legal);
  if (expected < 1 || parsed.lines.length < expected) return undefined;
  const sliced = parsed.lines.slice(0, expected);
  if (new Set(sliced.map(line => line.move)).size !== sliced.length) return undefined;
  return {
    ...parsed,
    search_policy: stockfishPolicy(want.stockfish),
    lines: sliced,
    best_move: sliced[0].move,
    score: sliced[0].score,
    depth: Math.min(...sliced.map(line => line.depth)),
  };
}

export async function fetchEvaluation(node: ReviewNode, signal: AbortSignal, fetcher: typeof fetch = fetch, settings?: StockfishSettings, cache?: { hash: string; key: string }): Promise<Evaluation & { cached?: boolean }> {
  const post = async (coordinates?: { hash: string; key: string }): Promise<Response> => {
    try {
      return await fetcher('/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fen: node.fen, moves: node.moves, initial_fen: node.initialFen, ...(settings ? { settings } : {}), ...(coordinates ? { cache_hash: coordinates.hash, cache_key: coordinates.key } : {}) }), signal });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      throw new Error('Stockfish is unreachable. Check that the server is running on your LAN.');
    }
  };
  const read = async (response: Response): Promise<{ parsed: Evaluation; hit: boolean }> => {
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
    return { parsed: parseEvaluation(body, settings), hit: response.headers.get('X-Eval-Cache') === 'hit' };
  };
  const first = await post(cache);
  try {
    const { parsed, hit } = await read(first);
    // Read-through backends mark served rows; absence means live inference
    // (or an older backend without the header).
    if (hit) return { ...parsed, cached: true as const };
    return parsed;
  } catch (error) {
    // A served row that fails validation is poison (e.g. a lax legacy PUT):
    // fall back to live inference once. The coord-less retry files nothing
    // server-side, so write the validated live result back explicitly to heal
    // the row; other failures propagate as-is.
    if (!cache || first.headers.get('X-Eval-Cache') !== 'hit') throw error;
    const { parsed } = await read(await post(undefined));
    void (async () => {
      try {
        await fetcher(`/evaluations/${cache.hash}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine: 'sf', key: cache.key, value: parsed }),
        });
      } catch {
        // Best-effort: the memory cache still serves this session.
      }
    })();
    return parsed;
  }
}
// No-op subscription for hooks whose coordinator is inactive (suspended with
// nothing displayed from it): cross-engine settles must not re-render the
// other mode's tree. Resubscribing on activation re-reads the snapshot, so no
// update is missed across the switch.
export function subscribeNone(): () => void {
  return () => undefined;
}
// Each lane has one in-flight job. Foreground replacement coalesces scrubbing;
// batch work is pulled one node at a time only when the foreground is empty.
export class ReviewCoordinator {
  private cache = { sf: new Lru<Evaluation>(), maia: new Lru<MoveResponse>() };
  private failures = new Map<string, string>();
  private foreground: Record<Engine, Job[]> = { sf: [], maia: [] };
  // FIFO queue for play-mode Stockfish move feedback. Unlike foreground
  // replacement (LIFO, preemptive: right for analysis scrubbing, where only
  // the viewed position matters), every committed user ply needs an eventual
  // evaluation, so playing faster than one eval must enqueue rather than
  // supersede. Served in ply order after the foreground, before the batch.
  private playQueue: Job[] = [];
  private running: Partial<Record<Engine, Job>> = {};
  private startedAt: Partial<Record<Engine, number>> = {};
  // Server-restore probes in flight, refcounted by key: overlapping primes
  // for the same position must not clear each other on completion.
  private primeInflight = new Map<string, { count: number; engine: Engine }>();
  private controllers: Partial<Record<Engine, AbortController>> = {};
  private batch: { nodes: ReviewNode[]; settings: SettingsInput; cursor: Record<Engine, number>; total: number; completed: Set<string>; degradedMaia: boolean } | null = null;
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
  snapshot = () => this.version;  // One notification per microtask, not per state change: a batch drain
  // settles dozens of jobs in one task, and every settle previously
  // re-rendered the whole App. Listeners still observe every change, only
  // batched — progress and icons land a frame later at most. Late
  // subscribers are still notified: the flush iterates the live set.
  private emitScheduled = false;
  private emit() {
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    void Promise.resolve().then(() => {
      this.emitScheduled = false;
      this.version++;
      [...this.listeners].forEach(listener => listener());
    });
  }
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
    this.emit();
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
    this.emit();
  }
  retrySfOnly(nodes: ReviewNode[], settings: SettingsInput) {
    for (const node of nodes) this.failures.delete(reviewKey('sf', node, resolveSettings(settings, node)));
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
    for (const key of desired.keys()) this.failures.delete(key);
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
    this.emit();
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
    for (const key of desired.keys()) this.failures.delete(key);
    // Terminal seeding mirrors job(): sf rows persist under the caller's
    // search policy; terminal positions never enter any lane.
    for (const { job, terminal } of desired.values()) {
      if (terminal) this.cache.sf.set(job.key, { ...terminal, search_policy: stockfishPolicy(job.settings.stockfish) });
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
    this.emit();
  }
  suspend() { this.active = false; this.clearForeground(); this.clearPlayQueue(); this.batch = null; this.emit(); }
  // Play-lane restore: concurrent read-through for queued positions ahead of
  // the single-file queue drain. Play feedback evaluates at the user's fixed
  // lines setting, but past analyses may have filed larger rows, so each
  // position needs its exact lookup plus the downward-superset fallback —
  // exactly readServerCache per job. Bounded lanes (like primeLine) collapse
  // ~133 sequential probe rounds into ~17; tip-first ordering paints the
  // visible tip first. Read-only: misses stay missing for the queue's live
  // path, which the caller runs next with only the returned remainder.
  // Terminals arrive precomputed from the caller and are never probed (the
  // queue seeds them, mirroring job()). Aborts via signal (hook-owned).
  async primePositions(
    items: { node: ReviewNode; terminal: Evaluation | null }[],
    settings: SettingsInput,
    signal: AbortSignal,
  ): Promise<{ node: ReviewNode; terminal: Evaluation | null }[]> {
    const pending: { job: Job; item: { node: ReviewNode; terminal: Evaluation | null } }[] = [];
    for (const item of items) {
      if (item.terminal) continue;
      const resolved = resolveSettings(settings, item.node);
      const key = reviewKey('sf', item.node, resolved);
      if (this.cache.sf.peek(key) || this.failures.has(key)) continue;
      pending.push({ job: { engine: 'sf', node: item.node, settings: resolved, key, lane: 'play' }, item });
    }
    // Tip-first: the move list viewport shows the tip, so its icons matter first.
    pending.sort((a, b) => b.job.node.moves.length - a.job.node.moves.length);
    const restoring = pending.map(({ job }) => ({ key: job.key, engine: job.engine }));
    for (const job of restoring) {
      const entry = this.primeInflight.get(job.key);
      this.primeInflight.set(job.key, { count: (entry?.count ?? 0) + 1, engine: job.engine });
    }
    // Notify now so badges animate for the whole restore (callers only emit
    // again after queueing the remainder, so a bare restore still settles).
    this.emit();
    try {
      const lanes = Array.from({ length: Math.min(8, pending.length) }, async () => {
        while (pending.length) {
          signal.throwIfAborted();
          const { job } = pending.shift()!;
          const hit = await this.readServerCache(job, signal).catch(error => {
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            return undefined;
          });
          if (hit) this.cache.sf.set(job.key, hit as Evaluation);
        }
      });
      await Promise.all(lanes);
    } finally {
      for (const job of restoring) {
        const left = (this.primeInflight.get(job.key)?.count ?? 1) - 1;
        if (left <= 0) this.primeInflight.delete(job.key);
        else this.primeInflight.set(job.key, { count: left, engine: job.engine });
      }
      this.emit();
    }
    // Remainder for the queue: anything still unfinished. Failed keys stay in
    // (probing them again is wasted), but they must reach syncPlayQueueResolved
    // below: it clears failures for desired positions so the next sync retries
    // them instead of leaving a permanent hole. Terminals likewise flow
    // through — the queue, not the prime, seeds them.
    return items.filter(({ node }) => {
      const resolved = resolveSettings(settings, node);
      const key = reviewKey('sf', node, resolved);
      return !this.cache.sf.peek(key);
    });
  }
  startBatch(nodes: ReviewNode[], settings: SettingsInput) {
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
        if (!batch.completed.has(key) && !this.failures.has(key) && !this.cache.sf.peek(key)) out.add(key);
      }
    }
    for (const [key, entry] of this.primeInflight) if (entry.engine === 'sf' && entry.count > 0) out.add(key);
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
        if (degraded && this.inBatch(job)) this.batch!.degradedMaia = true;
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
      // Settled queue jobs leave the queue; aborted ones stay for retry. A
      // pruned-while-running job is already gone, so it is never resurrected.
      if (!aborted && engine === 'sf') this.playQueue = this.playQueue.filter(queued => queued.key !== job.key);
      if (!aborted && this.inBatch(job)) this.batch!.completed.add(job.key);
      this.pump(engine); this.emit(); this.maybeLogBatchSummary();
    });
  }
  // Prime memory caches from the server eval cache without inference. Reads
  // only: positions missing server-side stay missing for an explicit,
  // user-gated batch, so evicted rows can never trigger automatic engine
  // work. Terminals resolve locally and count as covered.
  async primeLine(nodes: ReviewNode[], settings: SettingsInput, signal: AbortSignal): Promise<{ covered: number; total: number }> {
    const terminals = new Set<ReviewNode>();
    const pending: Job[] = [];
    for (const node of nodes) {
      const resolved = resolveSettings(settings, node);
      const terminal = terminalEvaluation(replay(node.moves, node.initialFen));
      if (terminal) {
        terminals.add(node);
        this.cache.sf.set(reviewKey('sf', node, resolved), { ...terminal, search_policy: stockfishPolicy(resolved.stockfish) });
        continue;
      }
      for (const engine of ['sf', 'maia'] as const) {
        const key = reviewKey(engine, node, resolved);
        if (!this.cache[engine].peek(key)) pending.push({ engine, node, settings: resolved, key });
      }
    }
    // In-flight restores count as pending work (see sfPendingKeys): a history
    // game loading its saved evaluations is genuinely loading. Refcounted so
    // overlapping primes for the same key cannot clear each other, and
    // released in a finally so aborts never leak a stuck spinner.
    const restoring = pending.map(job => ({ key: job.key, engine: job.engine }));
    for (const job of restoring) {
      const entry = this.primeInflight.get(job.key);
      this.primeInflight.set(job.key, { count: (entry?.count ?? 0) + 1, engine: job.engine });
    }
    // Notify now so badges animate for the whole restore, not just after the
    // first probe settles.
    this.emit();
    try {
      const lanes = Array.from({ length: Math.min(8, pending.length) }, async () => {
        while (pending.length) {
          signal.throwIfAborted();
          const job = pending.shift()!;
          const hit = await this.readServerCache(job, signal).catch(error => {
            if (error instanceof DOMException && error.name === 'AbortError') throw error;
            return undefined;
          });
          // Degraded rows are rejected at the probe, so a validated hit is
          // safe to keep indefinitely.
          if (hit) {
            if (job.engine === 'sf') this.cache.sf.set(job.key, hit as Evaluation);
            else this.cache.maia.set(job.key, hit as MoveResponse, Infinity);
          }
        }
      });
      await Promise.all(lanes);
      let covered = 0;
      for (const node of nodes) {
        const resolved = resolveSettings(settings, node);
        if (this.cache.sf.peek(reviewKey('sf', node, resolved)) &&
          (terminals.has(node) || this.cache.maia.peek(reviewKey('maia', node, resolved)))) covered++;
      }
      return { covered, total: nodes.length };
    } finally {
      for (const job of restoring) {
        const left = (this.primeInflight.get(job.key)?.count ?? 1) - 1;
        if (left <= 0) this.primeInflight.delete(job.key);
        else this.primeInflight.set(job.key, { count: left, engine: job.engine });
      }
      this.emit();
    }
  }
  // Read-only server probe used by primeLine and the play lane: positions
  // missing server-side stay missing for an explicit, user-gated batch, so
  // evicted rows can never trigger automatic engine work. Other live paths
  // (execute outside the play lane) probe only for downward supersets (see
  // probeSuperset); exact lookups otherwise ride the read-through POST
  // /evaluate and POST /move instead.
  private async readServerCache(job: Job, signal: AbortSignal): Promise<Result | undefined> {
    const exact = await this.probeEvaluation(cacheHash(job.key), signal);
    if (exact) {
      const hit = this.validStoredRow(exact, job);
      if (hit) return hit;
    }
    // Exact miss: Stockfish may still reuse a larger-mpv row sliced down.
    if (job.engine === 'sf') return this.probeSuperset(job, signal);
    return undefined;
  }
  // Single cache probe with a fast-miss contract: 404/unreadable/non-OK
  // degrade to undefined, aborts rethrow. A probe that never settles (dead
  // socket after backgrounding) must degrade to a miss, never wedge the
  // caller: the race timer rejects independently of the fetcher so it also
  // covers fetchers that ignore the abort signal.
  private async probeEvaluation(hash: string, signal: AbortSignal): Promise<{ engine?: unknown; value?: unknown } | undefined> {
    let response: Response;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      response = await Promise.race([
        this.fetcher(`/evaluations/${hash}`, { signal }),
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
    if (!response.ok) return undefined;
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }
    return body as { engine?: unknown; value?: unknown };
  }
  private validStoredRow(record: { engine?: unknown; value?: unknown }, job: Job): Result | undefined {
    if (record.engine !== job.engine) return undefined;
    try {
      // Degraded Maia rows are stand-ins, never canonical: a lax legacy row
      // must read as a miss so live inference overwrites it.
      if (job.engine === 'sf') return parseEvaluation(record.value, job.settings.stockfish);
      const reply = parseMoveResponse(record.value);
      return reply.degraded ? undefined : reply;
    } catch {
      return undefined;
    }
  }
  private peekSuperset(job: Job): Evaluation | undefined {
    if (job.engine !== 'sf' || !job.settings.stockfish) return undefined;
    for (let lines = job.settings.stockfish.lines + 1; lines <= 5; lines++) {
      const witness = witnessSettings(job.settings, lines);
      if (!witness) continue;
      const hit = this.cache.sf.peek(reviewKey('sf', job.node, witness));
      if (!hit) continue;
      const sliced = sliceSupersetEvaluation(hit, job.node, job.settings, witness);
      if (sliced) return sliced;
    }
    return undefined;
  }
  // Downward-only server fallback: probe larger-mpv rows for the same
  // position and time/depth, concurrently so the added latency stays one
  // probe round. The smallest sufficient mpv wins, since it is closest to a
  // native search. Nothing is written back: derived rows stay read-time only.
  private async probeSuperset(job: Job, signal: AbortSignal): Promise<Evaluation | undefined> {
    const want = job.settings.stockfish?.lines;
    if (job.engine !== 'sf' || want === undefined) return undefined;
    const candidates: { witness: ReviewSettings; hash: string }[] = [];
    for (let lines = want + 1; lines <= 5; lines++) {
      const witness = witnessSettings(job.settings, lines);
      if (witness) candidates.push({ witness, hash: cacheHash(reviewKey('sf', job.node, witness)) });
    }
    const settled = await Promise.all(candidates.map(async ({ witness, hash }) => {
      let record: { engine?: unknown; value?: unknown } | undefined;
      try {
        record = await this.probeEvaluation(hash, signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        return undefined;
      }
      if (!record || record.engine !== 'sf') return undefined;
      return sliceSupersetEvaluation(record.value, job.node, job.settings, witness);
    }));
    return settled.find((sliced): sliced is Evaluation => sliced !== undefined);
  }

  private async execute(job: Job, signal: AbortSignal): Promise<{ result: Result; source: 'server-cache' | 'live' | 'memory'; retries: number }> {
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
      const mem = this.peekSuperset(job);
      if (mem) {
        this.cache.sf.set(job.key, mem);
        return { result: mem, source: 'memory', retries };
      }
      if (job.lane === 'play') {
        // Play lane: exact-first read-through. Play positions are evaluated at
        // the user's fixed lines setting, so the exact row is the common hit;
        // opening with the analysis-batch superset fan-out costs 3-4 wasted
        // round trips per job on every page load (measured: ~400 probes for a
        // 133-ply game). readServerCache still falls back to larger rows, so
        // established superset reuse keeps working; true misses POST as usual.
        const hit = await this.readServerCache(job, signal);
        if (hit) {
          this.cache.sf.set(job.key, hit as Evaluation);
          return { result: hit, source: 'server-cache', retries };
        }
      } else if (job.settings.stockfish) {
        // No extra await when supersets are inapplicable (legacy settings
        // without stockfish): the lane keeps its exact previous timing.
        const sup = await this.probeSuperset(job, signal);
        if (sup) {
          this.cache.sf.set(job.key, sup);
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
