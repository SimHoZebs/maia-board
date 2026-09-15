import { assertLegalUci, MaiaApiError, parseMoveResponse, type MaiaModel, type MoveResponse } from './api';
import { posId, type Timeline, type TimelineRow } from './domain';
import { outcomeEvaluation } from './outcomeEvaluation';
import { fetchJsonWithBusyRetry } from './evaluationTransport';
import type { Evaluation, Score } from './reviewMetrics';
import { defaultStockfishSettings, stockfishPolicy, type StockfishSettings } from './stockfishSettings';
import { clampMaiaElo } from './BoardTools';

export type ReviewNode = TimelineRow & { timeline: Timeline; initialFen: string };
// Rows are exposed directly as frozen plain objects. No wrapper class or
// WeakMap: cache identity is stable content (fen + history), never memory IDs,
// so fresh objects for the same content hit the same reviewKey.
export function reviewNodes(timeline: Timeline): ReviewNode[] {
  return timeline.rows.map(row => Object.freeze({ ...row, timeline, initialFen: timeline.initialFen }));
}
export type ReviewSettings = { eloMaia: number; eloUser: number; model: MaiaModel; stockfish?: StockfishSettings };
export type Engine = 'sf' | 'maia';
export type SettingsInput = ReviewSettings | ((node: ReviewNode) => ReviewSettings);
export const resolveSettings = (input: SettingsInput, node: ReviewNode): ReviewSettings => typeof input === 'function' ? input(node) : input;
export type Job = { key: string; engine: Engine; node: ReviewNode; settings: ReviewSettings };
export type EvaluationResult = Evaluation & { actual_settings?: StockfishSettings; cached?: boolean };
export type StockfishResult = EvaluationResult;
type Result = Evaluation | MoveResponse;
// One identity struct owns position + engine + settings. posId is
// hash(initialFen, prefix); the review key adds engine + settings hash.
// The HTTP request derives from the same prefix slice, so keys and wire
// payloads cannot drift.
function prefixOf(node: ReviewNode): string[] {
  return node.timeline.moves.slice(0, node.ply);
}
export function settingsHash(engine: Engine, settings: ReviewSettings): string {
  return engine === 'sf' ? stockfishPolicy(settings.stockfish) : JSON.stringify([clampMaiaElo(settings.eloMaia), clampMaiaElo(settings.eloUser), settings.model]);
}
export function stablePositionKey(node: ReviewNode): string {
  return posId(node.initialFen, prefixOf(node));
}
export function reviewKey(engine: Engine, node: ReviewNode, settings: ReviewSettings): string {
  return JSON.stringify([posId(node.initialFen, prefixOf(node)), engine, settingsHash(engine, settings)]);
}

