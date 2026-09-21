import { assertLegalUci, isApiErrorCode, MaiaApiError, parseMoveResponse, type MaiaModel, type MoveResponse } from './api';
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
export type ReviewSettings = { eloMaia: number; eloUser: number; model: MaiaModel; stockfish?: StockfishSettings;
  // Split evaluation: policy ordering at (eloMaia, eloUser), candidate WDL
  // values at (valueEloMaia, valueEloUser). Omitted (or equal to policy)
  // means legacy symmetric evaluation. The analysis display lane sets both
  // to 2400 so low-Elo move lists carry 2400-vs-2400 winrates.
  valueEloMaia?: number; valueEloUser?: number };
export type Engine = 'sf' | 'maia';
// Objective grading lane: Maia 2400/2400 on the strong model. This is the
// "Stockfish seat" for retrospective grades (Option 1): negative labels
// derive from its WDL loss while the adjustable display Maia owns rarity and
// wording. A frozen singleton so batch hashes and effect identities never
// churn; reviewKey already disambiguates it from display-Maia rows by Elo.
export const GRADING_MAIA_SETTINGS: ReviewSettings = Object.freeze({ eloMaia: 2400, eloUser: 2400, model: '79m' });
export function gradingMaiaKey(node: ReviewNode): string {
  return reviewKey('maia', node, GRADING_MAIA_SETTINGS);
}
export type SettingsInput = ReviewSettings | ((node: ReviewNode) => ReviewSettings);
export const resolveSettings = (input: SettingsInput, node: ReviewNode): ReviewSettings => typeof input === 'function' ? input(node) : input;
export type Job = { key: string; engine: Engine; node: ReviewNode; settings: ReviewSettings; fast?: boolean };

// Fast-then-refine derivation for Stockfish first paint. The bar + verdict
// need only rank-1, so focus/current nodes fetch MPV1 at min(250, requested)
// ms first, then refine to the full requested MPV2+ budget in the background.
// Same depth as requested; lines=1. Distinct settingsHash keys (time/lines
// differ), so fast and full cache separately — the display layer falls back
// to fast when full is missing. Returns undefined when there is no useful
// fast path: legacy omission (no stockfish) or an already-minimal 250ms
// budget where a second fetch would only add latency.
export function fastStockfishSettings(settings?: StockfishSettings): StockfishSettings | undefined {
  if (!settings) return undefined;
  if (settings.time_ms <= 250) return undefined;
  return { time_ms: Math.min(250, settings.time_ms), lines: 1, depth: settings.depth };
}
export function fastReviewSettings(settings: ReviewSettings): ReviewSettings | undefined {
  const fast = fastStockfishSettings(settings.stockfish);
  if (!fast) return undefined;
  return { ...settings, stockfish: fast };
}
export type EvaluationResult = Evaluation & { actual_settings?: StockfishSettings; cached?: boolean };
export type StockfishResult = EvaluationResult;
// Error-code vocabulary is owned once by api.ts (isApiErrorCode): unknown
// wire codes normalize to 'unknown' with the message preserved. Per-endpoint
// codes ride under that one sender taxonomy — no fork here.
type Result = Evaluation | MoveResponse;
// One identity struct owns position + engine + settings. posId is
// hash(initialFen, prefix); the review key adds engine + settings hash.
// The HTTP request derives from the same prefix slice, so keys and wire
// payloads cannot drift.
function prefixOf(node: ReviewNode): string[] {
  return node.timeline.moves.slice(0, node.ply);
}
// Normalized split coordinates: explicit value Elos equal to policy Elos
// collapse to omitted so 2400 display rows dedup with the grading lane and
// legacy keys keep hitting. Mirrors backend maiaIdentity normalization.
export function splitValueElos(settings: ReviewSettings): { valueEloMaia?: number; valueEloUser?: number } {
  const policyMaia = clampMaiaElo(settings.eloMaia), policyUser = clampMaiaElo(settings.eloUser);
  const valueMaia = settings.valueEloMaia === undefined ? undefined : clampMaiaElo(settings.valueEloMaia);
  const valueUser = settings.valueEloUser === undefined ? undefined : clampMaiaElo(settings.valueEloUser);
  return {
    ...(valueMaia !== undefined && valueMaia !== policyMaia ? { valueEloMaia: valueMaia } : {}),
    ...(valueUser !== undefined && valueUser !== policyUser ? { valueEloUser: valueUser } : {}),
  };
}
export function settingsHash(engine: Engine, settings: ReviewSettings): string {
  if (engine === 'sf') return stockfishPolicy(settings.stockfish);
  const split = splitValueElos(settings);
  return JSON.stringify([clampMaiaElo(settings.eloMaia), clampMaiaElo(settings.eloUser), settings.model,
    ...(split.valueEloMaia !== undefined || split.valueEloUser !== undefined ? [split.valueEloMaia ?? null, split.valueEloUser ?? null] : [])]);
}
export function stablePositionKey(node: ReviewNode): string {
  return posId(node.initialFen, prefixOf(node));
}
export function reviewKey(engine: Engine, node: ReviewNode, settings: ReviewSettings): string {
  return JSON.stringify([posId(node.initialFen, prefixOf(node)), engine, settingsHash(engine, settings)]);
}

