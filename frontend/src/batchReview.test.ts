import { describe, expect, it, vi } from 'vitest';
import { buildTimeline, START_FEN } from './domain';
import { BatchBusyError, BatchGoneError, buildBatchItems, cancelBatch, fetchBatchStatus, submitBatch, subscribeBatchEvents, type BatchProgress } from './batchReview';
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
