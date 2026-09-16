import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTimeline, START_FEN } from './domain';
import { BatchBusyError, BatchGoneError, BATCH_PERSIST_KEY, buildBatchItems, cancelBatch, classifyBusyJob,
  clearPersistedBatch, fetchBatchStatus, hashBatchKeys, readPersistedBatch, submitBatch, subscribeBatchEvents,
  writePersistedBatch, type BatchProgress } from './batchReview';
import { jsonResponse } from './evaluationTestFixtures';
import { reviewNodes } from './evaluationStore';
import type { ReviewSettings } from './evaluationStore';
import { defaultStockfishSettings } from './stockfishSettings';

const settings: ReviewSettings = { eloMaia: 1600, eloUser: 1600, model: '79m', stockfish: defaultStockfishSettings };
const nodes = reviewNodes(buildTimeline(START_FEN, ['e2e4', 'e7e5']));
const items = () => buildBatchItems(nodes, settings);
const progress = (over: Partial<BatchProgress> = {}): BatchProgress =>
  ({ job_id: 'job1', total: 6, done: 0, failed: 0, cancelled: false, finished: false, ...over });

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
  it('surfaces a running batch as BatchBusyError with progress', async () => {
    const running = progress({ done: 3 });
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ code: 'batch_busy', job_id: 'old', progress: running }, 409));
    const error = await submitBatch(items(), fetcher).then(() => null, error => error);
    expect(error).toBeInstanceOf(BatchBusyError);
    expect((error as BatchBusyError).jobId).toBe('old');
    expect((error as BatchBusyError).progress.done).toBe(3);
  });
});

describe('classifyBusyJob', () => {
  const base = { submittedKey: 'lineA', keysHash: 'abc123', total: 6, busyJobId: 'job-busy' };
  const persistedFor = () => ({ jobId: 'job-busy', lineKey: 'lineA', keysHash: 'abc123', total: 6 });
  it('reports already-attached for same content this scope owns', () => {
    expect(classifyBusyJob({ ...base, ownJobId: 'job-busy', cancelledOwnIds: new Set(), persisted: persistedFor() }))
      .toEqual({ kind: 'already-attached' });
  });
  it('attaches for same content owned elsewhere (reload/second tab)', () => {
    expect(classifyBusyJob({ ...base, ownJobId: null, cancelledOwnIds: new Set(), persisted: persistedFor() }))
      .toEqual({ kind: 'attach' });
  });
  it('resubmits for different content against our own running job', () => {
    expect(classifyBusyJob({ ...base, ownJobId: 'job-busy', cancelledOwnIds: new Set(), persisted: null }))
      .toEqual({ kind: 'self-resubmit' });
  });
  it('resubmits when the busy id is a tombstoned just-cancelled own id', () => {
    expect(classifyBusyJob({ ...base, ownJobId: null, cancelledOwnIds: new Set(['job-busy']), persisted: null }))
      .toEqual({ kind: 'self-resubmit' });
  });
  it('waits for foreign jobs and content mismatches', () => {
    const foreign = { ...base, ownJobId: null, cancelledOwnIds: new Set<string>(), persisted: null };
    expect(classifyBusyJob(foreign)).toEqual({ kind: 'foreign-wait' });
    // Same job id but a different line / hash / total is not same content.
    expect(classifyBusyJob({ ...foreign, submittedKey: 'lineB', persisted: persistedFor() })).toEqual({ kind: 'foreign-wait' });
    expect(classifyBusyJob({ ...foreign, persisted: { ...persistedFor(), keysHash: 'other' } })).toEqual({ kind: 'foreign-wait' });
    expect(classifyBusyJob({ ...foreign, persisted: { ...persistedFor(), total: 4 } })).toEqual({ kind: 'foreign-wait' });
    // An unrelated tombstone does not claim the foreign job.
    expect(classifyBusyJob({ ...foreign, cancelledOwnIds: new Set(['job-old']) })).toEqual({ kind: 'foreign-wait' });
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

describe('cancelBatch', () => {
  it('deletes and treats unknown ids as already gone', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await cancelBatch('job1', fetcher);
    expect(fetcher.mock.calls[0][0]).toBe('/reviews/job1');
    const gone = vi.fn<typeof fetch>(async () => jsonResponse({}, 404));
    await cancelBatch('nope', gone);
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
