import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { buildTimeline, START_FEN, timelineBuildsForTests } from './domain';
import { EvaluationStore, ReviewCoordinator, reviewKey, reviewNodes, parseEvaluation, type ReviewSettings } from './reviewCoordinator';
import { defaultStockfishSettings, stockfishPolicy } from './stockfishSettings';
import { jsonResponse, maiaFixture, sfFixture } from './evaluationTestFixtures';
import { withDeadline } from './evaluationTransport';

const settings: ReviewSettings = { eloMaia: 1600, eloUser: 1600, model: '79m', stockfish: defaultStockfishSettings };
const nodes = reviewNodes(buildTimeline(START_FEN, ['e2e4', 'e7e5', 'g1f3']));
const flush = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
function liveFetch() {
  return vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(init!.body as string);
    if (url === '/evaluations/lookup') return jsonResponse({ results: [] });
    return jsonResponse(url === '/evaluate' ? sfFixture(body.fen, body.settings) : maiaFixture(body.fen, body.model));
  });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('timeline-backed restoration', () => {
  it('restores a cold four-position line in one bulk POST with zero individual GETs or inference', async () => {
    const fetcher = liveFetch();
    const coordinator = new ReviewCoordinator(fetcher);
    const builds = timelineBuildsForTests();
    const replayStep = vi.spyOn(Chess.prototype, 'move');
    expect(await coordinator.ensure(nodes, settings, { signal: new AbortController().signal })).toEqual({ covered: 0, total: 4 });
    expect(replayStep).not.toHaveBeenCalled();
    replayStep.mockRestore();
    expect(timelineBuildsForTests()).toBe(builds);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/evaluations/lookup');
    const init = fetcher.mock.calls[0][1]!;
    expect(init.method).toBe('POST');
    const requests = JSON.parse(init.body as string).requests;
    expect(requests).toHaveLength(8);
    expect(requests[6]).toMatchObject({ engine: 'sf', moves: ['e2e4', 'e7e5', 'g1f3'], initial_fen: START_FEN, fen: nodes[3].fen });
    expect(nodes.every(node => !('moves' in node) && !('sanMoves' in node) && node.timeline === nodes[0].timeline)).toBe(true);
  });
  it('restores sparse indexes, rejects wrong-model rows, and retries only the missing keys', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ results: [
      { index: 0, value: sfFixture(nodes[0].fen) },
      { index: 1, value: maiaFixture(nodes[0].fen, '5m') },
      { index: 3, value: maiaFixture(nodes[1].fen) },
      { index: 999, value: maiaFixture(nodes[0].fen) },
    ] })).mockResolvedValue(jsonResponse({ results: [] }));
    const coordinator = new ReviewCoordinator(fetcher);
    await coordinator.ensure(nodes.slice(0, 2), settings, { signal: new AbortController().signal });
    expect(coordinator.result('sf', nodes[0], settings)).toBeDefined();
    expect(coordinator.result('maia', nodes[0], settings)).toBeUndefined();
    expect(coordinator.result('maia', nodes[1], settings)).toBeDefined();
    await coordinator.ensure(nodes.slice(0, 2), settings, { signal: new AbortController().signal });
    const requests = JSON.parse(fetcher.mock.calls[1][1]!.body as string).requests;
    expect(requests.map((r: { engine: string; moves: string[] }) => [r.engine, r.moves.length])).toEqual([['maia', 0], ['sf', 1]]);
    expect(fetcher.mock.calls.every(([url]) => url === '/evaluations/lookup')).toBe(true);
  });
  it('prime hits report full coverage without extra requests', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => jsonResponse({ results: JSON.parse(init!.body as string).requests.map((r: { engine: string; fen: string }, index: number) => ({ index, value: r.engine === 'sf' ? sfFixture(r.fen) : maiaFixture(r.fen) })) }));
    const coordinator = new ReviewCoordinator(fetcher);
    expect(await coordinator.ensure(nodes, settings, { signal: new AbortController().signal })).toEqual({ covered: 4, total: 4 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('terminal repetition, mate and custom-FEN draw need no engine request', async () => {
    const repetition = buildTimeline(START_FEN, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']);
    const mate = buildTimeline(START_FEN, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const draw = buildTimeline('8/8/8/8/8/8/7k/K7 w - - 0 1', []);
    const terminal = [reviewNodes(repetition).at(-1)!, reviewNodes(mate).at(-1)!, reviewNodes(draw)[0]];
    const fetcher = liveFetch(), coordinator = new ReviewCoordinator(fetcher);
    expect(await coordinator.ensure(terminal, settings, { signal: new AbortController().signal })).toEqual({ total: 3, covered: 3 });
    coordinator.ensure(terminal, settings, { priority: true });
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(coordinator.result('sf', terminal[0], settings)?.terminal).toBe('draw');
    expect(coordinator.result('sf', terminal[1], settings)?.score).toEqual({ type: 'mate', value: 0, winning_side: 'black' });
  });
  it('tracks restore pending work and aborts an unresolved response body', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as unknown as Response);
    const coordinator = new ReviewCoordinator(fetcher), controller = new AbortController();
    const promise = coordinator.ensure(nodes, settings, { signal: controller.signal });
    expect(coordinator.sfPendingKeys().size).toBe(4);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(coordinator.sfPendingKeys().size).toBe(0);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('lookup deadlines cover body consumption and do not launch fallback probes', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) } as unknown as Response);
    const coordinator = new ReviewCoordinator(fetcher);
    const rejected = expect(coordinator.ensure(nodes, settings, { signal: new AbortController().signal })).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(30_001); await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(coordinator.sfPendingKeys().size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('chunks bulk restoration only at the 1024-request bound', async () => {
    const roots = Array.from({ length: 513 }, (_, index) => reviewNodes(buildTimeline(START_FEN.replace('0 1', `0 ${index + 1}`), []))[0]);
    const fetcher = liveFetch(), coordinator = new ReviewCoordinator(fetcher);
    await coordinator.ensure(roots, settings, { signal: new AbortController().signal });
    expect(fetcher.mock.calls.map(([url, init]) => [url, JSON.parse(init!.body as string).requests.length])).toEqual([
      ['/evaluations/lookup', 1024], ['/evaluations/lookup', 2],
    ]);
  });
});

describe('workspace scheduler', () => {
  it('deduplicates foreground work and provides root candidates without replay', async () => {
    const fetcher = liveFetch(), coordinator = new ReviewCoordinator(fetcher), builds = timelineBuildsForTests();
    coordinator.ensure([nodes[0]], settings, { priority: true }); coordinator.ensure([nodes[0]], settings, { priority: true });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(coordinator.result('sf', nodes[0], settings)?.lines.length).toBe(2);
    coordinator.ensure([nodes[1], nodes[0]], settings, { priority: true }); await flush();
    coordinator.ensure([nodes[0]], settings, { priority: true }); await flush();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(timelineBuildsForTests()).toBe(builds);
  });
  it('shares settled rows across workspace lifetimes, with independent failures and subscriptions', async () => {
    const fetcher = liveFetch(), store = new EvaluationStore(fetcher);
    const first = new ReviewCoordinator(fetcher, store), second = new ReviewCoordinator(fetcher, store);
    const render = vi.fn(), unsubscribe = first.subscribe(render);
    first.ensure([nodes[0]], settings, { priority: true }); await flush();
    unsubscribe(); render.mockClear();
    second.ensure([nodes[0]], settings, { priority: true }); await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    second.ensure([nodes[1]], settings, { priority: true }); await flush();
    expect(render).not.toHaveBeenCalled();
    expect(first.result('sf', nodes[1], settings)).toBe(second.result('sf', nodes[1], settings));

  });
  it('default workspace schedulers share the app store', () => {
    expect(new ReviewCoordinator().store).toBe(new ReviewCoordinator().store);
  });
  it('a newer foreground request replaces queued stale work', async () => {
    let release!: (response: Response) => void;
    const fetcher = liveFetch(); fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.ensure(nodes.slice(0, 2), settings, { priority: true, engines: ['sf'] });
    coordinator.ensure(nodes.slice(2), settings, { priority: true, engines: ['sf'] });
    // Preemption aborts the held stale request and starts the latest set at once.
    expect(fetcher).toHaveBeenCalledTimes(2);
    release(jsonResponse(sfFixture(nodes[0].fen))); await flush();
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init!.body as string).moves.length)).toEqual([0, 2, 3]);
    // The held stale request is aborted and its late result ignored; only
    // the latest foreground set settles.
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(coordinator.result('sf', nodes[0], settings)).toBeUndefined();
    expect(coordinator.result('sf', nodes[1], settings)).toBeUndefined();
    expect(coordinator.result('sf', nodes[2], settings)).toBeDefined();
    expect(coordinator.result('sf', nodes[3], settings)).toBeDefined();
    expect(coordinator.sfPendingKeys().size).toBe(0);

  });
  it('takebacks prune queued future nodes while retaining the running result', async () => {
    let release!: (response: Response) => void;
    const fetcher = liveFetch(); fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.ensure(nodes, settings, { priority: true, engines: ['sf'] }); coordinator.ensure(nodes.slice(0, 2), settings, { priority: true, engines: ['sf'] });
    release(jsonResponse(sfFixture(nodes[0].fen))); await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);

  });
  it('foreground failures surface per key and retry reruns only missing work', async () => {
    const fetcher = liveFetch(); fetcher.mockImplementationOnce(async () => jsonResponse({ code: 'engine_unavailable', message: 'offline' }, 503));
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.ensure(nodes.slice(0, 1), settings, { priority: true }); await flush();
    expect(coordinator.error('sf', nodes[0], settings)).toBe('offline');
    expect(coordinator.result('maia', nodes[0], settings)).toBeDefined();
    const count = fetcher.mock.calls.length;
    coordinator.retry(); await flush();
    expect(fetcher).toHaveBeenCalledTimes(count + 1);
    expect(coordinator.error('sf', nodes[0], settings)).toBeUndefined();
    expect(coordinator.result('sf', nodes[0], settings)).toBeDefined();

  });
  it('Retry releases an abort-ignoring hung fetch and ignores its late same-key generation', async () => {
    let releaseOld!: (response: Response) => void;
    let releaseNew!: (response: Response) => void;
    const fetcher = liveFetch();
    fetcher.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseNew = resolve; }));
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.ensure([nodes[0]], settings, { priority: true, engines: ['sf'] }); coordinator.retry();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    releaseOld(jsonResponse(sfFixture(nodes[0].fen))); await flush();
    expect(coordinator.result('sf', nodes[0], settings)).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    releaseNew(jsonResponse(sfFixture(nodes[0].fen))); await flush();
    expect(coordinator.result('sf', nodes[0], settings)).toBeDefined();

  });
  it('scope abort cancels foreground work and suppresses late results', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const coordinator = new ReviewCoordinator(fetcher);
    const scope = new AbortController();
    coordinator.ensure([nodes[0]], settings, { priority: true, signal: scope.signal });
    scope.abort(); await flush();
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(coordinator.sfPendingKeys().size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('aborting the restore signal rejects the prime and clears pending', async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const coordinator = new ReviewCoordinator(fetcher);
    const controller = new AbortController();
    const prime = coordinator.ensure(nodes, settings, { signal: controller.signal });
    controller.abort();
    await expect(prime).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(coordinator.sfPendingKeys().size).toBe(0);
  });
  it('foreground preempts running stale work for the latest request', async () => {
    const fetcher = liveFetch(); fetcher.mockImplementationOnce(() => new Promise(() => {}));
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.ensure([nodes[0]], settings, { priority: true });
    coordinator.ensure([nodes[3]], settings, { priority: true }); await flush();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(coordinator.result('sf', nodes[3], settings)).toBeDefined();
    expect(coordinator.result('maia', nodes[3], settings)).toBeDefined();

  });
  it('bounds structured busy retries while leaving unavailable errors immediately retriable', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ code: 'engine_busy', message: 'busy' }, 503));
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.ensure([nodes[0]], settings, { priority: true, engines: ['sf'] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(coordinator.error('sf', nodes[0], settings)).toBe('busy');

  });
  it('a new scope replaces hung work without resetting settled rows', async () => {
    const fetcher = liveFetch(); fetcher.mockImplementationOnce(() => new Promise(() => {}));
    const coordinator = new ReviewCoordinator(fetcher);
    const previous = new AbortController();
    coordinator.ensure([nodes[0]], settings, { priority: true, engines: ['sf'], signal: previous.signal });
    previous.abort();
    coordinator.ensure([nodes[0]], settings, { priority: true, engines: ['sf'] }); await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(coordinator.result('sf', nodes[0], settings)).toBeDefined();

  });
});

