import { assertLegalUci, MaiaApiError, parseMoveResponse, type MaiaModel, type MoveResponse } from './api';
import { Chess } from 'chess.js';
import { applyUci, posId, type Timeline, type TimelineRow } from './domain';
import { outcomeEvaluation } from './outcomeEvaluation';
import { fetchJsonWithBusyRetry } from './evaluationTransport';
import { isRecord, isStringArray, isStockfishSettings } from './guards';
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
// Mirrors api.ts: unknown wire codes normalize to 'unknown' (the message is
// preserved), so the engine→MaiaApiError translation is proven, not asserted.
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'engine_busy', 'engine_unavailable', 'game_over', 'history_too_long', 'invalid_elo',
  'invalid_fen', 'invalid_initial_fen', 'invalid_json', 'invalid_maia_color',
  'invalid_model', 'invalid_move', 'invalid_position', 'invalid_request',
  'method_not_allowed', 'missing_elo', 'not_maia_turn', 'position_mismatch',
  'server_unreachable', 'superseded', 'unknown',
]);
function isApiErrorCode(value: unknown): value is MaiaApiError['code'] {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value);
}
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
  if (!isRecord(value)) return false;
  const { type, value: amount, winning_side: side } = value;
  if (typeof amount !== 'number' || !Number.isInteger(amount)) return false;
  return type === 'cp' ? Math.abs(amount) <= 100000 && side === undefined
    : type === 'mate' && Math.abs(amount) <= 1000 && ((side === 'white' && amount >= 0) || (side === 'black' && amount <= 0));
}
// Rank-line shape: pv stays unknown here (proven per-rank below — rank 1
// allows a shaped PV, lower ranks must omit it), except that a present PV
// must already be a string array so the body predicate never claims a pv
// type the loop has not proven.
type EvaluationLine = { move: string; score: Score; depth: number; pv?: string[] };
function isEvaluationLine(line: unknown): line is EvaluationLine {
  if (!isRecord(line) || typeof line.move !== 'string' || !isScore(line.score)
    || typeof line.depth !== 'number' || !Number.isInteger(line.depth)) return false;
  return line.pv === undefined || isStringArray(line.pv);
}
// Top-level wire shape. Deliberately no stricter than the checks below:
// best_move garbage and malformed lines are still rejected later with the
// same invalid() error, so the accept set is unchanged — this only gives the
// rest of the function a proven Evaluation type to work with.
function isEvaluationBody(value: unknown): value is Evaluation & { actual_settings?: unknown } {
  return isRecord(value) && value.engine === 'Stockfish 19' && typeof value.search_policy === 'string'
    && typeof value.depth === 'number' && Number.isInteger(value.depth) && value.depth >= 0 && value.depth <= 256
    && isScore(value.score) && (value.terminal === null || value.terminal === 'white_win' || value.terminal === 'black_win' || value.terminal === 'draw')
    && (typeof value.best_move === 'string' || value.best_move === null) && Array.isArray(value.lines) && value.lines.every(isEvaluationLine);
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
  // Present-but-malformed provenance previously failed the integer checks
  // below; reject it here instead so no fallback can mask it.
  if (actual != null && !isStockfishSettings(actual)) throw new Error('Stockfish returned incompatible search settings.');
  const found = (actual == null ? undefined : actual) ?? policy;
  if (!found || !Number.isInteger(found.time_ms) || !Number.isInteger(found.lines) || !Number.isInteger(found.depth)
    || found.time_ms !== want.time_ms || found.depth !== want.depth || found.lines < want.lines || found.lines > 5
    || value.search_policy !== stockfishPolicy(found)) {
    throw new Error('Stockfish returned incompatible search settings.');
  }
  return { ...found };
}
export function parseEvaluation(body: unknown, settings?: StockfishSettings, actual?: unknown, fen?: string): StockfishResult {
  const invalid = () => new Error('Stockfish returned an incomplete evaluation.');
  if (!isEvaluationBody(body)) throw invalid();
  const value = body;
  const provenance = actualPolicy(value, settings, actual ?? value.actual_settings);
  if (actual && value.actual_settings && JSON.stringify(actual) !== JSON.stringify(value.actual_settings)) {
    const left = isRecord(actual) ? actual : undefined;
    const right = isRecord(value.actual_settings) ? value.actual_settings : undefined;
    if (left?.time_ms !== right?.time_ms || left?.lines !== right?.lines || left?.depth !== right?.depth) throw invalid();
  }
  if (value.terminal !== null) {
    if (value.best_move !== null || value.lines.length || value.depth !== 0) throw invalid();
    if (value.terminal === 'draw' ? value.score.type !== 'cp' || value.score.value !== 0
      : value.score.type !== 'mate' || value.score.value !== 0 || value.score.winning_side !== (value.terminal === 'white_win' ? 'white' : 'black')) throw invalid();
  } else {
    if (!value.lines.length || value.lines.length > (provenance?.lines ?? 2) || value.best_move !== value.lines[0]?.move) throw invalid();
    if (!value.lines.every(line => line && typeof line.move === 'string' && uci.test(line.move) && isScore(line.score) && line.depth === value.depth && line.depth >= 1 && (!settings?.depth || line.depth <= settings.depth))
      || new Set(value.lines.map(line => line.move)).size !== value.lines.length) throw invalid();
    // Optional rank-1 PV: shape-checked always; a chain-illegal tail with a
    // known FEN strips the annotation (valid score + lines survive, the note
    // stays silent) instead of rejecting the row. Lower ranks must omit it.
    for (let index = 0; index < value.lines.length; index++) {
      const line = value.lines[index];
      if (index === 0) {
        if (line.pv !== undefined) {
          if (line.pv.length < 1 || line.pv.length > 5
            || line.pv.some(move => !uci.test(move)) || line.pv[0] !== line.move) throw invalid();
          if (fen) {
            try {
              const game = new Chess(fen);
              for (const pvMove of line.pv) applyUci(game, pvMove);
            } catch { delete line.pv; }
          }
        }
      } else if (line.pv !== undefined) throw invalid();
    }
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
    const record: unknown = body;
    const code: unknown = isRecord(record) ? record.code : undefined;
    const message: unknown = isRecord(record) ? record.message : undefined;
    throw new MaiaApiError(isApiErrorCode(code) ? code : 'unknown',
      typeof message === 'string' ? message : `Stockfish request failed (${response.status}).`, response.status);
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
  result(engine: 'sf', node: ReviewNode, settings: ReviewSettings): EvaluationResult | undefined;
  result(engine: 'maia', node: ReviewNode, settings: ReviewSettings): MoveResponse | undefined;
  result(engine: Engine, node: ReviewNode, settings: ReviewSettings): EvaluationResult | MoveResponse | undefined;
  result(engine: Engine, node: ReviewNode, settings: ReviewSettings): EvaluationResult | MoveResponse | undefined {
    const key = reviewKey(engine, node, settings);
    if (engine === 'sf' && node.outcome && !this.cache.has(key)) this.retain(key, outcomeEvaluation(node.outcome, settings.stockfish)!);
    const found = this.cache.get(key);
    if (found === undefined) return undefined;
    // Keys embed the engine, so a mismatch is unreachable; drop it rather
    // than hand back a wrongly-typed row. Presence shape discriminates:
    // only Maia rows carry top_moves.
    if (engine === 'sf') return 'top_moves' in found ? undefined : found;
    return 'top_moves' in found ? found : undefined;
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
      const payload: unknown = body;
      if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error('Evaluation lookup returned an incomplete list.');
      const counts = new Map<number, number>();
      for (const row of payload.results) if (isRecord(row) && typeof row.index === 'number' && Number.isInteger(row.index)) counts.set(row.index, (counts.get(row.index) ?? 0) + 1);
      for (const row of payload.results) {
        if (!isRecord(row) || typeof row.index !== 'number' || !Number.isInteger(row.index) || counts.get(row.index) !== 1) continue;
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
