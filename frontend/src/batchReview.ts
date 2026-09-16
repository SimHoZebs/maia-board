import { MaiaApiError } from './api';
import { evaluationRequest, resolveSettings, reviewKey, type Engine, type ReviewNode, type SettingsInput } from './evaluationStore';

export type BatchItem = { request: ReturnType<typeof evaluationRequest>; key: string; engine: Engine };
export type BatchProgress = {
  job_id: string; total: number; done: number; failed: number;
  cancelled: boolean; finished: boolean; errors?: Record<string, string>;
};
export type BatchSubmitted = { job_id: string; total: number; cached: number; pending: number };

// Persisted batch identity: lets a reloaded tab reattach to its own running
// job instead of showing Analyze again and submitting a duplicate (which the
// single-active server would treat as a replacement, discarding progress).
// Single entry is enough: the server runs at most one batch at a time, so the
// latest submit is the active job. keysHash binds the entry to the exact
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
    const storage = (globalThis as { localStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }).localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

export function readPersistedBatch(): PersistedBatch | null {
  try {
    const raw = batchStorage()?.getItem(BATCH_PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedBatch>;
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

export class BatchBusyError extends Error {
  readonly jobId: string;
  readonly progress: BatchProgress;
  constructor(jobId: string, progress: BatchProgress) {
    super('Another review batch is running.');
    this.name = 'BatchBusyError';
    this.jobId = jobId;
    this.progress = progress;
  }
}

export class BatchGoneError extends Error {
  constructor() { super('Review batch not found.'); this.name = 'BatchGoneError'; }
}

// Busy-path ownership: the single-active server 409s every concurrent
// submit, so the hook must tell its own dying job (line-change DELETE still
// in flight) from a foreign tab's live job. Self keeps cancel + resubmit;
// foreign waits politely and never cancels.
export const FOREIGN_BATCH_WAIT_MS = 30_000;
export const FOREIGN_BATCH_POLL_MS = 2_000;

export type BusyJobDecision =
  | { kind: 'already-attached' }
  | { kind: 'attach' }
  | { kind: 'self-resubmit' }
  | { kind: 'foreign-wait' };

export function classifyBusyJob(args: {
  busyJobId: string;
  submittedKey: string;
  keysHash: string;
  total: number;
  ownJobId: string | null;
  cancelledOwnIds: ReadonlySet<string>;
  persisted: PersistedBatch | null;
}): BusyJobDecision {
  const { busyJobId, submittedKey, keysHash, total, ownJobId, cancelledOwnIds, persisted } = args;
  const sameContent = !!persisted && persisted.jobId === busyJobId && persisted.lineKey === submittedKey
    && persisted.keysHash === keysHash && persisted.total === total;
  if (sameContent && ownJobId === busyJobId) return { kind: 'already-attached' };
  if (sameContent) return { kind: 'attach' };
  if (ownJobId === busyJobId) return { kind: 'self-resubmit' };
  if (cancelledOwnIds.has(busyJobId)) return { kind: 'self-resubmit' };
  return { kind: 'foreign-wait' };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const code = typeof record?.code === 'string' ? record.code : 'unknown';
  const message = typeof record?.message === 'string' ? record.message : fallback;
  return new MaiaApiError(code as MaiaApiError['code'], message, response.status);
}

function parseProgress(body: unknown): BatchProgress {
  const value = body as BatchProgress;
  if (!value || typeof value !== 'object' || typeof value.job_id !== 'string' || !Number.isInteger(value.total)) {
    throw new MaiaApiError('unknown', 'The review server returned unreadable data.');
  }
  return value;
}

export async function submitBatch(items: BatchItem[], fetchImpl: FetchLike = fetch): Promise<BatchSubmitted> {
  const response = await fetchImpl('/reviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: items.map(item => item.request) }),
  }).catch(() => { throw new MaiaApiError('server_unreachable', 'The review server could not be reached.'); });
  if (response.status === 409) {
    const body: unknown = await response.json().catch(() => null);
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    const jobId = typeof record?.job_id === 'string' ? record.job_id : '';
    if (!jobId || !record?.progress) throw new MaiaApiError('batch_busy', 'A full-game review is already running.');
    return Promise.reject(new BatchBusyError(jobId, parseProgress(record.progress)));
  }
  if (!response.ok) throw await readError(response, 'The review server rejected this batch.');
  const body: unknown = await response.json().catch(() => null);
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  if (typeof record?.job_id !== 'string' || !Number.isInteger(record?.total)) {
    throw new MaiaApiError('unknown', 'The review server returned unreadable data.', response.status);
  }
  return body as BatchSubmitted;
}

export async function fetchBatchStatus(jobId: string, fetchImpl: FetchLike = fetch): Promise<BatchProgress> {
  const response = await fetchImpl(`/reviews/${jobId}`, { method: 'GET' })
    .catch(() => { throw new MaiaApiError('server_unreachable', 'The review server could not be reached.'); });
  if (response.status === 404) throw new BatchGoneError();
  if (!response.ok) throw await readError(response, 'The review server rejected this batch.');
  return parseProgress(await response.json().catch(() => null));
}

export async function cancelBatch(jobId: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const response = await fetchImpl(`/reviews/${jobId}`, { method: 'DELETE' })
    .catch(() => { throw new MaiaApiError('server_unreachable', 'The review server could not be reached.'); });
  // Unknown ids are already gone, which is the desired end state.
  if (response.status !== 404 && !response.ok) throw await readError(response, 'The review server rejected this batch.');
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
    const record = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : null;
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