// Prefix arrays exist only at the HTTP boundary.
export function evaluationRequest(engine: Engine, node: ReviewNode, settings: ReviewSettings) {
  return { engine, fen: node.fen, initial_fen: node.initialFen, moves: prefixOf(node),
    ...(engine === 'sf' ? { ...(settings.stockfish ? { settings: settings.stockfish } : {}) }
      : { elo_maia: clampMaiaElo(settings.eloMaia), elo_user: clampMaiaElo(settings.eloUser), model: settings.model }) };
}
const uci = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
function isScore(value: unknown): value is Score {
  if (!value || typeof value !== 'object') return false;
  const score = value as Score;
  if (!Number.isInteger(score.value)) return false;
  return score.type === 'cp' ? Math.abs(score.value) <= 100000 && score.winning_side === undefined
    : score.type === 'mate' && Math.abs(score.value) <= 1000 && ((score.winning_side === 'white' && score.value >= 0) || (score.winning_side === 'black' && score.value <= 0));
}
function actualPolicy(value: Evaluation, requested: StockfishSettings | undefined, actual: unknown): StockfishSettings | undefined {
  if (!requested) {
    if (value.search_policy !== stockfishPolicy(undefined) || actual != null) throw new Error('Stockfish returned incompatible search settings.');
    return;
  }
  const want = requested;
  // Live responses may carry the wrapper field directly. A policy can also
  // identify its settings, but it must agree with any supplied provenance.
  const match = /^sf19-ms(\d+)-mpv(\d+)-d(\d+)-t1-h64-v2$/.exec(value.search_policy);
  const policy = match ? { time_ms: Number(match[1]), lines: Number(match[2]), depth: Number(match[3]) } : undefined;
  const settings = actual as StockfishSettings | undefined;
  const found = settings ?? policy;
  if (!found || !Number.isInteger(found.time_ms) || !Number.isInteger(found.lines) || !Number.isInteger(found.depth)
    || found.time_ms !== want.time_ms || found.depth !== want.depth || found.lines < want.lines || found.lines > 5
    || value.search_policy !== stockfishPolicy(found)) {
    throw new Error('Stockfish returned incompatible search settings.');
  }
  return { ...found };
}
export function parseEvaluation(body: unknown, settings?: StockfishSettings, actual?: unknown, fen?: string): StockfishResult {
  const invalid = () => new Error('Stockfish returned an incomplete evaluation.');
  if (!body || typeof body !== 'object') throw invalid();
  const value = body as Evaluation & { actual_settings?: unknown };
  if (value.engine !== 'Stockfish 19' || typeof value.search_policy !== 'string' || !Number.isInteger(value.depth) || value.depth < 0 || value.depth > 256
    || !isScore(value.score) || ![null, 'white_win', 'black_win', 'draw'].includes(value.terminal) || !Array.isArray(value.lines)) throw invalid();
  const provenance = actualPolicy(value, settings, actual ?? value.actual_settings);
  if (actual && value.actual_settings && JSON.stringify(actual) !== JSON.stringify(value.actual_settings)) {
    const a = actual as StockfishSettings, b = value.actual_settings as StockfishSettings;
    if (a.time_ms !== b.time_ms || a.lines !== b.lines || a.depth !== b.depth) throw invalid();
  }
  if (value.terminal !== null) {
    if (value.best_move !== null || value.lines.length || value.depth !== 0) throw invalid();
    if (value.terminal === 'draw' ? value.score.type !== 'cp' || value.score.value !== 0
      : value.score.type !== 'mate' || value.score.value !== 0 || value.score.winning_side !== (value.terminal === 'white_win' ? 'white' : 'black')) throw invalid();
  } else {
    if (!value.lines.length || value.lines.length > (provenance?.lines ?? 2) || value.best_move !== value.lines[0]?.move) throw invalid();
    if (!value.lines.every(line => line && typeof line.move === 'string' && uci.test(line.move) && isScore(line.score) && line.depth === value.depth && line.depth >= 1 && (!settings?.depth || line.depth <= settings.depth))
      || new Set(value.lines.map(line => line.move)).size !== value.lines.length) throw invalid();
    if (value.depth < Math.min(...value.lines.map(line => line.depth)) || value.score.type !== value.lines[0].score.type
      || value.score.value !== value.lines[0].score.value || value.score.winning_side !== value.lines[0].score.winning_side) throw invalid();
    if (fen) {
      try { assertLegalUci(value.lines.map(line => line.move), fen); }
      catch { throw invalid(); }
    }
  }
  const { actual_settings: _reported, ...parsed } = value;
  return { ...parsed, lines: value.lines.slice(0, (settings ?? defaultStockfishSettings).lines), ...(provenance ? { actual_settings: provenance } : {}) };
}

export async function fetchEvaluation(node: ReviewNode, signal: AbortSignal, fetcher: typeof fetch = fetch, settings?: StockfishSettings): Promise<StockfishResult> {
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await fetchJsonWithBusyRetry(fetcher, '/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fen: node.fen, initial_fen: node.initialFen, moves: prefixOf(node), ...(settings ? { settings } : {}) }) }, signal));
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('Stockfish is unreachable. Check that the server is running on your LAN.');
  }
  if (body === null) throw new Error('Stockfish returned unreadable data.');
  if (!response.ok) {
    const record = body as { code?: unknown; message?: unknown };
    throw new MaiaApiError((record?.code as MaiaApiError['code'] | undefined) ?? 'unknown',
      typeof record?.message === 'string' ? record.message : `Stockfish request failed (${response.status}).`, response.status);
  }
  const parsed = parseEvaluation(body, settings, undefined, node.fen);
  return response.headers.get('X-Eval-Cache') === 'hit' ? { ...parsed, cached: true } : parsed;
}

