import { expect, it, vi } from 'vitest';
import { loadLine } from './domain';
import { ReviewCoordinator, reviewKey, type ReviewNode } from './reviewCoordinator';
import { SEARCH_POLICY } from './reviewMetrics';
const settings = { eloMaia: 1600, eloUser: 1600, model: '79m' as const };
const line = loadLine('', '1. e4 e5 2. Nf3');
const nodes: ReviewNode[] = line.timeline.map(position => ({ ...position, initialFen: line.initialFen }));
const body = (url: string) => url === '/evaluate' ? { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'e2e4', score: { type: 'cp', value: 0 }, lines: [] } : { move: 'e2e4', top_moves: [], wdl: [0,1,0], model_used: '79m', degraded: false };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
it('deduplicates in-flight requests and coalesces stale foreground positions', async () => {
  const releases: (() => void)[] = [];
  const requests: string[] = [];
  const fetcher = vi.fn(async (url, init) => { requests.push(`${url}:${JSON.parse(init!.body as string).moves.length}`); await new Promise<void>(resolve => releases.push(resolve)); return Response.json(body(String(url))); }) as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  coordinator.foregroundAt([nodes[0]], settings); coordinator.foregroundAt([nodes[0]], settings);
  expect(requests).toHaveLength(2);
  coordinator.foregroundAt([nodes[1]], settings); coordinator.foregroundAt([nodes[3], nodes[2]], settings);
  releases.splice(0).forEach(resolve => resolve()); await flush();
  expect(requests).toEqual(['/evaluate:0', '/move:0', '/evaluate:3', '/move:3']);
  expect(coordinator.result('sf', nodes[3], settings)).toBeUndefined();
  releases.splice(0).forEach(resolve => resolve()); await flush();
  expect(requests.at(-1)).toBe('/evaluate:2');
  coordinator.suspend(); releases.splice(0).forEach(resolve => resolve()); await flush();
});
it('keys include full history, initial position, ratings and model', () => {
  expect(reviewKey('maia', nodes[0], settings)).not.toBe(reviewKey('maia', nodes[0], { ...settings, eloMaia: 1700 }));
  expect(reviewKey('sf', nodes[0], settings)).toBe(reviewKey('sf', nodes[0], { ...settings, eloMaia: 1700 }));
  expect(reviewKey('sf', nodes[0], settings)).not.toBe(reviewKey('sf', nodes[1], settings));
});
it('runs a lazy batch to completion and keeps successful results after cancellation', async () => {
  const fetcher = vi.fn(async url => Response.json(body(String(url)))) as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  coordinator.startBatch(nodes, settings); await flush(); await flush();
  expect(coordinator.progress).toMatchObject({ done: 8, total: 8, running: false });
  coordinator.cancelBatch(); expect(coordinator.result('sf', nodes[2], settings)?.depth).toBe(12);
});
it('synthesizes terminal draws from full history and never asks Maia', async () => {
  const terminal = loadLine('', '1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8');
  const node = { ...terminal.timeline.at(-1)!, initialFen: terminal.initialFen };
  const fetcher = vi.fn() as unknown as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  coordinator.foregroundAt([node], settings); coordinator.startBatch([node], settings); await flush();
  expect(fetcher).not.toHaveBeenCalled(); expect(coordinator.result('sf', node, settings)?.terminal).toBe('draw');
});
it('bounds busy retries and requires explicit retry after failure', async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn(async () => Response.json({ message: 'Busy' }, { status: 503, headers: { 'Retry-After': '1' } })) as typeof fetch;
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.foregroundAt([nodes[0]], settings); await vi.runAllTimersAsync(); await flush();
    expect(fetcher).toHaveBeenCalledTimes(6);
    coordinator.foregroundAt([nodes[0]], settings); await flush(); expect(fetcher).toHaveBeenCalledTimes(6);
    expect(coordinator.error('sf', nodes[0], settings)).toBe('Busy'); coordinator.suspend();
  } finally { vi.useRealTimers(); }
});
it('prioritizes interactive navigation over the next batch node and cancels the remaining snapshot', async () => {
  const requests: string[] = [], releases: (() => void)[] = [];
  const fetcher = vi.fn(async (url, init) => { requests.push(`${url}:${JSON.parse(init!.body as string).moves.length}`); await new Promise<void>(resolve => releases.push(resolve)); return Response.json(body(String(url))); }) as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  coordinator.startBatch(nodes, settings); expect(requests).toEqual(['/evaluate:0', '/move:0']);
  coordinator.foregroundAt([nodes[3], nodes[2]], settings);
  releases.splice(0).forEach(resolve => resolve()); await flush();
  expect(requests.slice(2)).toEqual(['/evaluate:3', '/move:3']);
  coordinator.cancelBatch(); coordinator.clearForeground();
  releases.splice(0).forEach(resolve => resolve()); await flush();
  expect(requests).toHaveLength(4); expect(coordinator.progress?.canceled).toBe(true);
  expect(coordinator.result('sf', nodes[0], settings)).toBeDefined();
});
it('never exposes old rating results under a new key and expires fallback responses', async () => {
  const fetcher = vi.fn(async url => Response.json({ ...body(String(url)), degraded: true })) as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  coordinator.foregroundAt([nodes[0]], settings); await flush();
  expect(coordinator.result('maia', nodes[0], { ...settings, eloMaia: 2000 })).toBeUndefined();
  expect(coordinator.result('maia', nodes[0], settings)).toBeDefined();
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 30_001);
  expect(coordinator.result('maia', nodes[0], settings)).toBeUndefined();
  expect(coordinator.result('sf', nodes[0], settings)).toBeDefined(); clock.mockRestore();
});
