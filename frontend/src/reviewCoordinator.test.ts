import { describe, expect, it, vi } from 'vitest';
import { loadLine } from './domain';
import { cacheHash, JOB_STALL_MS, RESUME_ABORT_AFTER_HIDDEN_MS, ReviewCoordinator, reviewKey, type ReviewNode } from './reviewCoordinator';
import { SEARCH_POLICY } from './reviewMetrics';
import { stockfishPolicy } from './stockfishSettings';
const settings = { eloMaia: 1600, eloUser: 1600, model: '79m' as const };
const line = loadLine('', '1. e4 e5 2. Nf3');
const nodes: ReviewNode[] = line.timeline.map(position => ({ ...position, initialFen: line.initialFen }));
const body = (url: string) => url === '/evaluate' ? { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'e2e4', score: { type: 'cp', value: 0 }, lines: [{ move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: -20 }, depth: 12 }] } : { move: 'e2e4', top_moves: [], wdl: [0,1,0], model_used: '79m', degraded: false };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
it('deduplicates in-flight requests and coalesces stale foreground positions', async () => {
  const releases: (() => void)[] = [];
  const requests: string[] = [];
  const fetcher = vi.fn(async (url, init) => {
    if (!init?.body) return Response.json({ code: 'not_found', message: 'missing' }, { status: 404 });
    requests.push(`${url}:${JSON.parse(init.body as string).moves.length}`);
    await new Promise<void>(resolve => releases.push(resolve));
    return Response.json(body(String(url)));
  }) as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  coordinator.foregroundAt([nodes[0]], settings); coordinator.foregroundAt([nodes[0]], settings);
  await flush();
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
it('runs a lazy batch to completion and keeps successful results', async () => {
  const fetcher = vi.fn(async url => Response.json(body(String(url)))) as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  // Three cycles: the cache-probe timeout race costs extra microtask hops.
  coordinator.startBatch(nodes, settings); await flush(); await flush(); await flush();
  expect(coordinator.progress).toMatchObject({ done: 8, total: 8, running: false });
  expect(coordinator.result('sf', nodes[2], settings)?.depth).toBe(12);
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
    // One server-cache probe plus three live attempts per engine lane.
    expect(fetcher).toHaveBeenCalledTimes(8);
    coordinator.foregroundAt([nodes[0]], settings); await flush(); expect(fetcher).toHaveBeenCalledTimes(8);
    expect(coordinator.error('sf', nodes[0], settings)).toBe('Busy'); coordinator.suspend();
  } finally { vi.useRealTimers(); }
});
it('prioritizes interactive navigation over the next batch node and suspends the remaining snapshot', async () => {
  const requests: string[] = [], releases: (() => void)[] = [];
  const fetcher = vi.fn(async (url, init) => {
    if (!init?.body) return Response.json({ code: 'not_found', message: 'missing' }, { status: 404 });
    requests.push(`${url}:${JSON.parse(init.body as string).moves.length}`);
    await new Promise<void>(resolve => releases.push(resolve));
    return Response.json(body(String(url)));
  }) as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  coordinator.startBatch(nodes, settings); await flush(); expect(requests).toEqual(['/evaluate:0', '/move:0']);
  coordinator.foregroundAt([nodes[3], nodes[2]], settings);
  releases.splice(0).forEach(resolve => resolve()); await flush();
  expect(requests.slice(2)).toEqual(['/evaluate:3', '/move:3']);
  coordinator.suspend();
  releases.splice(0).forEach(resolve => resolve()); await flush();
  expect(requests).toHaveLength(4); expect(coordinator.progress).toBeNull();
  // The interrupted batch node was preempted, not completed: its partial work
  // is discarded while the navigated-to position keeps its results.
  expect(coordinator.result('sf', nodes[0], settings)).toBeUndefined();
  expect(coordinator.result('sf', nodes[3], settings)).toBeDefined();
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
it('hashes cache keys deterministically to short hex', () => {
  expect(cacheHash('a')).toBe(cacheHash('a'));
  expect(cacheHash('a')).toMatch(/^[0-9a-f]{16}$/);
  expect(cacheHash('a')).not.toBe(cacheHash('b'));
});
it('serves repeated positions from the server cache without re-inference', async () => {
  const seen: string[] = [];
  const stored = new Map<string, { engine: string; value: unknown }>();
  const evaluation = { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'e2e4', score: { type: 'cp', value: 0 }, lines: [{ move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: -20 }, depth: 12 }] };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    seen.push(`${String(url).split('?')[0]}:${init?.method ?? 'GET'}`);
    if (String(url).startsWith('/evaluations/')) {
      if (init?.method === 'PUT') {
        const put = JSON.parse(init.body as string);
        stored.set(String(url).split('/').pop()!, { engine: put.engine, value: put.value });
        return Response.json({ key_hash: 'x', engine: put.engine, created_at: 'now' });
      }
      const hit = stored.get(String(url).split('/').pop()!);
      if (hit) return Response.json({ key_hash: 'x', engine: hit.engine, value: hit.value, created_at: 'now' });
      return Response.json({ code: 'not_found', message: 'missing' }, { status: 404 });
    }
    return Response.json(body(String(url)));
  }) as unknown as typeof fetch;
  const live = (calls: string[]) => calls.filter(call => call === '/move:POST' || call === '/evaluate:POST');
  const first = new ReviewCoordinator(fetcher);
  first.foregroundAt([nodes[0]], settings); await flush();
  expect(first.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
  expect(first.result('maia', nodes[0], settings)).toMatchObject({ move: 'e2e4' });
  expect(stored.size).toBe(2);
  expect(live(seen)).toHaveLength(2);
  seen.length = 0;
  const second = new ReviewCoordinator(fetcher);
  second.foregroundAt([nodes[0]], settings); await flush();
  expect(second.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
  expect(second.result('maia', nodes[0], settings)).toMatchObject({ move: 'e2e4' });
  expect(live(seen)).toEqual([]);
  expect(seen.filter(call => call.endsWith(':GET')).length).toBeGreaterThan(0);
});
it('ignores corrupt cached rows and never persists fallback answers', async () => {
  const puts: string[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('/evaluations/')) {
      if (init?.method === 'PUT') { puts.push(String(url)); return Response.json({}); }
      return Response.json({ key_hash: 'x', engine: 'sf', value: { nope: true }, created_at: 'now' });
    }
    return Response.json({ ...body(String(url)), degraded: true });
  }) as unknown as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  coordinator.foregroundAt([nodes[0]], settings); await flush();
  expect(coordinator.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
  expect(puts).toHaveLength(1);
});
describe('preemption', () => {
  const sfBody = {
    engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'e2e4',
    score: { type: 'cp', value: 0 },
    lines: [{ move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: -20 }, depth: 12 }],
  };
  const maiaBody = { move: 'e2e4', top_moves: [], wdl: [0, 1, 0], model_used: '79m', degraded: false };
  type Gate = { resolve: (response: Response) => void; reject: (error: unknown) => void; signal: AbortSignal | null | undefined };
  function deferredFetcher() {
    const calls: { url: string; signal: AbortSignal | null | undefined }[] = [];
    const gates = new Map<string, Gate>();
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      const signal = init?.signal ?? null;
      calls.push({ url: path, signal });
      if (path.startsWith('/evaluations/')) {
        if (init?.method === 'PUT') return Response.json({ key_hash: 'x', engine: 'x', created_at: 'now' });
        return Response.json({ code: 'not_found', message: 'missing' }, { status: 404 });
      }
      return new Promise<Response>((resolve, reject) => {
        gates.set(path, { resolve, reject, signal });
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }) as unknown as typeof fetch;
    return { fetcher, calls, gates };
  }
  async function settle(url: '/evaluate' | '/move', helpers: ReturnType<typeof deferredFetcher>) {
    const gate = helpers.gates.get(url);
    expect(gate, `no hanging ${url} call`).toBeDefined();
    helpers.gates.delete(url);
    gate!.resolve(Response.json(url === '/evaluate' ? sfBody : maiaBody));
    await flush();
  }
  it('preempts stale in-flight batch work when navigating', async () => {
    const helpers = deferredFetcher();
    const coordinator = new ReviewCoordinator(helpers.fetcher);
    coordinator.startBatch(nodes, settings);
    await flush();
    const running = helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move');
    expect(running).toHaveLength(2);
    coordinator.foregroundAt([nodes[3]], settings);
    expect(running.every(call => call.signal?.aborted)).toBe(true);
    await flush();
    expect(helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move')).toHaveLength(4);
    await settle('/evaluate', helpers);
    await settle('/move', helpers);
    expect(coordinator.result('sf', nodes[3], settings)).toMatchObject({ depth: 12 });
    expect(coordinator.result('maia', nodes[3], settings)).toMatchObject({ move: 'e2e4' });
    expect(coordinator.error('sf', nodes[0], settings)).toBeUndefined();
  });
  it('drops results that resolve after abort instead of caching them', async () => {
    const helpers = deferredFetcher();
    const coordinator = new ReviewCoordinator(helpers.fetcher);
    coordinator.startBatch(nodes, settings);
    await flush();
    // The fetch resolves, but navigation aborts the lane before the
    // coordinator processes the response: nothing may be cached or failed.
    helpers.gates.get('/evaluate')!.resolve(Response.json(sfBody));
    coordinator.foregroundAt([nodes[3]], settings);
    await flush();
    expect(coordinator.result('sf', nodes[0], settings)).toBeUndefined();
    expect(coordinator.error('sf', nodes[0], settings)).toBeUndefined();
  });
  it('retries aborted batch nodes so progress still completes', async () => {
    const helpers = deferredFetcher();
    const coordinator = new ReviewCoordinator(helpers.fetcher);
    coordinator.startBatch(nodes, settings);
    await flush();
    coordinator.foregroundAt([nodes[3]], settings);
    await flush();
    await settle('/evaluate', helpers);
    await settle('/move', helpers);
    // Drain the rest of the batch: aborted and pending nodes replay in order.
    for (let i = 0; i < 12 && coordinator.progress?.running; i++) {
      await settle('/evaluate', helpers).catch(() => undefined);
      await settle('/move', helpers).catch(() => undefined);
    }
    expect(coordinator.progress).toMatchObject({ running: false, failed: 0 });
    expect(coordinator.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
    expect(coordinator.result('maia', nodes[1], settings)).toMatchObject({ move: 'e2e4' });
  });
  it('leaves running jobs alone when the foreground needs nothing', async () => {
    const helpers = deferredFetcher();
    const coordinator = new ReviewCoordinator(helpers.fetcher);
    coordinator.startBatch(nodes, settings);
    await flush();
    const running = helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move');
    expect(running).toHaveLength(2);
    // Same node as the in-flight jobs: nothing new to run, no abort.
    coordinator.foregroundAt([nodes[0]], settings);
    expect(running.every(call => !call.signal?.aborted)).toBe(true);
    await settle('/evaluate', helpers);
    await settle('/move', helpers);
    expect(coordinator.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
    // Navigating back to the finished node must not disturb running batch jobs.
    coordinator.foregroundAt([nodes[0]], settings);
    const resumed = helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move');
    expect(resumed).toHaveLength(4);
    expect(resumed.every(call => !call.signal?.aborted)).toBe(true);
  });
  it('retries wedged lanes when the user retries instead of leaving Retry dead', async () => {
    const helpers = deferredFetcher();
    const coordinator = new ReviewCoordinator(helpers.fetcher);
    coordinator.startBatch(nodes, settings);
    await flush();
    const running = helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move');
    expect(running).toHaveLength(2);
    // The sockets died without settling: no failure is recorded, so without
    // an abort the lanes would stay occupied and the pumps would no-op.
    coordinator.retry();
    expect(running.every(call => call.signal?.aborted)).toBe(true);
    await flush();
    // Aborted jobs are neither failures nor completions: they re-issue from
    // the reset cursor.
    expect(coordinator.progress?.failed ?? 0).toBe(0);
    expect(helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move')).toHaveLength(4);
    for (let i = 0; i < 12 && coordinator.progress?.running; i++) {
      await settle('/evaluate', helpers).catch(() => undefined);
      await settle('/move', helpers).catch(() => undefined);
    }
    expect(coordinator.progress).toMatchObject({ running: false, failed: 0 });
    expect(coordinator.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
  });
  it('re-issues jobs that straddled backgrounding and leaves healthy jobs alone', async () => {
    const helpers = deferredFetcher();
    const coordinator = new ReviewCoordinator(helpers.fetcher);
    coordinator.startBatch(nodes, settings);
    await flush();
    const running = helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move');
    expect(running).toHaveLength(2);
    coordinator.resume(0);
    expect(running.every(call => !call.signal?.aborted)).toBe(true);
    expect(helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move')).toHaveLength(2);
    coordinator.resume(RESUME_ABORT_AFTER_HIDDEN_MS + 1);
    expect(running.every(call => call.signal?.aborted)).toBe(true);
    await flush();
    expect(helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move')).toHaveLength(4);
    for (let i = 0; i < 12 && coordinator.progress?.running; i++) {
      await settle('/evaluate', helpers).catch(() => undefined);
      await settle('/move', helpers).catch(() => undefined);
    }
    expect(coordinator.progress).toMatchObject({ running: false, failed: 0 });
  });
  it('re-issues jobs that outlived the stall budget even without backgrounding', async () => {
    const helpers = deferredFetcher();
    const coordinator = new ReviewCoordinator(helpers.fetcher);
    coordinator.startBatch(nodes, settings);
    await flush();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + JOB_STALL_MS + 1);
    try {
      coordinator.resume(0);
    } finally {
      clock.mockRestore();
    }
    const running = helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move');
    expect(running.every(call => call.signal?.aborted)).toBe(true);
    await flush();
    expect(helpers.calls.filter(call => call.url === '/evaluate' || call.url === '/move')).toHaveLength(4);
  });
});
it('flags batches with degraded Maia answers and clears the flag on retry', async () => {
  const degraded = vi.fn(async url => Response.json({ ...body(String(url)), degraded: true })) as typeof fetch;
  const coordinator = new ReviewCoordinator(degraded);
  coordinator.startBatch(nodes, settings); await flush(); await flush(); await flush();
  expect(coordinator.progress).toMatchObject({ running: false });
  expect(coordinator.batchDegraded()).toBe(true);
  coordinator.retry();
  await flush(); await flush(); await flush();
  // The retry serves degraded answers from memory without re-execution, yet
  // the batch results still contain fallback rows, so the flag holds.
  expect(coordinator.batchDegraded()).toBe(true);
  expect(coordinator.progress).toMatchObject({ running: false });
  const clean = new ReviewCoordinator(vi.fn(async url => Response.json(body(String(url)))) as typeof fetch);
  clean.startBatch(nodes, settings); await flush(); await flush(); await flush();
  expect(clean.batchDegraded()).toBe(false);
});
it('primes memory from the server cache without inference', async () => {
  const server = new Map<string, { engine: string; value: unknown }>();
  const live: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (path.startsWith('/evaluations/')) {
      if (init?.method === 'PUT') {
        const put = JSON.parse(init.body as string);
        server.set(path.slice('/evaluations/'.length), { engine: put.engine, value: put.value });
        return Response.json({});
      }
      const hit = server.get(path.slice('/evaluations/'.length));
      return hit ? Response.json({ ...hit, key_hash: 'x', created_at: 'now' }) : Response.json({ code: 'not_found' }, { status: 404 });
    }
    live.push(path);
    return Response.json(body(path));
  }) as unknown as typeof fetch;
  const first = new ReviewCoordinator(fetcher);
  first.startBatch(nodes, settings); await flush(); await flush();
  expect(first.progress).toMatchObject({ running: false });
  expect(server.size).toBeGreaterThan(0);
  const calls = live.length;
  const second = new ReviewCoordinator(fetcher);
  const coverage = await second.primeLine(nodes, settings, new AbortController().signal);
  expect(live).toHaveLength(calls);
  expect(coverage).toEqual({ covered: nodes.length, total: nodes.length });
  expect(second.result('sf', nodes[2], settings)).toMatchObject({ depth: 12 });
  expect(second.result('maia', nodes[2], settings)).toMatchObject({ move: 'e2e4' });
});
it('treats cache probe timeouts as misses instead of wedging the prime', async () => {
  vi.useFakeTimers();
  try {
    const live: string[] = [];
    const fetcher = (async (url: string | URL | Request) => {
      if (String(url).startsWith('/evaluations/')) return new Promise<Response>(() => {});
      live.push(String(url));
      return Response.json(body(String(url)));
    }) as unknown as typeof fetch;
    const coordinator = new ReviewCoordinator(fetcher);
    const pending = coordinator.primeLine(nodes, settings, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toEqual({ covered: 0, total: nodes.length });
    expect(live).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
it('rejects empty lines for non-terminal evaluations', async () => {
  const { fetchEvaluation } = await import('./reviewCoordinator');
  const bad = { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'e2e4', score: { type: 'cp', value: 0 }, lines: [] };
  const fetcher = (async () => Response.json(bad)) as typeof fetch;
  await expect(fetchEvaluation(nodes[0], new AbortController().signal, fetcher)).rejects.toThrow('incomplete evaluation');
});
it('rejects duplicated first moves across ranks', async () => {
  const { fetchEvaluation } = await import('./reviewCoordinator');
  // The exact shape the worker once persisted for 2...Nc6 positions: ranks 3
  // and 4 echo b8c6, marking two rows played and ghosting the list.
  const line = { move: 'b8c6', score: { type: 'cp', value: -65 }, depth: 12 };
  const bad = { engine: 'Stockfish 19', search_policy: stockfishPolicy({ time_ms: 750, lines: 4, depth: 0 }), depth: 12, terminal: null,
    best_move: 'g8f6', score: { type: 'cp', value: -92 },
    lines: [{ move: 'g8f6', score: { type: 'cp', value: -92 }, depth: 12 }, { move: 'f8c5', score: { type: 'cp', value: -88 }, depth: 12 }, line, { ...line }] };
  const fetcher = (async () => Response.json(bad)) as typeof fetch;
  await expect(fetchEvaluation(nodes[0], new AbortController().signal, fetcher, { time_ms: 750, lines: 4, depth: 0 })).rejects.toThrow('incomplete evaluation');
});
describe('batch timing traces', () => {
  it('records one live row per job with ply and policy, never double counting', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const fetcher = vi.fn(async url => Response.json(body(String(url)))) as typeof fetch;
      const coordinator = new ReviewCoordinator(fetcher);
      coordinator.startBatch(nodes, settings); await flush(); await flush(); await flush();
      expect(coordinator.progress).toMatchObject({ done: 8, total: 8, running: false });
      const rows = coordinator.timings.filter(timing => timing.batched);
      expect(rows).toHaveLength(8);
      expect(rows.every(timing => timing.source === 'live' && !timing.failed)).toBe(true);
      expect(rows.filter(timing => timing.engine === 'sf').map(timing => timing.ply).sort()).toEqual([0, 1, 2, 3]);
      expect(rows.find(timing => timing.engine === 'sf')?.detail).toBe(SEARCH_POLICY);
      const summary = coordinator.batchTimingSummary();
      expect(summary).toMatchObject({
        total: 8, done: 8, failed: 0,
        byEngine: { sf: { live: 4, memHits: 0, serverHits: 0 }, maia: { live: 4, memHits: 0, serverHits: 0 } },
      });
      expect(summary?.byEngine.sf.liveMsByPly.map(([ply]) => ply)).toEqual([0, 1, 2, 3]);
      expect(info).toHaveBeenCalledWith('[review] batch timing', expect.any(String));
    } finally {
      info.mockRestore();
    }
  });
  it('attributes server-cache hits per engine so a settings change shows as one-sided misses', async () => {
    const stored = new Map<string, { engine: string; value: unknown }>();
    const lines = [
      { move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 },
      { move: 'd2d4', score: { type: 'cp', value: -20 }, depth: 12 },
    ];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith('/evaluations/')) {
        if (init?.method === 'PUT') {
          const put = JSON.parse(init.body as string);
          stored.set(String(url).split('/').pop()!, { engine: put.engine, value: put.value });
          return Response.json({});
        }
        const hit = stored.get(String(url).split('/').pop()!);
        return hit
          ? Response.json({ key_hash: 'x', engine: hit.engine, value: hit.value, created_at: 'now' })
          : Response.json({ code: 'not_found', message: 'missing' }, { status: 404 });
      }
      if (String(url) === '/evaluate') {
        // Echo the requested search policy so explicit settings validate.
        let policy = SEARCH_POLICY;
        try {
          const request = JSON.parse(init?.body as string);
          if (request.settings) policy = stockfishPolicy(request.settings);
        } catch { /* keep the legacy policy */ }
        return Response.json({
          engine: 'Stockfish 19', search_policy: policy, depth: 12, terminal: null,
          best_move: 'e2e4', score: { type: 'cp', value: 0 }, lines,
        });
      }
      return Response.json(body(String(url)));
    }) as unknown as typeof fetch;
    const first = new ReviewCoordinator(fetcher);
    first.startBatch(nodes, settings); await flush(); await flush(); await flush();
    expect(first.progress).toMatchObject({ running: false });
    expect(stored.size).toBe(8);
    // Same game, same settings, fresh memory: every job is a server hit, zero inference.
    const second = new ReviewCoordinator(fetcher);
    second.startBatch(nodes, settings); await flush(); await flush(); await flush();
    expect(second.progress).toMatchObject({ running: false });
    expect(second.batchTimingSummary()).toMatchObject({
      byEngine: { sf: { live: 0, serverHits: 4, memHits: 0 }, maia: { live: 0, serverHits: 4, memHits: 0 } },
    });
    // Stockfish lines 2→4 changes only the SF policy: Maia still hits, SF re-runs live.
    const stockfish4 = { ...settings, stockfish: { time_ms: 750, lines: 4, depth: 0 } };
    const third = new ReviewCoordinator(fetcher);
    third.startBatch(nodes, stockfish4); await flush(); await flush(); await flush();
    expect(third.progress).toMatchObject({ running: false });
    const summary = third.batchTimingSummary();
    expect(summary).toMatchObject({
      byEngine: { sf: { live: 4, serverHits: 0 }, maia: { live: 0, serverHits: 4 } },
    });
    expect(third.timings.find(timing => timing.engine === 'sf')?.detail).toBe('sf19-ms750-mpv4-d0-t1-h64-v2');
  });
});