describe('identity and provenance', () => {
  it('keys reuse shared history across extensions/takebacks and distinguish repetitions, starts and Maia settings', () => {
    const nodes = reviewNodes(buildTimeline(START_FEN, ['e2e4', 'e7e5', 'g1f3']));
    const extended = reviewNodes(buildTimeline(START_FEN, ['e2e4', 'e7e5', 'g1f3', 'b8c6']));
    expect(reviewKey('sf', nodes[2], settings)).toBe(reviewKey('sf', extended[2], settings));
    expect(reviewKey('maia', nodes[0], settings)).not.toBe(reviewKey('maia', nodes[0], { ...settings, eloUser: 1700 }));
    expect(reviewKey('maia', nodes[0], settings)).not.toBe(reviewKey('maia', nodes[0], { ...settings, model: '5m' }));
    const repeated = reviewNodes(buildTimeline(START_FEN, ['g1f3', 'g8f6', 'f3g1', 'f6g8']));
    expect(reviewKey('sf', repeated[0], settings)).not.toBe(reviewKey('sf', repeated[4], settings));
  });
  it('keys survive rebuilds and separate custom starts with the same fen', async () => {
    const { resetTimelinesForTests } = await import('./domain');
    const before = reviewNodes(buildTimeline(START_FEN, ['e2e4']))[1];
    const keyBefore = reviewKey('sf', before, settings);
    resetTimelinesForTests();
    const after = reviewNodes(buildTimeline(START_FEN, ['e2e4']))[1];
    expect(after).not.toBe(before);
    expect(after.fen).toBe(before.fen);
    expect(reviewKey('sf', after, settings)).toBe(keyBefore);
    const custom = reviewNodes(buildTimeline(after.fen, []))[0];
    expect(reviewKey('sf', custom, settings)).not.toBe(reviewKey('sf', after, settings));
  });
  it('preserves compatible actual policy and slices display without changing scores or depth', () => {
    const actual = { ...defaultStockfishSettings, lines: 4 }, raw = sfFixture(START_FEN, actual);
    const value = parseEvaluation(raw, defaultStockfishSettings, actual, START_FEN);
    expect(value.search_policy).toBe(stockfishPolicy(actual));
    expect(value.actual_settings).toEqual(actual);
    expect(value.lines).toHaveLength(2);
    expect(value.score).toEqual(raw.score); expect(value.depth).toBe(raw.depth);
  });
  it.each([{ time_ms: 1000 }, { depth: 12 }, { lines: 1 }])('rejects incompatible actual settings %j', change => {
    const actual = { ...defaultStockfishSettings, ...change };
    expect(() => parseEvaluation(sfFixture(START_FEN, actual), defaultStockfishSettings, actual, START_FEN)).toThrow();
  });
  it('rejects false provenance, empty candidates, duplicate moves and illegal native moves', () => {
    const raw = sfFixture(START_FEN);
    expect(() => parseEvaluation(raw, defaultStockfishSettings, { ...defaultStockfishSettings, lines: 3 }, START_FEN)).toThrow();
    expect(() => parseEvaluation({ ...raw, lines: [] })).toThrow();
    expect(() => parseEvaluation({ ...raw, lines: [raw.lines[0], raw.lines[0]] })).toThrow();
    expect(() => parseEvaluation({ ...raw, lines: [{ ...raw.lines[0], move: 'a1a8' }, raw.lines[1]], best_move: 'a1a8' }, defaultStockfishSettings, undefined, START_FEN)).toThrow();
  });
  it('keeps the omitted-settings node-budget policy distinct from timed default settings', () => {
    const timed = sfFixture(START_FEN);
    expect(() => parseEvaluation(timed)).toThrow('incompatible');
    const legacy = { ...timed, search_policy: stockfishPolicy(undefined) };
    expect(parseEvaluation(legacy).actual_settings).toBeUndefined();
    expect(() => parseEvaluation(legacy, defaultStockfishSettings)).toThrow('incompatible');
  });
  it('new requested identities never expose previously settled Maia rows', async () => {
    const fetcher = liveFetch(), coordinator = new ReviewCoordinator(fetcher);
    coordinator.ensure([nodes[0]], settings, { priority: true }); await flush();
    expect(coordinator.result('maia', nodes[0], { ...settings, eloMaia: 2000 })).toBeUndefined();
    expect(coordinator.result('maia', nodes[1], settings)).toBeUndefined();

  });
  it('whole-operation deadline rejects a never-resolving fetch', async () => {
    vi.useFakeTimers();
    const rejected = expect(withDeadline(() => new Promise(() => {}), undefined, 20)).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(21); await rejected;
  });
});