// Settled results live for the app lifetime. Workspace schedulers own requests,
// failures and subscriptions; disposing one workspace cannot erase these rows.
export class EvaluationStore {
  private cache = new Map<string, Result>();
  private retain(key: string, value: Result) {
    this.cache.delete(key); this.cache.set(key, value);
    if (this.cache.size > 4096) this.cache.delete(this.cache.keys().next().value!);
  }
  private listeners = new Set<() => void>();
  version = 0;
  constructor(private fetcher: typeof fetch = (input, init) => fetch(input, init)) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  notify() { this.version++; this.listeners.forEach(listener => listener()); }
  result<E extends Engine>(engine: E, node: ReviewNode, settings: ReviewSettings): (E extends 'sf' ? EvaluationResult : MoveResponse) | undefined {
    const key = reviewKey(engine, node, settings);
    if (engine === 'sf' && node.outcome && !this.cache.has(key)) this.retain(key, outcomeEvaluation(node.outcome, settings.stockfish)!);
    return this.cache.get(key) as (E extends 'sf' ? EvaluationResult : MoveResponse) | undefined;
  }
  peek(_engine: Engine, key: string) { return this.cache.get(key); }
  store<E extends Engine>(_engine: E, key: string, value: E extends 'sf' ? Evaluation : MoveResponse) { this.retain(key, value); this.notify(); }
  private async restore(jobs: Job[], signal: AbortSignal): Promise<void> {
    const pending = [...new Map(jobs.filter(job => !this.cache.has(job.key)).map(job => [job.key, job])).values()];
    // The byte bound includes the surrounding JSON and commas. Encode only
    // the current chunk so long histories do not retain all prefix arrays.
    for (let at = 0; at < pending.length;) {
      const chunk: Job[] = [];
      const requests: ReturnType<typeof evaluationRequest>[] = [];
      let bytes = 15;
      while (at < pending.length && chunk.length < 1024) {
        const job = pending[at];
        const request = evaluationRequest(job.engine, job.node, job.settings);
        const size = new TextEncoder().encode(JSON.stringify(request)).length + 1;
        if (bytes + size > 4 * 1024 * 1024) { if (!chunk.length) throw new Error('Evaluation request exceeds 4 MiB.'); break; }
        bytes += size; chunk.push(job); requests.push(request); at++;
      }
      const { response, body } = await fetchJsonWithBusyRetry(this.fetcher, '/evaluations/lookup',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests }) }, signal, 30_000);
      signal.throwIfAborted();
      if (!response.ok) throw new Error(`Evaluation lookup failed (${response.status}).`);
      const payload = body as { results?: { index: number; value: unknown; actual_settings?: unknown }[] } | null;
      if (!Array.isArray(payload?.results)) throw new Error('Evaluation lookup returned an incomplete list.');
      const counts = new Map<number, number>();
      for (const row of payload.results) if (row && Number.isInteger(row.index)) counts.set(row.index, (counts.get(row.index) ?? 0) + 1);
      for (const row of payload.results) {
        if (!row || !Number.isInteger(row.index) || counts.get(row.index) !== 1) continue;
        const job = chunk[row.index];
        if (!job) continue;
        try {
          const value = job.engine === 'sf' ? parseEvaluation(row.value, job.settings.stockfish, row.actual_settings, job.node.fen)
            : parseMoveResponse(row.value, { model: job.settings.model, fen: job.node.fen });
          this.retain(job.key, value);
        } catch { /* Malformed cached values remain misses. */ }
      }
      this.notify();
    }
  }
  async prime(nodes: ReviewNode[], settings: SettingsInput, engines: Engine[], signal: AbortSignal) {
    const jobs = nodes.flatMap(node => node.outcome ? [] : engines.map(engine => ({ engine, node, settings: resolveSettings(settings, node), key: reviewKey(engine, node, resolveSettings(settings, node)) })));
    await this.restore(jobs, signal);
  }
  primeCoverage(nodes: ReviewNode[], settings: SettingsInput, engines: Engine[]): { total: number; covered: number } {
    const both = engines.includes('sf') && engines.includes('maia');
    return { total: nodes.length, covered: nodes.filter(node => both
      ? this.result('sf', node, resolveSettings(settings, node)) && (node.outcome || this.result('maia', node, resolveSettings(settings, node)))
      : engines.every(engine => engine === 'maia' ? (node.outcome || this.result('maia', node, resolveSettings(settings, node))) : this.result('sf', node, resolveSettings(settings, node)))).length };
  }
}
export const evaluationStore = new EvaluationStore();