// Line-oriented bulk wire: the full line ships once per POST, entries carry
// only ply. Client keys stay prefix-based locally (reviewKey/posId via
// prefixOf); only the wire payload changes. pos_hash rides along allowlisted
// and ignored for identity, as before.
export type BatchLine = { initial_fen: string; moves: string[] };
export function batchLineFor(timeline: { initialFen: string; moves: readonly string[] }): BatchLine {
  return { initial_fen: timeline.initialFen, moves: [...timeline.moves] };
}
export function lineKeyForNode(node: ReviewNode): string {
  return posId(node.timeline.initialFen, node.timeline.moves);
}
export function evaluationRequest(engine: Engine, node: ReviewNode, settings: ReviewSettings) {
  if (engine === 'sf') {
    return { engine, ply: node.ply, fen: node.fen, pos_hash: stablePositionKey(node),
      ...(settings.stockfish ? { settings: settings.stockfish } : {}) };
  }
  const split = splitValueElos(settings);
  return { engine, ply: node.ply, fen: node.fen, pos_hash: stablePositionKey(node),
    elo_maia: clampMaiaElo(settings.eloMaia), elo_user: clampMaiaElo(settings.eloUser), model: settings.model,
    ...(split.valueEloMaia !== undefined ? { value_elo_maia: split.valueEloMaia } : {}),
    ...(split.valueEloUser !== undefined ? { value_elo_user: split.valueEloUser } : {}) };
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
  const match = /^sf19-ms(\d+)-mpv(\d+)-d(\d+)-t4-h128-v3$/.exec(value.search_policy);
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
  // pos_hash rides along (backend allowlists it, ignored for identity) so
  // /evaluate and /evaluations/lookup share the same position identity.
  const sfWire = { fen: node.fen, initial_fen: node.initialFen, moves: prefixOf(node), pos_hash: stablePositionKey(node) };
  try {
    ({ response, body } = await fetchJsonWithBusyRetry(fetcher, '/evaluate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings ? { ...sfWire, settings } : sfWire) }, signal));
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
  // Provisional first-paint read: full MPV2 when present, else the fast MPV1
  // row when only it has landed. Score/verdict need only rank-1, so they
  // render from fast; the candidate list shows the single fast line until the
  // full refine lands (no separate skeleton — 1 line provisionally is the
  // refine signal). Outcomes never use fast (synthetic, no fetch).
  provisionalSfResult(node: ReviewNode, settings: ReviewSettings): EvaluationResult | undefined {
    const full = this.result('sf', node, settings);
    if (full || node.outcome) return full;
    const fast = fastReviewSettings(settings);
    return fast ? this.result('sf', node, fast) : undefined;
  }
  // Single restore path: cache-fill + visible-pair-first live here and
  // nowhere else. Jobs for the given plies (ReviewNode .ply values, e.g.
  // focus/current) lead the first /evaluations/lookup chunk; the remainder
  // follows in line order within the same chunk limits. Pure reorder — no
  // filtering, no new fetches, no chunk-limit change; the cache check below
  // dedupes already-settled rows so a focus-first call never double-fetches.
  // The coordinator keeps only the live foreground pump and delegates here
  // for settled rows; there is no second two-phase focus path.
  async restore(nodes: ReviewNode[], settings: SettingsInput, engines: Engine[], signal: AbortSignal, priorityPlies?: readonly number[]): Promise<{ total: number; covered: number }> {
    const jobs = nodes.flatMap(node => node.outcome ? [] : engines.map(engine => ({ engine, node, settings: resolveSettings(settings, node), key: reviewKey(engine, node, resolveSettings(settings, node)) })));
    const ordered = (() => {
      if (!priorityPlies?.length) return jobs;
      const wanted = new Set(priorityPlies);
      const head: Job[] = [];
      const tail: Job[] = [];
      for (const job of jobs) (wanted.has(job.node.ply) ? head : tail).push(job);
      return [...head, ...tail];
    })();
    const pending = [...new Map(ordered.filter(job => !this.cache.has(job.key)).map(job => [job.key, job])).values()];
    // Group by line: one POST per distinct timeline (line ships once, entries
    // carry ply). In practice restores are single-line; grouping keeps
    // heterogeneous calls correct without changing the single-line fast path.
    const groups = new Map<string, { line: BatchLine; jobs: Job[] }>();
    for (const job of pending) {
      const key = lineKeyForNode(job.node);
      let group = groups.get(key);
      if (!group) {
        group = { line: batchLineFor(job.node.timeline), jobs: [] };
        groups.set(key, group);
      }
      group.jobs.push(job);
    }
    const encoder = new TextEncoder();
    for (const { line, jobs: groupJobs } of groups.values()) {
      // Byte bound covers the line once plus entries and surrounding JSON:
      // exact base size for {"line":...,"requests":[]}, then entries + commas.
      const baseBytes = encoder.encode(JSON.stringify({ line, requests: [] })).length;
      // Encode entries only for the current chunk.
      for (let at = 0; at < groupJobs.length;) {
        const chunk: Job[] = [];
        const requests: ReturnType<typeof evaluationRequest>[] = [];
        let bytes = baseBytes;
        while (at < groupJobs.length && chunk.length < 1024) {
          const job = groupJobs[at];
          const request = evaluationRequest(job.engine, job.node, job.settings);
          const size = encoder.encode(JSON.stringify(request)).length + 1;
          if (bytes + size > 4 * 1024 * 1024) { if (!chunk.length) throw new Error('Evaluation request exceeds 4 MiB.'); break; }
          bytes += size; chunk.push(job); requests.push(request); at++;
        }
        const { response, body } = await fetchJsonWithBusyRetry(this.fetcher, '/evaluations/lookup',
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line, requests }) }, signal, 30_000);
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
    return this.primeCoverage(nodes, settings, engines);
  }
  primeCoverage(nodes: ReviewNode[], settings: SettingsInput, engines: Engine[]): { total: number; covered: number } {
    const both = engines.includes('sf') && engines.includes('maia');
    return { total: nodes.length, covered: nodes.filter(node => both
      ? this.result('sf', node, resolveSettings(settings, node)) && (node.outcome || this.result('maia', node, resolveSettings(settings, node)))
      : engines.every(engine => engine === 'maia' ? (node.outcome || this.result('maia', node, resolveSettings(settings, node))) : this.result('sf', node, resolveSettings(settings, node)))).length };
  }
}
export const evaluationStore = new EvaluationStore();
