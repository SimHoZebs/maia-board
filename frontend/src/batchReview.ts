import { MaiaApiError } from './api';
import { evaluationRequest, resolveSettings, reviewKey, type Engine, type ReviewNode, type SettingsInput } from './evaluationStore';

export type BatchItem = { request: ReturnType<typeof evaluationRequest>; key: string; engine: Engine };
export type BatchProgress = {
  job_id: string; total: number; done: number; failed: number;
  cancelled: boolean; finished: boolean; errors?: Record<string, string>;
};
export type BatchSubmitted = { job_id: string; total: number; cached: number; pending: number };

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
