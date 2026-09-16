import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTimeline, START_FEN } from './domain';
import { BatchGoneError, BATCH_PERSIST_KEY, buildBatchItems,
  clearPersistedBatch, fetchBatchStatus, hashBatchKeys, parseBatchRetryDelayMs, readPersistedBatch, submitBatch, subscribeBatchEvents,
  writePersistedBatch, type BatchProgress } from './batchReview';
import { MaiaApiError } from './api';
import { jsonResponse } from './evaluationTestFixtures';
import { reviewNodes } from './evaluationStore';
import type { ReviewSettings } from './evaluationStore';
import { defaultStockfishSettings } from './stockfishSettings';

const settings: ReviewSettings = { eloMaia: 1600, eloUser: 1600, model: '79m', stockfish: defaultStockfishSettings };
const nodes = reviewNodes(buildTimeline(START_FEN, ['e2e4', 'e7e5']));
const items = () => buildBatchItems(nodes, settings);
const progress = (over: Partial<BatchProgress> = {}): BatchProgress =>
  ({ job_id: 'job1', total: 6, done: 0, failed: 0, finished: false, ...over });
const response429 = (retryAfter: string | null, body: unknown = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (retryAfter !== null) headers['Retry-After'] = retryAfter;
  return new Response(JSON.stringify(body), { status: 429, headers });
};

describe('buildBatchItems', () => {
  it('emits sf+maia per node in stable order with matching cache keys', () => {
    const built = items();
    expect(built).toHaveLength(6);
    expect(built.map(item => item.engine)).toEqual(['sf', 'maia', 'sf', 'maia', 'sf', 'maia']);
    expect(built[0].request).toMatchObject({ engine: 'sf', fen: nodes[0].fen, initial_fen: START_FEN });
    expect(built[1].request).toMatchObject({ engine: 'maia', fen: nodes[0].fen });
    expect(new Set(built.map(item => item.key)).size).toBe(6);
  });
});

describe('submitBatch', () => {
  it('posts lookup-shaped requests and returns the job', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ job_id: 'job1', total: 6, cached: 2, pending: 4 }, 202));
    const submitted = await submitBatch(items(), fetcher);
    expect(submitted).toMatchObject({ job_id: 'job1', total: 6 });
    expect(fetcher.mock.calls[0][0]).toBe('/reviews');
    const body = JSON.parse(fetcher.mock.calls[0][1]!.body as string);
    expect(body.requests).toHaveLength(6);
    expect(body.requests[0]).toMatchObject({ engine: 'sf', moves: [], initial_fen: START_FEN });
  });
});

describe('parseBatchRetryDelayMs', () => {
  it('parses numeric headers, clamps to 1..30s, defaults to 5s', () => {
    expect(parseBatchRetryDelayMs('5')).toBe(5_000);
    expect(parseBatchRetryDelayMs('1')).toBe(1_000);
    expect(parseBatchRetryDelayMs('0')).toBe(1_000);
    expect(parseBatchRetryDelayMs('-3')).toBe(1_000);
    expect(parseBatchRetryDelayMs('60')).toBe(30_000);
    expect(parseBatchRetryDelayMs(null)).toBe(5_000);
    expect(parseBatchRetryDelayMs('')).toBe(5_000);
    expect(parseBatchRetryDelayMs('not-a-date')).toBe(5_000);
  });
});

describe('submitBatch 429 backpressure', () => {
  it('waits per Retry-After once then resubmits once (header-first)', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (fetcher.mock.calls.length === 1) return response429('2');
      return jsonResponse({ job_id: 'job1', total: 6, cached: 0, pending: 6 }, 202);
    });
    const submitted = await submitBatch(items(), fetcher, sleep);
    expect(submitted).toMatchObject({ job_id: 'job1' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2_000);
    // Cancel-free: every attempt is a POST, never a DELETE.
    for (const [, init] of fetcher.mock.calls) expect(init?.method).toBe('POST');
  });
  it('resubmits only once then surfaces engine-busy', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi.fn<typeof fetch>(async () => response429('1'));
    const error = await submitBatch(items(), fetcher, sleep).then(() => null, error => error);
    expect(error).toBeInstanceOf(MaiaApiError);
    expect((error as MaiaApiError).code).toBe('engine_busy');
    expect((error as MaiaApiError).status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1_000);
    for (const [, init] of fetcher.mock.calls) expect(init?.method).toBe('POST');
  });
  it('defaults to 5s when Retry-After is missing or unreadable', async () => {
    for (const header of [null, 'garbage'] as const) {
      const sleep = vi.fn(async () => undefined);
      const fetcher = vi.fn<typeof fetch>(async () => response429(header));
      await submitBatch(items(), fetcher, sleep).then(() => null, error => error);
      expect(sleep).toHaveBeenCalledWith(5_000);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it('clamps extreme Retry-After values', async () => {
    const sleep = vi.fn(async () => undefined);
    const fetcher = vi.fn<typeof fetch>(async () => response429('120'));
    await submitBatch(items(), fetcher, sleep).then(() => null, error => error);
    expect(sleep).toHaveBeenCalledWith(30_000);
  });
});

describe('429 skew into the old generic path', () => {
  it('handles a 429 in generic status reads without crashing', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response429(null, { code: 'busy', message: 'slow down' }));
    const error = await fetchBatchStatus('job1', fetcher).then(() => null, error => error);
    expect(error).toBeInstanceOf(MaiaApiError);
    expect((error as MaiaApiError).message).toBe('slow down');
    expect((error as MaiaApiError).status).toBe(429);
  });
});

