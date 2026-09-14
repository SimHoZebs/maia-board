import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { applyUci, loadLine, START_FEN, testNodes } from './domain';
import { cacheHash, JOB_STALL_MS, RESUME_ABORT_AFTER_HIDDEN_MS, ReviewCoordinator, reviewKey, type ReviewNode } from './reviewCoordinator';
import { SEARCH_POLICY, terminalEvaluation, type Evaluation } from './reviewMetrics';
import { stockfishPolicy } from './stockfishSettings';
const settings = { eloMaia: 1600, eloUser: 1600, model: '79m' as const };
const line = loadLine('', '1. e4 e5 2. Nf3');
const nodes: ReviewNode[] = testNodes(line.initialFen, line.moves);
const body = (url: string) => url === '/evaluate' ? { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'e2e4', score: { type: 'cp', value: 0 }, lines: [{ move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: -20 }, depth: 12 }] } : { move: 'e2e4', top_moves: [], wdl: [0,1,0], model_used: '79m', degraded: false };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
// Emulates the read-through backend: POST /evaluate and POST /move carry
// cache_hash/cache_key, serve matching stored rows with an X-Eval-Cache hit
// header, or compute live (via liveBody), store non-degraded results, and
// report a miss. Validation mirrors the server (engine + key + policy/shape).
type StoredRow = { engine: string; key: string; value: unknown };
function validStored(value: unknown, engine: string, request: Record<string, unknown> & { settings?: Parameters<typeof stockfishPolicy>[0] }): boolean {
  if (!value || typeof value !== 'object') return false;
  if (engine === 'sf') {
    const row = value as { engine?: unknown; search_policy?: unknown; lines?: unknown };
    return row.engine === 'Stockfish 19' && row.search_policy === stockfishPolicy(request.settings) && Array.isArray(row.lines);
  }
  return typeof (value as { move?: unknown }).move === 'string';
}
function readThroughFetcher(
  store: Map<string, StoredRow>,
  liveBody: (path: string, request: Record<string, unknown>) => unknown,
  transcript: string[] = [],
) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).split('?')[0];
    if (path === '/evaluate' || path === '/move') {
      const request = JSON.parse(init?.body as string) as Record<string, unknown> & { cache_hash: string; cache_key: string };
      const engine = path === '/evaluate' ? 'sf' : 'maia';
      const hit = store.get(request.cache_hash);
      if (hit && hit.engine === engine && hit.key === request.cache_key && validStored(hit.value, engine, request)) {
        transcript.push(`${path}:hit`);
        return Response.json(hit.value, { headers: { 'X-Eval-Cache': 'hit' } });
      }
      const value = liveBody(path, request);
      // Mirrors the server: every Stockfish result persists, Maia rows persist
      // unless degraded; requests without coordinates (live retries) file nothing.
      if (request.cache_hash && !(engine === 'maia' && (value as { degraded?: boolean }).degraded)) store.set(request.cache_hash, { engine, key: request.cache_key, value });
      transcript.push(`${path}:miss`);
      return Response.json(value);
    }
    if (path.startsWith('/evaluations/')) {
      if (init?.method === 'PUT') {
        const put = JSON.parse(init.body as string) as { engine: string; key: string; value: unknown };
        store.set(path.slice('/evaluations/'.length), { engine: put.engine, key: put.key, value: put.value });
        return Response.json({ key_hash: 'x', engine: put.engine, created_at: 'now' });
      }
      const hit = store.get(path.slice('/evaluations/'.length));
      if (hit) return Response.json({ key_hash: 'x', engine: hit.engine, value: hit.value, created_at: 'now' });
      return Response.json({ code: 'not_found', message: 'missing' }, { status: 404 });
    }
    return Response.json(liveBody(path, {}));
  }) as unknown as typeof fetch;
}
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
it('fetches Maia for both foreground positions at depth 2, one by default', async () => {
  const requests: string[] = [];
  const fetcher = vi.fn(async (url, init) => {
    if (!init?.body) return Response.json({ code: 'not_found', message: 'missing' }, { status: 404 });
    requests.push(`${url}:${JSON.parse(init.body as string).moves.length}`);
    return Response.json(body(String(url)));
  }) as typeof fetch;
  const deep = new ReviewCoordinator(fetcher);
  deep.foregroundAt([nodes[3], nodes[2]], settings, 2); await flush();
  expect(requests).toContain('/move:3');
  expect(requests).toContain('/move:2');
  expect(requests).toContain('/evaluate:3');
  expect(requests).toContain('/evaluate:2');
  expect(deep.result('maia', nodes[3], settings)).toBeDefined();
  expect(deep.result('maia', nodes[2], settings)).toBeDefined();
  const shallow = new ReviewCoordinator(fetcher);
  shallow.foregroundAt([nodes[3], nodes[2]], settings); await flush();
  expect(shallow.result('maia', nodes[3], settings)).toBeDefined();
  expect(shallow.result('maia', nodes[2], settings)).toBeUndefined();
});
it('coalesces synchronous emits into one subscriber notification', async () => {
  const fetcher = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  const calls = vi.fn();
  coordinator.subscribe(calls);
  coordinator.startBatch(nodes, settings);
  coordinator.suspend();
  coordinator.retry();
  expect(calls).not.toHaveBeenCalled();
  await flush();
  expect(calls).toHaveBeenCalledTimes(1);
  expect(coordinator.snapshot()).toBe(1);
});
it('keys include full history, initial position, ratings and model', () => {
  expect(reviewKey('maia', nodes[0], settings)).not.toBe(reviewKey('maia', nodes[0], { ...settings, eloMaia: 1700 }));
  expect(reviewKey('sf', nodes[0], settings)).toBe(reviewKey('sf', nodes[0], { ...settings, eloMaia: 1700 }));
  expect(reviewKey('sf', nodes[0], settings)).not.toBe(reviewKey('sf', nodes[1], settings));
});
describe('sfPendingKeys', () => {
  const sfKey = (node: ReviewNode) => reviewKey('sf', node, settings);
  const gate = () => {
    const releases: (() => void)[] = [];
    const fetcher = vi.fn(async (url, init) => {
      if (!init?.body) return Response.json({ code: 'not_found', message: 'missing' }, { status: 404 });
      await new Promise<void>(resolve => releases.push(resolve));
      return Response.json(body(String(url)));
    }) as typeof fetch;
    return { releases, coordinator: new ReviewCoordinator(fetcher) };
  };
  it('covers queued and running jobs, dropping each as it settles', async () => {
    const { releases, coordinator } = gate();
    coordinator.syncPlayQueue([nodes[0], nodes[1]], settings); await flush();
    expect(coordinator.sfPendingKeys()).toEqual(new Set([sfKey(nodes[0]), sfKey(nodes[1])]));
    releases.splice(0, 1).forEach(resolve => resolve()); await flush();
    expect(coordinator.sfPendingKeys()).toEqual(new Set([sfKey(nodes[1])]));
    coordinator.suspend(); releases.splice(0).forEach(resolve => resolve()); await flush();
    expect(coordinator.sfPendingKeys()).toEqual(new Set());
  });
  it('covers batch-future nodes and clears on completion', async () => {
    const { releases, coordinator } = gate();
    coordinator.startBatch(nodes, settings); await flush();
    expect(coordinator.sfPendingKeys()).toEqual(new Set(nodes.map(sfKey)));
    for (let i = 0; i < 20 && coordinator.progress?.running; i++) { releases.splice(0).forEach(resolve => resolve()); await flush(); }
    expect(coordinator.progress).toMatchObject({ running: false });
    expect(coordinator.sfPendingKeys()).toEqual(new Set());
  });
  it('excludes failed keys once the lane gives up', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => Response.json({ message: 'Busy' }, { status: 503, headers: { 'Retry-After': '1' } })) as typeof fetch;
      const coordinator = new ReviewCoordinator(fetcher);
      coordinator.foregroundAt([nodes[0]], settings);
      expect(coordinator.sfPendingKeys()).toEqual(new Set([sfKey(nodes[0])]));
      await vi.runAllTimersAsync(); await flush();
      expect(coordinator.error('sf', nodes[0], settings)).toBe('Busy');
      expect(coordinator.sfPendingKeys()).toEqual(new Set());
      coordinator.suspend();
    } finally { vi.useRealTimers(); }
  });
  it('tracks prime restores in flight and releases on completion', async () => {
    const releases: (() => void)[] = [];
    const fetcher = vi.fn(async (url, init) => {
      if (String(url).startsWith('/evaluations/')) {
        await new Promise<void>(resolve => releases.push(resolve));
        return Response.json({ code: 'not_found', message: 'missing' }, { status: 404 });
      }
      return Response.json(body(String(url)));
    }) as typeof fetch;
    const coordinator = new ReviewCoordinator(fetcher);
    const primed = coordinator.primeLine(nodes, settings, new AbortController().signal);
    await flush();
    expect(coordinator.sfPendingKeys()).toEqual(new Set(nodes.map(sfKey)));
    releases.splice(0).forEach(resolve => resolve());
    await expect(primed).resolves.toEqual({ covered: 0, total: nodes.length });
    expect(coordinator.sfPendingKeys()).toEqual(new Set());
  });
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
  const node = testNodes(terminal.initialFen, terminal.moves).at(-1)!;
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
    // Three live attempts per engine lane (no separate cache probe: the POST
    // itself is the read-through lookup).
    expect(fetcher).toHaveBeenCalledTimes(6);
    coordinator.foregroundAt([nodes[0]], settings); await flush(); expect(fetcher).toHaveBeenCalledTimes(6);
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
  const stored = new Map<string, StoredRow>();
  const transcript: string[] = [];
  const fetcher = vi.fn(readThroughFetcher(stored, path => body(path), transcript));
  const misses = () => transcript.filter(call => call.endsWith(':miss'));
  const first = new ReviewCoordinator(fetcher);
  first.foregroundAt([nodes[0]], settings); await flush();
  expect(first.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
  expect(first.result('maia', nodes[0], settings)).toMatchObject({ move: 'e2e4' });
  expect(stored.size).toBe(2);
  expect(misses()).toHaveLength(2);
  transcript.length = 0;
  const second = new ReviewCoordinator(fetcher);
  second.foregroundAt([nodes[0]], settings); await flush();
  expect(second.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
  expect(second.result('maia', nodes[0], settings)).toMatchObject({ move: 'e2e4' });
  expect(misses()).toEqual([]);
  expect(transcript.filter(call => call.endsWith(':hit'))).toHaveLength(2);
});
it('ignores corrupt cached rows and never persists fallback answers', async () => {
  // A lax old row (stored via the legacy PUT path) fails read-through
  // validation server-side and falls back to live inference; the degraded
  // live Maia answer is not persisted either.
  const sfKey = reviewKey('sf', nodes[0], settings);
  const stored = new Map<string, StoredRow>([[cacheHash(sfKey), { engine: 'sf', key: sfKey, value: { nope: true } }]]);
  const transcript: string[] = [];
  const liveBody = (path: string) => ({ ...body(path), degraded: true });
  const fetcher = vi.fn(readThroughFetcher(stored, liveBody, transcript));
  const coordinator = new ReviewCoordinator(fetcher);
  coordinator.foregroundAt([nodes[0]], settings); await flush();
  expect(coordinator.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
  // The corrupt row was overwritten with a valid one; the degraded Maia
  // answer was never persisted.
  expect((stored.get(cacheHash(sfKey))?.value as { depth?: number })?.depth).toBe(12);
  expect([...stored.values()].filter(row => row.engine === 'maia')).toHaveLength(0);
});
it('falls back to live inference when a served row fails validation', async () => {
  // A lax legacy row can pass the server's light checks yet fail the strict
  // frontend parser (duplicated first move across ranks): the coordinator
  // re-infers live once — healing the row — instead of recording a failure.
  const sfKey = reviewKey('sf', nodes[0], settings);
  const poison = {
    engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null,
    best_move: 'e2e4', score: { type: 'cp', value: 0 },
    lines: [
      { move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 },
      { move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 },
    ],
  };
  const stored = new Map<string, StoredRow>([[cacheHash(sfKey), { engine: 'sf', key: sfKey, value: poison }]]);
  const transcript: string[] = [];
  const fetcher = vi.fn(readThroughFetcher(stored, path => body(path), transcript));
  const coordinator = new ReviewCoordinator(fetcher);
  coordinator.foregroundSfOnly([nodes[0]], settings); await flush(); await flush();
  expect(coordinator.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
  expect(coordinator.error('sf', nodes[0], settings)).toBeUndefined();
  expect(transcript.filter(call => call === '/evaluate:hit')).toHaveLength(1);
  expect(transcript.filter(call => call === '/evaluate:miss')).toHaveLength(1);
  // The poisoned row was healed with the live body, not merely bypassed:
  // distinct ranks, best move leading, deep-equal to live inference.
  await flush();
  const healed = stored.get(cacheHash(sfKey))?.value as { lines: { move: string }[]; best_move: string };
  expect(new Set(healed.lines.map(line => line.move)).size).toBe(healed.lines.length);
  expect(healed.best_move).toBe(healed.lines[0].move);
  expect(healed).toEqual(body('/evaluate'));
});
it('primes around degraded Maia rows instead of caching them', async () => {
  // A lax legacy degraded row served over GET must read as a miss: priming
  // covers nothing for that node and caches nothing degraded.
  const sfKey = reviewKey('sf', nodes[0], settings);
  const maiaKey = reviewKey('maia', nodes[0], settings);
  const evaluation = { engine: 'Stockfish 19', search_policy: SEARCH_POLICY, depth: 12, terminal: null, best_move: 'e2e4', score: { type: 'cp', value: 0 }, lines: [{ move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 }, { move: 'd2d4', score: { type: 'cp', value: -20 }, depth: 12 }] };
  const degraded = { move: 'e2e4', top_moves: [], wdl: [0, 1, 0], model_used: '79m', degraded: true };
  const server = new Map<string, { engine: string; value: unknown }>([
    [cacheHash(sfKey), { engine: 'sf', value: evaluation }],
    [cacheHash(maiaKey), { engine: 'maia', value: degraded }],
  ]);
  const fetcher = (async (url: string | URL | Request) => {
    const hit = server.get(String(url).slice('/evaluations/'.length));
    return hit
      ? Response.json({ key_hash: 'x', engine: hit.engine, value: hit.value, created_at: 'now' })
      : Response.json({ code: 'not_found' }, { status: 404 });
  }) as unknown as typeof fetch;
  const coordinator = new ReviewCoordinator(fetcher);
  const coverage = await coordinator.primeLine([nodes[0]], settings, new AbortController().signal);
  expect(coverage).toEqual({ covered: 0, total: 1 });
  expect(coordinator.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
  expect(coordinator.result('maia', nodes[0], settings)).toBeUndefined();
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
    // Read-through emulation: live POSTs file their results for the prime.
    if (path === '/evaluate' || path === '/move') {
      const request = JSON.parse(init?.body as string) as { cache_hash: string };
      const value = body(path);
      server.set(request.cache_hash, { engine: path === '/evaluate' ? 'sf' : 'maia', value });
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
    const stored = new Map<string, StoredRow>();
    const transcript: string[] = [];
    const lines = [
      { move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 },
      { move: 'd2d4', score: { type: 'cp', value: -20 }, depth: 12 },
    ];
    const liveBody = (path: string, request: Record<string, unknown>) => {
      if (path === '/evaluate') {
        // Echo the requested search policy so explicit settings validate.
        let policy = SEARCH_POLICY;
        const settings = request.settings as Parameters<typeof stockfishPolicy>[0] | undefined;
        if (settings) policy = stockfishPolicy(settings);
        return {
          engine: 'Stockfish 19', search_policy: policy, depth: 12, terminal: null,
          best_move: 'e2e4', score: { type: 'cp', value: 0 }, lines,
        };
      }
      return body(path);
    };
    const fetcher = vi.fn(readThroughFetcher(stored, liveBody, transcript));
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
describe('stockfish superset reuse', () => {
  const CANDIDATES = ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3'];
  const sf2 = { ...settings, stockfish: { time_ms: 750, lines: 2, depth: 0 } };
  const sf4 = { ...settings, stockfish: { time_ms: 750, lines: 4, depth: 0 } };
  // Echoes the requested search policy with one line per requested mpv, so
  // explicit settings validate — mirroring the worker's min(mpv, legal).
  const liveBody = (path: string, request: Record<string, unknown>) => {
    if (path === '/evaluate') {
      const wanted = request.settings as { time_ms: number; lines: number; depth: number };
      const policy = stockfishPolicy(wanted);
      const count = Math.min(wanted.lines, 4);
      const lines = CANDIDATES.slice(0, count).map((move, index) => ({ move, score: { type: 'cp', value: -index * 10 }, depth: 12 }));
      return { engine: 'Stockfish 19', search_policy: policy, depth: 12, terminal: null, best_move: lines[0].move, score: lines[0].score, lines };
    }
    return body(path);
  };
  const posts = (fetcher: ReturnType<typeof vi.fn>) =>
    fetcher.mock.calls.map(([url]) => String(url)).filter(url => url === '/evaluate' || url === '/move');
  const evalPosts = (fetcher: ReturnType<typeof vi.fn>) => posts(fetcher).filter(url => url === '/evaluate');
  it('primes and batches fewer lines from larger-mpv rows with zero inference', async () => {
    const stored = new Map<string, StoredRow>();
    const transcript: string[] = [];
    const fetcher = vi.fn(readThroughFetcher(stored, liveBody, transcript));
    const first = new ReviewCoordinator(fetcher);
    first.startBatch(nodes, sf4); await flush(); await flush(); await flush();
    expect(first.progress).toMatchObject({ running: false });
    expect(evalPosts(fetcher)).toHaveLength(4);
    // Fresh memory: priming for 2 lines reuses the 4-line rows read-only.
    const second = new ReviewCoordinator(fetcher);
    const calls = fetcher.mock.calls.length;
    const evalBeforePrime = evalPosts(fetcher).length;
    const coverage = await second.primeLine(nodes, sf2, new AbortController().signal);
    expect(coverage).toEqual({ covered: nodes.length, total: nodes.length });
    expect(evalPosts(fetcher)).toHaveLength(evalBeforePrime); // prime never POSTs
    expect(fetcher.mock.calls.length).toBeGreaterThan(calls); // only GET probes
    const sliced = second.result('sf', nodes[0], sf2);
    expect(sliced?.lines.map(line => line.move)).toEqual(['e2e4', 'd2d4']);
    expect(sliced?.search_policy).toBe(stockfishPolicy(sf2.stockfish));
    expect(sliced?.best_move).toBe('e2e4');
    // Analyzing at 2 lines completes off the primed memory: zero inference.
    const before = posts(fetcher).length;
    second.startBatch(nodes, sf2); await flush(); await flush(); await flush();
    expect(second.progress).toMatchObject({ running: false, failed: 0 });
    expect(posts(fetcher)).toHaveLength(before);
    expect(second.batchTimingSummary()).toMatchObject({ byEngine: { sf: { live: 0 }, maia: { live: 0 } } });
  });
  it('serves unprimed batches from server supersets without POST inference', async () => {
    const stored = new Map<string, StoredRow>();
    const transcript: string[] = [];
    const fetcher = vi.fn(readThroughFetcher(stored, liveBody, transcript));
    const first = new ReviewCoordinator(fetcher);
    first.startBatch(nodes, sf4); await flush(); await flush(); await flush();
    expect(first.progress).toMatchObject({ running: false });
    // No priming: the batch itself falls back to server superset GETs.
    const second = new ReviewCoordinator(fetcher);
    const evalBefore = evalPosts(fetcher).length;
    second.startBatch(nodes, sf2); await flush(); await flush(); await flush();
    expect(second.progress).toMatchObject({ running: false, failed: 0 });
    expect(evalPosts(fetcher)).toHaveLength(evalBefore);
    expect(second.batchTimingSummary()).toMatchObject({ byEngine: { sf: { live: 0, serverHits: 4 } } });
    expect(second.result('sf', nodes[2], sf2)?.lines).toHaveLength(2);
  });
  it('still misses when time or depth differ, and never serves upward', async () => {
    const stored = new Map<string, StoredRow>();
    const transcript: string[] = [];
    const fetcher = vi.fn(readThroughFetcher(stored, liveBody, transcript));
    const first = new ReviewCoordinator(fetcher);
    first.startBatch(nodes, sf4); await flush(); await flush(); await flush();
    expect(first.progress).toMatchObject({ running: false });
    // Same lines, different time: superset must not apply.
    const slower = { ...settings, stockfish: { time_ms: 2000, lines: 2, depth: 0 } };
    const second = new ReviewCoordinator(fetcher);
    const coverage = await second.primeLine(nodes, slower, new AbortController().signal);
    expect(coverage.covered).toBe(0);
    expect(second.result('sf', nodes[0], slower)).toBeUndefined();
    // Fewer stored lines can never satisfy more requested lines (upward).
    const third = new ReviewCoordinator(fetcher);
    const before = posts(fetcher).length;
    third.startBatch(nodes.slice(0, 1), { ...settings, stockfish: { time_ms: 750, lines: 5, depth: 0 } });
    await flush(); await flush(); await flush();
    expect(third.progress).toMatchObject({ running: false });
    expect(posts(fetcher).length).toBeGreaterThan(before);
  });
  it('satisfies short prefixes when the position has one legal move', async () => {
    const single = testNodes('R6k/8/5K2/8/8/8/8/8 b - - 0 1', []);
    const oneLiner = () => ({ engine: 'Stockfish 19', search_policy: stockfishPolicy(sf4.stockfish), depth: 12, terminal: null,
      best_move: 'h8h7', score: { type: 'cp', value: 0 }, lines: [{ move: 'h8h7', score: { type: 'cp', value: 0 }, depth: 12 }] });
    const fetcher = vi.fn(readThroughFetcher(new Map(), path => (path === '/evaluate' ? oneLiner() : body(path)), []));
    const first = new ReviewCoordinator(fetcher);
    first.startBatch(single, sf4); await flush(); await flush(); await flush();
    expect(first.result('sf', single[0], sf4)?.lines).toHaveLength(1);
    const second = new ReviewCoordinator(fetcher);
    const coverage = await second.primeLine(single, sf2, new AbortController().signal);
    expect(coverage).toEqual({ covered: 1, total: 1 });
    expect(second.result('sf', single[0], sf2)?.lines.map(line => line.move)).toEqual(['h8h7']);
  });
  it('skips corrupt superset rows and falls through to live inference', async () => {
    const poison = {
      engine: 'Stockfish 19', search_policy: stockfishPolicy(sf4.stockfish), depth: 12, terminal: null,
      best_move: 'e2e4', score: { type: 'cp', value: 0 },
      lines: [
        { move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 },
        { move: 'e2e4', score: { type: 'cp', value: 0 }, depth: 12 },
        { move: 'g1f3', score: { type: 'cp', value: -10 }, depth: 12 },
        { move: 'c2c4', score: { type: 'cp', value: -20 }, depth: 12 },
      ],
    };
    const sfKey = reviewKey('sf', nodes[0], sf4);
    const stored = new Map<string, StoredRow>([[cacheHash(sfKey), { engine: 'sf', key: sfKey, value: poison }]]);
    const transcript: string[] = [];
    const fetcher = vi.fn(readThroughFetcher(stored, liveBody, transcript));
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.foregroundSfOnly([nodes[0]], sf2); await flush(); await flush();
    // The duplicated-move superset fails witness validation, so the lane
    // runs live and files a clean native 2-line row.
    expect(coordinator.result('sf', nodes[0], sf2)).toMatchObject({ depth: 12 });
    expect(coordinator.result('sf', nodes[0], sf2)?.lines).toHaveLength(2);
    expect(transcript.filter(call => call === '/evaluate:miss')).toHaveLength(1);
  });
});
describe('play-time Maia persistence', () => {
  it('keys play replies identically to analysis batches for reuse', async () => {
    const { maiaCacheKeyForMoveRequest } = await import('./reviewCoordinator');
    const payload = { fen: nodes[0].fen, moves: nodes[0].moves, elo_maia: 1600, elo_user: 1600, model: '79m' as const };
    const { key, hash } = maiaCacheKeyForMoveRequest(payload);
    expect(key).toBe(reviewKey('maia', nodes[0], settings));
    expect(hash).toBe(cacheHash(key));
    // A play-time reply sent with those coordinates is filed read-through and
    // later served to analysis without inference.
    const stored = new Map<string, StoredRow>();
    const transcript: string[] = [];
    const response = { move: 'e2e4', top_moves: [], wdl: [0, 1, 0] as [number, number, number], model_used: '79m' as const, degraded: false };
    const saver = readThroughFetcher(stored, path => (path === '/move' ? response : body(path)), transcript);
    const { requestMove } = await import('./api');
    await requestMove({ ...payload, maia_color: 'white' as const, cache_hash: hash, cache_key: key }, saver);
    expect(stored.size).toBe(1);
    const coordinator = new ReviewCoordinator(saver);
    coordinator.foregroundAt([nodes[0]], settings);
    await flush();
    expect(coordinator.result('sf', nodes[0], settings)).toMatchObject({ depth: 12 });
    expect(coordinator.result('maia', nodes[0], settings)).toMatchObject({ move: 'e2e4' });
    expect(transcript.filter(call => call === '/move:hit')).toHaveLength(1);
    expect(transcript.filter(call => call === '/move:miss')).toHaveLength(1);
  });
  it('keys custom-start positions with initial_fen identically to batches', async () => {
    const { maiaCacheKeyForMoveRequest } = await import('./reviewCoordinator');
    const custom = loadLine('4k3/8/8/8/8/8/4P3/4K3 b - - 0 12', '12... Kd7');
    const customNodes: ReviewNode[] = testNodes(custom.initialFen, custom.moves);
    const target = customNodes[1];
    const payload = { fen: target.fen, moves: target.moves, initial_fen: custom.initialFen, elo_maia: 1800, elo_user: 1500, model: '5m' as const };
    const { key } = maiaCacheKeyForMoveRequest(payload);
    expect(key).toBe(reviewKey('maia', target, { eloMaia: 1800, eloUser: 1500, model: '5m' }));
  });
  it('never persists degraded fallback answers', async () => {
    // Degraded live answers flow through to the caller but are filed nowhere:
    // a second coordinator still misses instead of being served the fallback.
    const stored = new Map<string, StoredRow>();
    const transcript: string[] = [];
    const fetcher = vi.fn(readThroughFetcher(stored, path => ({ ...body(path), degraded: true }), transcript));
    const first = new ReviewCoordinator(fetcher);
    first.foregroundAt([nodes[0]], settings); await flush();
    expect(first.result('maia', nodes[0], settings)).toMatchObject({ move: 'e2e4' });
    expect(stored.size).toBe(1);
    const second = new ReviewCoordinator(fetcher);
    second.foregroundAt([nodes[0]], settings); await flush();
    expect(second.result('maia', nodes[0], settings)).toMatchObject({ move: 'e2e4' });
    expect(transcript.filter(call => call === '/move:hit')).toHaveLength(0);
    expect(transcript.filter(call => call === '/move:miss')).toHaveLength(2);
  });
  it('supports per-node Maia identities so own games pin Maia moves', async () => {
    const stored = new Map<string, StoredRow>();
    const transcript: string[] = [];
    const fetcher = readThroughFetcher(stored, (path, request) => {
      if (path === '/move') {
        // Echo the requested Elo back as the predicted move so per-node
        // identities are distinguishable through validated responses.
        const move = (request as { elo_maia?: number }).elo_maia === 2000 ? 'd2d4' : 'e2e4';
        return { move, top_moves: [], wdl: [0, 1, 0], model_used: '79m', degraded: false };
      }
      return body(path);
    }, transcript);
    const low = { ...settings, eloMaia: 1200, eloUser: 1200 };
    const high = { ...settings, eloMaia: 2000, eloUser: 2000 };
    // Even plies (white to move) follow the adjustable rating, odd plies stay pinned.
    const split = (node: ReviewNode) => (node.moves.length % 2 === 0 ? high : low);
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.startBatch(nodes.slice(0, 2), split);
    await flush(); await flush(); await flush();
    expect(coordinator.progress).toMatchObject({ running: false });
    expect(coordinator.result('maia', nodes[0], high)?.move).toBe('d2d4');
    expect(coordinator.result('maia', nodes[1], low)?.move).toBe('e2e4');
    expect(coordinator.result('maia', nodes[0], low)).toBeUndefined();
    // Second run with the same split hits the server cache, zero live Maia inference.
    const second = new ReviewCoordinator(fetcher);
    second.startBatch(nodes.slice(0, 2), split);
    await flush(); await flush(); await flush();
    expect(transcript.filter(call => call === '/move:miss')).toHaveLength(2);
    expect(second.batchTimingSummary()).toMatchObject({ byEngine: { maia: { live: 0, serverHits: 2 } } });
  });
});

describe('syncPlayQueueResolved', () => {
  const never = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  // Mirrors the play hook: one progressive walk, prefix fens, history-aware
  // terminals, zero replays.
  const progressiveItems = (plies: string[]) => {
    const game = new Chess(START_FEN);
    const items: { node: ReviewNode; terminal: Evaluation | null }[] = [
      { node: { initialFen: START_FEN, moves: [], fen: game.fen() }, terminal: terminalEvaluation(game) ?? null },
    ];
    for (const uci of plies) {
      applyUci(game, uci);
      const moves = [...items[items.length - 1].node.moves, uci];
      items.push({ node: { initialFen: START_FEN, moves, fen: game.fen() }, terminal: terminalEvaluation(game) ?? null });
    }
    return items;
  };

  it('seeds terminal positions and queues only live ones without touching the Maia lane', async () => {
    const items = progressiveItems(['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const transcript: string[] = [];
    const coordinator = new ReviewCoordinator(readThroughFetcher(new Map(), path => body(path), transcript));
    coordinator.syncPlayQueueResolved(items, settings);
    await flush();
    const tip = items[items.length - 1].node;
    expect(coordinator.result('sf', tip, settings)?.terminal).toBe('black_win');
    expect(coordinator.result('sf', items[0].node, settings)).toBeDefined();
    expect(transcript.some(call => call.startsWith('/move'))).toBe(false);
    expect(coordinator.result('maia', tip, settings)).toBeUndefined();
  });

  it('prunes queued jobs the line no longer needs', () => {
    const coordinator = new ReviewCoordinator(never);
    const full = testNodes(line.initialFen, line.moves);
    const items = full.map(node => ({ node, terminal: null as Evaluation | null }));
    coordinator.syncPlayQueueResolved(items, settings);
    expect(coordinator.sfPendingKeys().size).toBe(full.length);
    coordinator.syncPlayQueueResolved(items.slice(0, 2), settings);
    expect(coordinator.sfPendingKeys()).toEqual(new Set(items.slice(0, 2).map(({ node }) => reviewKey('sf', node, settings))));
  });

  it('rejects stale fens outside production', () => {
    const coordinator = new ReviewCoordinator(never);
    expect(() => coordinator.syncPlayQueueResolved(
      [{ node: { initialFen: START_FEN, moves: ['e2e4'], fen: START_FEN }, terminal: null }], settings,
    )).toThrow(/stale fen/);
  });
});
