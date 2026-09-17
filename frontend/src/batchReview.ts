import { MaiaApiError, parseErrorCode } from './api';
import { isNonNegativeInt, isRecord, isStringMap } from './guards';
import { evaluationRequest, resolveSettings, reviewKey, type Engine, type ReviewNode, type SettingsInput } from './evaluationStore';

export type BatchItem = { request: ReturnType<typeof evaluationRequest>; key: string; engine: Engine };
export type BatchProgress = {
  job_id: string; total: number; done: number; failed: number;
  finished: boolean; errors?: Record<string, string>;
};
export type BatchSubmitted = { job_id: string; total: number; cached: number; pending: number };

// Persisted batch identity: lets a reloaded tab reattach to its own running
// job instead of showing Analyze again and submitting a duplicate.
// Single entry is enough for reload reattach: the latest submit is the job
// this tab owns. keysHash binds the entry to the exact
// content (line + engine settings); a settings change or different line never
// reattaches.
export const BATCH_PERSIST_KEY = 'maia-board.review-batch.v1';
export type PersistedBatch = { jobId: string; lineKey: string; keysHash: string; total: number };

// FNV-1a 32-bit over the ordered cache keys. Order-sensitive on purpose: the
// server echoes per-index errors in submit order, so the same set in a
// different order is a different job.
export function hashBatchKeys(keys: string[]): string {
  let hash = 0x811c9dc5;
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function batchStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readPersistedBatch(): PersistedBatch | null {
  try {
    const raw = batchStorage()?.getItem(BATCH_PERSIST_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    if (typeof parsed.jobId !== 'string' || !parsed.jobId || typeof parsed.lineKey !== 'string'
      || typeof parsed.keysHash !== 'string' || typeof parsed.total !== 'number' || !Number.isInteger(parsed.total)) return null;
    return { jobId: parsed.jobId, lineKey: parsed.lineKey, keysHash: parsed.keysHash, total: parsed.total };
  } catch {
    return null;
  }
}

export function writePersistedBatch(entry: PersistedBatch): void {
  try {
    batchStorage()?.setItem(BATCH_PERSIST_KEY, JSON.stringify(entry));
  } catch {
    // Private-mode/quota failures keep analysis working; reattach just skips.
  }
}

export function clearPersistedBatch(jobId?: string): void {
  try {
    const storage = batchStorage();
    if (!storage) return;
    if (jobId) {
      const current = readPersistedBatch();
      if (!current || current.jobId !== jobId) return;
    }
    storage.removeItem(BATCH_PERSIST_KEY);
  } catch {
    // Clearing is best-effort; a stale entry only costs one status fetch.
  }
}

export class BatchGoneError extends Error {
  constructor() { super('Review batch not found.'); this.name = 'BatchGoneError'; }
}

// 429 backpressure: the server rejects over-cap submits with 429 +
// Retry-After. Header-first parse, clamped to 1..30s, default 5s. Accepts
// numeric seconds or an HTTP date; anything unreadable falls back.
export function parseBatchRetryDelayMs(header: string | null): number {
  const DEFAULT_MS = 5_000;
  if (!header) return DEFAULT_MS;
  const trimmed = header.trim();
  if (!trimmed) return DEFAULT_MS;
  const numeric = Number(trimmed);
  let seconds: number;
  if (Number.isFinite(numeric)) {
    seconds = numeric;
  } else {
    const when = Date.parse(trimmed);
    if (!Number.isFinite(when)) return DEFAULT_MS;
    seconds = (when - Date.now()) / 1000;
  }
  if (!Number.isFinite(seconds)) return DEFAULT_MS;
  return Math.round(Math.min(30, Math.max(1, seconds)) * 1000);
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;
const defaultSleep: SleepLike = ms => new Promise(resolve => setTimeout(resolve, ms));

// One entry per engine per analyzable node, in a stable order the server
// echoes back as per-index errors. Outcome nodes and over-long lines are
// skipped exactly like the foreground scheduler skips them.
export function buildBatchItems(nodes: ReviewNode[], settings: SettingsInput, engines: Engine[] = ['sf', 'maia']): BatchItem[] {
  const items: BatchItem[] = [];
  for (const node of nodes) {
    if (node.outcome || node.ply > 256) continue;
    for (const engine of engines) {
      const resolved = resolveSettings(settings, node);
      items.push({ request: evaluationRequest(engine, node, resolved), key: reviewKey(engine, node, resolved), engine });
    }
  }
  return items;
}

async function readError(response: Response, fallback: string): Promise<MaiaApiError> {
  const body: unknown = await response.json().catch(() => null);
  const record = isRecord(body) ? body : null;
  const code = record ? parseErrorCode(record) : 'unknown';
  const message = record && typeof record.message === 'string' ? record.message : fallback;
  return new MaiaApiError(code, message, response.status);
}

function parseProgress(body: unknown): BatchProgress {
  // Reject, don't default: silently zeroed done/failed/total would paint a
  // confident progress bar over unknown state (the blank-badge lie family).
  // Callers already surface MaiaApiError through the batch error paths.
  if (!isRecord(body) || typeof body.job_id !== 'string'
    || !isNonNegativeInt(body.total) || !isNonNegativeInt(body.done) || !isNonNegativeInt(body.failed)
    || typeof body.finished !== 'boolean' || (body.errors !== undefined && !isStringMap(body.errors))) {
    throw new MaiaApiError('unknown', 'The review server returned unreadable data.');
  }
  return { job_id: body.job_id, total: body.total, done: body.done, failed: body.failed, finished: body.finished,
    ...(body.errors === undefined ? {} : { errors: body.errors }) };
}

function parseSubmitted(body: unknown, status?: number): BatchSubmitted {
  // Same reject-not-default contract as parseProgress: trusted cached/pending
  // totals would misreport batch size instead of failing visibly.
  if (!isRecord(body) || typeof body.job_id !== 'string'
    || !isNonNegativeInt(body.total) || !isNonNegativeInt(body.cached) || !isNonNegativeInt(body.pending)) {
    throw new MaiaApiError('unknown', 'The review server returned unreadable data.', status);
  }
  return { job_id: body.job_id, total: body.total, cached: body.cached, pending: body.pending };
}

export async function submitBatch(items: BatchItem[], fetchImpl: FetchLike = fetch, sleepImpl: SleepLike = defaultSleep): Promise<BatchSubmitted> {
  const postOnce = () => fetchImpl('/reviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: items.map(item => item.request) }),
  }).catch(() => { throw new MaiaApiError('server_unreachable', 'The review server could not be reached.'); });
  const readSuccess = async (response: Response): Promise<BatchSubmitted> => {
    if (!response.ok) throw await readError(response, 'The review server rejected this batch.');
    return parseSubmitted(await response.json().catch(() => null), response.status);
  };
  const first = await postOnce();
  // 429 backpressure sits BEFORE the generic branch: wait once per
  // Retry-After, resubmit once, else surface engine-busy.
  if (first.status === 429) {
    await sleepImpl(parseBatchRetryDelayMs(first.headers?.get('Retry-After') ?? null));
    const second = await postOnce();
    if (second.status === 429) {
      throw new MaiaApiError('engine_busy', 'The review servers are busy. Try again shortly.', 429);
    }
    return readSuccess(second);
  }
  return readSuccess(first);
}

export async function fetchBatchStatus(jobId: string, fetchImpl: FetchLike = fetch): Promise<BatchProgress> {
  const response = await fetchImpl(`/reviews/${jobId}`, { method: 'GET' })
    .catch(() => { throw new MaiaApiError('server_unreachable', 'The review server could not be reached.'); });
  if (response.status === 404) throw new BatchGoneError();
  if (!response.ok) throw await readError(response, 'The review server rejected this batch.');
  return parseProgress(await response.json().catch(() => null));
}

// Streams live progress until the batch finishes, the caller aborts, or the
// stream breaks (the caller then falls back to polling status + bulk
// lookup, which is also the reconnect path). Snapshot-first: the server
// opens with current progress, so gaps self-heal through reconciliation.
export async function subscribeBatchEvents(
  jobId: string, onProgress: (progress: BatchProgress) => void, signal: AbortSignal, fetchImpl: FetchLike = fetch,
): Promise<void> {
  const response = await fetchImpl(`/reviews/${jobId}/events`, { method: 'GET', headers: { Accept: 'text/event-stream' }, signal })
    .catch(error => {
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return null;
      throw new MaiaApiError('server_unreachable', 'The review server could not be reached.');
    });
  if (!response) return;
  if (response.status === 404) throw new BatchGoneError();
  if (!response.ok || !response.body) throw await readError(response, 'The review server rejected this batch.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const handleFrame = (frame: string): boolean => {
    if (frame.startsWith(':')) return false;
    const line = frame.split('\n').find(entry => entry.startsWith('data:'));
    if (!line) return false;
    let envelope: unknown;
    try { envelope = JSON.parse(line.slice(5).trim()); } catch { return false; }
    const record = isRecord(envelope) ? envelope : null;
    if (!record?.progress) return false;
    const progress = parseProgress(record.progress);
    onProgress(progress);
    return progress.finished;
  };
  try {
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        void reader.cancel().catch(() => undefined);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      for (;;) {
        const next = await Promise.race([reader.read(), aborted]);
        buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          if (handleFrame(buffer.slice(0, boundary))) return;
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
        }
        if (next.done) {
          if (buffer.trim()) handleFrame(buffer);
          throw new MaiaApiError('server_unreachable', 'The review stream broke mid-batch.');
        }
      }
    } catch (error) {
      // A caller abort is the normal unsubscribe path, not a failure.
      if (signal.aborted) return;
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already cancelled */ }
  }
}