describe('cancel-free client', () => {
  it('exposes no cancel/busy helpers and never issues DELETE', async () => {
    const mod = (await import('./batchReview')) as Record<string, unknown>;
    expect(mod).not.toHaveProperty('cancelBatch');
    expect(mod).not.toHaveProperty('BatchBusyError');
    expect(mod).not.toHaveProperty('classifyBusyJob');
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (url === '/reviews') return jsonResponse({ job_id: 'job1', total: 6, cached: 0, pending: 6 }, 202);
      return jsonResponse(progress({ done: 6, finished: true }));
    });
    await submitBatch(items(), fetcher, async () => undefined);
    await fetchBatchStatus('job1', fetcher);
    expect(fetcher.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetcher.mock.calls) expect(init?.method).not.toBe('DELETE');
  });
});

describe('fetchBatchStatus', () => {
  it('returns progress and maps 404 to BatchGoneError', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse(progress({ done: 6, finished: true })));
    expect((await fetchBatchStatus('job1', fetcher)).finished).toBe(true);
    const gone = vi.fn<typeof fetch>(async () => jsonResponse({}, 404));
    await expect(fetchBatchStatus('nope', gone)).rejects.toBeInstanceOf(BatchGoneError);
  });
});

describe('subscribeBatchEvents', () => {
  const stream = (chunks: string[]) => {
    const encoded = chunks.map(chunk => new TextEncoder().encode(chunk));
    return new Response(new ReadableStream({ start(controller) { for (const part of encoded) controller.enqueue(part); controller.close(); } }));
  };
  it('delivers progress frames and resolves on finished', async () => {
    const body = `:ping\n\nid: 1\nevent: progress\ndata: ${JSON.stringify({ id: 1, progress: progress({ done: 2 }) })}\n\n`
      + `id: 2\nevent: progress\ndata: ${JSON.stringify({ id: 2, progress: progress({ done: 6, finished: true }) })}\n\n`;
    // Split mid-frame to prove chunk-boundary parsing.
    const fetcher = vi.fn<typeof fetch>(async () => stream([body.slice(0, 40), body.slice(40)]));
    const seen: BatchProgress[] = [];
    await subscribeBatchEvents('job1', update => { seen.push(update); }, new AbortController().signal, fetcher);
    expect(seen.map(update => update.done)).toEqual([2, 6]);
    expect(fetcher.mock.calls[0][1]!.headers).toMatchObject({ Accept: 'text/event-stream' });
  });
  it('maps unknown jobs and stops on abort', async () => {
    const gone = vi.fn<typeof fetch>(async () => jsonResponse({}, 404));
    await expect(subscribeBatchEvents('nope', () => undefined, new AbortController().signal, gone)).rejects.toBeInstanceOf(BatchGoneError);
    const controller = new AbortController();
    const hanging = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start() {} })));
    controller.abort();
    await subscribeBatchEvents('job1', () => undefined, controller.signal, hanging);
  });
});

describe('batch persistence', () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => { data.delete(key); },
    });
  });
  it('hashes keys deterministically and order-sensitively', () => {
    expect(hashBatchKeys(['a', 'b'])).toBe(hashBatchKeys(['a', 'b']));
    expect(hashBatchKeys(['a', 'b'])).not.toBe(hashBatchKeys(['b', 'a']));
    expect(hashBatchKeys(['a'])).not.toBe(hashBatchKeys(['a', 'b']));
  });
  it('round-trips a persisted batch and clears by job id', () => {
    expect(readPersistedBatch()).toBeNull();
    writePersistedBatch({ jobId: 'job1', lineKey: 'lineA', keysHash: 'abc123', total: 6 });
    expect(readPersistedBatch()).toEqual({ jobId: 'job1', lineKey: 'lineA', keysHash: 'abc123', total: 6 });
    clearPersistedBatch('other');
    expect(readPersistedBatch()?.jobId).toBe('job1');
    clearPersistedBatch('job1');
    expect(readPersistedBatch()).toBeNull();
  });
  it('rejects corrupt entries and binds reattach to exact content', () => {
    localStorage.setItem(BATCH_PERSIST_KEY, '{not-json');
    expect(readPersistedBatch()).toBeNull();
    localStorage.setItem(BATCH_PERSIST_KEY, JSON.stringify({ jobId: '', lineKey: 'x', keysHash: 'y', total: 1 }));
    expect(readPersistedBatch()).toBeNull();
    const keys = items().map(item => item.key);
    const hash = hashBatchKeys(keys);
    writePersistedBatch({ jobId: 'job1', lineKey: 'lineA', keysHash: hash, total: keys.length });
    const stored = readPersistedBatch()!;
    // Same line but different settings produce different keys: no reattach.
    const other = buildBatchItems(nodes, { ...settings, eloMaia: 2000 });
    expect(hashBatchKeys(other.map(item => item.key))).not.toBe(stored.keysHash);
  });
});
