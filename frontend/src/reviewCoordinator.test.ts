import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { buildTimeline, START_FEN, timelineBuildsForTests } from './domain';
import { EvaluationStore, ReviewCoordinator, fastReviewSettings, fastStockfishSettings, reviewKey, reviewNodes, parseEvaluation, type ReviewSettings } from './reviewCoordinator';
import { defaultStockfishSettings, stockfishPolicy } from './stockfishSettings';
import { jsonResponse, maiaFixture, sfFixture } from './evaluationTestFixtures';
import { hangingResponse, requestBodyText } from './testUtils';
import { withDeadline } from './evaluationTransport';

const settings: ReviewSettings = { eloMaia: 1600, eloUser: 1600, model: '79m', stockfish: defaultStockfishSettings };
const nodes = reviewNodes(buildTimeline(START_FEN, ['e2e4', 'e7e5', 'g1f3']));
const flush = async () => { for (let n = 0; n < 80; n++) await Promise.resolve(); };
function liveFetch() {
  return vi.fn<typeof fetch>(async (url, init) => {
    const body = JSON.parse(requestBodyText(init));
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
    const requests = JSON.parse(requestBodyText(init)).requests;
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
    const requests = JSON.parse(requestBodyText(fetcher.mock.calls[1][1])).requests;
    expect(requests.map((r: { engine: string; moves: string[] }) => [r.engine, r.moves.length])).toEqual([['maia', 0], ['sf', 1]]);
    expect(fetcher.mock.calls.every(([url]) => url === '/evaluations/lookup')).toBe(true);
  });
  it('prime hits report full coverage without extra requests', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => jsonResponse({ results: JSON.parse(requestBodyText(init)).requests.map((r: { engine: string; fen: string }, index: number) => ({ index, value: r.engine === 'sf' ? sfFixture(r.fen) : maiaFixture(r.fen) })) }));
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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(hangingResponse());
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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(hangingResponse());
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
    expect(fetcher.mock.calls.map(([url, init]) => [url, JSON.parse(requestBodyText(init)).requests.length])).toEqual([
      ['/evaluations/lookup', 1024], ['/evaluations/lookup', 2],
    ]);
  });
  it('overlapping restores merge: a stale line landing late still settles shared rows', async () => {
    // Play lines grow by append, so an in-flight restore for line N covers a
    // subset of line N+1. useBulkPrime no longer aborts it; both must merge.
    const line1 = reviewNodes(buildTimeline(START_FEN, ['e2e4']));
    const line2 = reviewNodes(buildTimeline(START_FEN, ['e2e4', 'e7e5']));
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const requests = JSON.parse(requestBodyText(init)).requests;
      await (requests.length <= 2 ? firstGate : secondGate);
      return jsonResponse({ results: requests.map((request: { engine: string; fen: string }, index: number) => ({ index, value: sfFixture(request.fen) })) });
    });
    const coordinator = new ReviewCoordinator(fetcher);
    const first = coordinator.ensure(line1, settings, { signal: new AbortController().signal, engines: ['sf'] });
    const second = coordinator.ensure(line2, settings, { signal: new AbortController().signal, engines: ['sf'] });
    // The new line resolves first; the stale line lands after and must still
    // settle its rows instead of being discarded.
    releaseSecond();
    expect(await second).toEqual({ covered: 3, total: 3 });
    releaseFirst();
    expect(await first).toEqual({ covered: 2, total: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const node of line2) expect(coordinator.result('sf', node, settings)).toBeDefined();
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
    // Supersede keeps the running fetch and starts the latest set at once.
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Pending stays latest-wins: the superseded running/queued keys hide.
    expect(coordinator.sfPendingKeys().size).toBe(2);
    expect(coordinator.isPending('sf', nodes[0], settings)).toBe(false);
    expect(coordinator.isPending('sf', nodes[1], settings)).toBe(false);
    expect(coordinator.isPending('sf', nodes[2], settings)).toBe(true);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    release(jsonResponse(sfFixture(nodes[0].fen))); await flush();
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(requestBodyText(init)).moves.length)).toEqual([0, 2, 3]);
    // Non-preemptive slot: the late superseded result still lands (paid for);
    // the dropped queued key never fetches.
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(coordinator.result('sf', nodes[0], settings)).toBeDefined();
    expect(coordinator.result('sf', nodes[1], settings)).toBeUndefined();
    expect(coordinator.result('sf', nodes[2], settings)).toBeDefined();
    expect(coordinator.result('sf', nodes[3], settings)).toBeDefined();
    expect(coordinator.sfPendingKeys().size).toBe(0);

  });
  it('superseded running work lands late while pending stays latest-wins', async () => {
    let releaseFirst!: (response: Response) => void;
    const fetcher = liveFetch(); fetcher.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }));
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.ensure(nodes.slice(0, 2), settings, { priority: true, engines: ['sf'] });
    coordinator.ensure(nodes.slice(2, 3), settings, { priority: true, engines: ['sf'] });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted !== true)).toBe(true);
    // Only the latest set reports pending, even though the stale fetch runs.
    expect(coordinator.isPending('sf', nodes[0], settings)).toBe(false);
    expect(coordinator.isPending('sf', nodes[1], settings)).toBe(false);
    expect(coordinator.isPending('sf', nodes[2], settings)).toBe(true);
    expect([...coordinator.sfPendingKeys()]).toHaveLength(1);
    releaseFirst(jsonResponse(sfFixture(nodes[0].fen))); await flush();
    // Late landing stores; dropped queued work never fetched.
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(requestBodyText(init)).moves.length)).toEqual([0, 2]);
    expect(coordinator.result('sf', nodes[0], settings)).toBeDefined();
    expect(coordinator.result('sf', nodes[1], settings)).toBeUndefined();
    expect(coordinator.result('sf', nodes[2], settings)).toBeDefined();
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
  it('foreground lets running stale work continue while the latest request proceeds', async () => {
    const fetcher = liveFetch(); fetcher.mockImplementationOnce(() => new Promise(() => {}));
    const coordinator = new ReviewCoordinator(fetcher);
    coordinator.ensure([nodes[0]], settings, { priority: true });
    coordinator.ensure([nodes[3]], settings, { priority: true }); await flush();
    // Non-preemptive server slot: supersede never aborts running work.
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(coordinator.result('sf', nodes[3], settings)).toBeDefined();
    expect(coordinator.result('maia', nodes[3], settings)).toBeDefined();
    // Pending stays latest-wins: the stale hung fetch hides from spinners.
    expect(coordinator.isPending('sf', nodes[0], settings)).toBe(false);
    expect(coordinator.isPending('maia', nodes[0], settings)).toBe(false);
    expect(coordinator.sfPendingKeys().size).toBe(0);
    expect(coordinator.maiaPendingKeys().size).toBe(0);

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
  it('keeps the score when a rank-1 PV tail is illegal, but rejects malformed PV shapes', () => {
    const raw = sfFixture(START_FEN);
    const illegalTail = { ...raw, lines: [{ ...raw.lines[0], pv: [raw.lines[0].move, raw.lines[0].move] }] };
    const stripped = parseEvaluation(illegalTail, defaultStockfishSettings, undefined, START_FEN);
    expect(stripped.score).toEqual(raw.score);
    expect(stripped.lines[0].pv).toBeUndefined();
    expect(() => parseEvaluation({ ...raw, lines: [{ ...raw.lines[0], pv: ['e7e5'] }] }, defaultStockfishSettings, undefined, START_FEN)).toThrow();
    expect(() => parseEvaluation({ ...raw, lines: [raw.lines[0], { ...raw.lines[1], pv: [raw.lines[1].move] }] }, defaultStockfishSettings, undefined, START_FEN)).toThrow();
  });
  it('keeps the omitted-settings node-budget policy distinct from timed default settings', () => {
    const timed = sfFixture(START_FEN);
    expect(() => parseEvaluation(timed)).toThrow('incompatible');
    const legacy = { ...timed, search_policy: stockfishPolicy(undefined) };
    expect(parseEvaluation(legacy).actual_settings).toBeUndefined();
    expect(() => parseEvaluation(legacy, defaultStockfishSettings)).toThrow('incompatible');
  });
  it('rejects non-record evaluation bodies without reading fields', () => {
    // Locks the isRecord-first narrowing in parseEvaluation: primitives and
    // arrays fail before any field access.
    for (const body of [null, undefined, 'x', 42, []]) expect(() => parseEvaluation(body)).toThrow('incomplete');
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

describe('fast-then-refine', () => {
  it('derives a 250ms MPV1 fast setting with the same depth, and no fast path when already minimal', () => {
    expect(fastStockfishSettings(defaultStockfishSettings)).toEqual({ time_ms: 250, lines: 1, depth: 0 });
    expect(fastStockfishSettings({ time_ms: 1000, lines: 3, depth: 12 })).toEqual({ time_ms: 250, lines: 1, depth: 12 });
    expect(fastStockfishSettings({ time_ms: 250, lines: 1, depth: 0 })).toBeUndefined();
    expect(fastStockfishSettings({ time_ms: 250, lines: 2, depth: 0 })).toBeUndefined();
    expect(fastStockfishSettings(undefined)).toBeUndefined();
    expect(fastReviewSettings(settings)?.stockfish).toEqual({ time_ms: 250, lines: 1, depth: 0 });
  });
  it('uses the fast MPV1 row provisionally until the full MPV2 refines', async () => {
    let releaseFull!: (response: Response) => void;
    const fullGate = new Promise<Response>(resolve => { releaseFull = resolve; });
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(requestBodyText(init));
      if (body.settings?.lines === 1) return jsonResponse(sfFixture(body.fen, body.settings));
      return fullGate;
    });
    const coordinator = new ReviewCoordinator(fetcher);
    const target = nodes[0];
    coordinator.ensure([target], settings, { priority: true, engines: ['sf'], fastFirst: true });
    await flush();
    // Fast MPV1 lands first; the full MPV2 fetch starts next on the same lane.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(requestBodyText(fetcher.mock.calls[0][1])).settings).toMatchObject({ time_ms: 250, lines: 1 });
    expect(JSON.parse(requestBodyText(fetcher.mock.calls[1][1])).settings).toMatchObject({ time_ms: 750, lines: 2 });
    expect(coordinator.result('sf', target, settings)).toBeUndefined();
    expect(coordinator.provisionalSfResult(target, settings)?.lines).toHaveLength(1);
    expect(coordinator.error('sf', target, settings)).toBeUndefined();
    releaseFull(jsonResponse(sfFixture(target.fen, defaultStockfishSettings)));
    await flush();
    expect(coordinator.result('sf', target, settings)?.lines).toHaveLength(2);
    expect(coordinator.provisionalSfResult(target, settings)?.lines).toHaveLength(2);
  });
  it('fast failure never blocks the full refine and never surfaces', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(requestBodyText(init));
      if (body.settings?.lines === 1) return jsonResponse({ code: 'engine_unavailable', message: 'offline' }, 503);
      return jsonResponse(sfFixture(body.fen, body.settings));
    });
    const coordinator = new ReviewCoordinator(fetcher);
    const target = nodes[0];
    coordinator.ensure([target], settings, { priority: true, engines: ['sf'], fastFirst: true });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(coordinator.result('sf', target, settings)?.lines).toHaveLength(2);
    expect(coordinator.error('sf', target, settings)).toBeUndefined();
    expect(coordinator.provisionalSfResult(target, settings)?.lines).toHaveLength(2);
  });
});
