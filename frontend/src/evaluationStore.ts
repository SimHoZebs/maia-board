import { Chess } from 'chess.js';
import { parseMoveResponse, type MaiaModel, type MoveResponse } from './api';
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
export function resolveSettings(input: SettingsInput, node: ReviewNode): ReviewSettings {
  return typeof input === 'function' ? input(node) : input;
}
export type Job = { key: string; engine: Engine; node: ReviewNode; settings: ReviewSettings; lane?: 'play' };
type Result = Evaluation | MoveResponse;
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

const CACHE_PROBE_MS = 30_000;
const COVERAGE_CHUNK = 1000;
export type CoverageRow = { engine?: unknown; value?: unknown };

// Pure evaluation store: cache keys, memory rows, failures, server-cache
// restore, and change notifications. It owns every read of settled data and
// offers no delete/clear operation, so no scheduler action — foreground
// swaps, suspends, retries, navigation — can invalidate settled rows. The
// scheduler (reviewCoordinator) owns lanes, queues, batches, and inference;
// it writes only through store() on job completion and fail() on job failure.
export class EvaluationStore {
  private cache = { sf: new Lru<Evaluation>(), maia: new Lru<MoveResponse>() };
  private failures = new Map<string, string>();
  // Server-restore probes in flight, refcounted by key: overlapping primes
  // for the same position must not clear each other on completion.
  private primeInflight = new Map<string, { count: number; engine: Engine }>();
  private listeners = new Set<() => void>();
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
  // Schedulers call notify() after mutating lane/queue/batch state so
  // subscribers observe scheduler views (progress, pending) too.
  notify() { this.emit(); }
  result<E extends Engine>(engine: E, node: ReviewNode, settings: ReviewSettings): (E extends 'sf' ? Evaluation : MoveResponse) | undefined {
    return this.cache[engine].peek(reviewKey(engine, node, settings)) as (E extends 'sf' ? Evaluation : MoveResponse) | undefined;
  }
  error(engine: Engine, node: ReviewNode, settings: ReviewSettings) { return this.failures.get(reviewKey(engine, node, settings)); }
  peek(engine: Engine, key: string) { return this.cache[engine].peek(key); }
  store<E extends Engine>(engine: E, key: string, value: E extends 'sf' ? Evaluation : MoveResponse, ttl = Infinity) {
    this.cache[engine].set(key, value as Evaluation & MoveResponse, ttl);
  }
  // Terminal seeding mirrors the old job() fast path: terminal positions
  // resolve locally per policy and never enter any lane.
  seedTerminal(node: ReviewNode, settings: ReviewSettings, terminal: Evaluation): void {
    this.cache.sf.set(reviewKey('sf', node, settings), { ...terminal, search_policy: stockfishPolicy(settings.stockfish) });
  }
  fail(key: string, message: string) {
    this.failures.set(key, message);
    if (this.failures.size > 512) this.failures.delete(this.failures.keys().next().value!);
  }
  clearFailure(key: string) { this.failures.delete(key); }
  clearFailures() { this.failures.clear(); }
  failed(key: string) { return this.failures.has(key); }
  finishedKey(engine: Engine, key: string) { return !!this.cache[engine].peek(key) || this.failures.has(key); }
  inflightKeys(engine: Engine): string[] {
    const out: string[] = [];
    for (const [key, entry] of this.primeInflight) if (entry.engine === engine && entry.count > 0) out.push(key);
    return out;
  }
  // Bulk coverage fetch: one round trip answering which cache rows exist,
  // with values riding along. Chunked defensively. A probe that never
  // settles (dead socket after backgrounding) must degrade to per-job
  // probes, never wedge the caller: the race timer rejects independently of
  // the fetcher so it also covers fetchers that ignore the abort signal.
  // Aborts rethrow so superseded restores never settle.
  async fetchCoverage(hashes: string[], signal: AbortSignal): Promise<Map<string, CoverageRow>> {
    const found = new Map<string, CoverageRow>();
    for (let at = 0; at < hashes.length; at += COVERAGE_CHUNK) {
      signal.throwIfAborted();
      const query = hashes.slice(at, at + COVERAGE_CHUNK).map(hash => `hash=${encodeURIComponent(hash)}`).join('&');
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Response;
      try {
        response = await Promise.race([
          this.fetcher(`/evaluations/coverage?${query}`, { signal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new DOMException('Timed out', 'TimeoutError')), CACHE_PROBE_MS);
          }),
        ]);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      if (!response.ok) throw new Error(`Coverage request failed (${response.status}).`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('Coverage request returned unreadable data.');
      }
      const rows = (body as { rows?: unknown }).rows;
      if (!rows || typeof rows !== 'object') throw new Error('Coverage request returned an incomplete list.');
      for (const [hash, row] of Object.entries(rows)) {
        if (row && typeof row === 'object') found.set(hash, row as CoverageRow);
      }
    }
    return found;
  }
  // Seed memory from one bulk coverage round trip. Returns the seeded keys;
  // misses stay missing for per-job probes (exact 404 + superset reuse).
  // Validation matches the probe path exactly: engine match plus full parse,
  // so degraded Maia rows are rejected the same way.
  private async seedFromCoverage(pending: Job[], signal: AbortSignal): Promise<Set<string>> {
    const seeded = new Set<string>();
    if (!pending.length) return seeded;
    const byHash = new Map(pending.map(job => [cacheHash(job.key), job]));
    const rows = await this.fetchCoverage([...byHash.keys()], signal);
    for (const [hash, row] of rows) {
      signal.throwIfAborted();
      const job = byHash.get(hash);
      if (!job || seeded.has(job.key)) continue;
      const hit = this.validStoredRow(row, job);
      if (!hit) continue;
      if (job.engine === 'sf') this.cache.sf.set(job.key, hit as Evaluation);
      else this.cache.maia.set(job.key, hit as MoveResponse, Infinity);
      seeded.add(job.key);
    }
    return seeded;
  }
  // Prime memory caches from the server eval cache without inference. Reads
  // only: positions missing server-side stay missing for an explicit,
  // user-gated batch, so evicted rows can never trigger automatic engine
  // work. Terminals resolve locally and count as covered. One bulk coverage
  // round trip replaces hundreds of per-position probes; remaining misses
  // fall back to per-job probes (exact 404 + superset reuse) so witness
  // behavior is unchanged.
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
      let seeded: Set<string>;
      try {
        seeded = await this.seedFromCoverage(pending, signal);
      } catch (error) {
        // Bulk coverage unavailable (or aborted mid-seed): per-job probes
        // below degrade individually, exactly like the old fan-out. Aborts
        // still propagate so superseded restores never settle.
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        seeded = new Set();
      }
      const rest = pending.filter(job => !seeded.has(job.key));
      const lanes = Array.from({ length: Math.min(8, rest.length) }, async () => {
        while (rest.length) {
          signal.throwIfAborted();
          const job = rest.shift()!;
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
      let seeded: Set<string>;
      try {
        seeded = await this.seedFromCoverage(pending.map(entry => entry.job), signal);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        seeded = new Set();
      }
      const rest = pending.filter(({ job }) => !seeded.has(job.key));
      const lanes = Array.from({ length: Math.min(8, rest.length) }, async () => {
        while (rest.length) {
          signal.throwIfAborted();
          const { job } = rest.shift()!;
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
  peekSupersetFor(job: Job): Evaluation | undefined { return this.peekSuperset(job); }
  probeSupersetFor(job: Job, signal: AbortSignal): Promise<Evaluation | undefined> { return this.probeSuperset(job, signal); }
  readServerCacheFor(job: Job, signal: AbortSignal): Promise<Result | undefined> { return this.readServerCache(job, signal); }
}
