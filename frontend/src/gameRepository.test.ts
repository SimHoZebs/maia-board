import { beforeEach, expect, it, vi } from 'vitest';
import { GameRepository } from './gameRepository';
import { defaultSettings, type StoredGame } from './domain';
import { KEYS } from './storage';
import { OUTBOX_KEY, MIGRATED_KEY } from './serverGames';

const game = (moves: string[] = []): StoredGame => ({ id: 'a', createdAt: '2026-09-10T00:00:00Z', settings: defaultSettings, moves });
const row = (moves: string[] = []) => ({ id: 'a', created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z', user_color: 'white', elo_maia: 1600, elo_user: 1600, model: '79m', moves });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  vi.unstubAllGlobals();
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v) });
});

it('acknowledges the exact operation while preserving a newer coalesced save', async () => {
  const held = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValue(Response.json(row(['e2e4'])));
  const repo = new GameRepository(fetcher);
  repo.save(game(), true);
  const flushing = repo.flush();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  repo.save(game(['e2e4']), true);
  held.resolve(Response.json(row()));
  await flushing;
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).moves).toEqual(['e2e4']);
  expect(repo.snapshot().pending).toHaveLength(0);
});

it('rejects a GET that predates a local save even after its acknowledgement', async () => {
  const held = deferred<Response>();
  const repo = new GameRepository(vi.fn().mockReturnValueOnce(held.promise).mockResolvedValue(Response.json(row(['e2e4']))));
  const loading = repo.refresh();
  repo.save(game(['e2e4']), true);
  await repo.flush();
  held.resolve(Response.json({ games: [row()], current_id: 'a', total: 1, next_offset: null }));
  await loading;
  expect(repo.snapshot().games[0].moves).toEqual(['e2e4']);
});

it('keeps the request-start pending overlay when a GET races its acknowledgement', async () => {
  const heldSave = deferred<Response>(); const heldGet = deferred<Response>();
  const repo = new GameRepository(vi.fn().mockReturnValueOnce(heldSave.promise).mockReturnValueOnce(heldGet.promise));
  repo.save(game(['e2e4']), true);
  const flushing = repo.flush();
  await vi.waitFor(() => expect(repo.snapshot().pending).toHaveLength(1));
  await new Promise(resolve => setTimeout(resolve, 0));
  const loading = repo.refresh();
  heldSave.resolve(Response.json(row(['e2e4'])));
  await flushing;
  heldGet.resolve(Response.json({ games: [row()], current_id: 'a', total: 1 }));
  await loading;
  expect(repo.snapshot().games[0].moves).toEqual(['e2e4']);
});

it('keeps a failed operation visible after a successful history refresh', async () => {
  const repo = new GameRepository(vi.fn().mockResolvedValueOnce(Response.json({ message: 'invalid game' }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ games: [], current_id: null, total: 0 })));
  repo.save(game(), true);
  await repo.retry();
  expect(repo.snapshot().error).toBe('invalid game');
  expect(repo.snapshot().pending).toHaveLength(1);
});

it('merges truncated pages without deletes and retrieves a current game outside the page', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ games: [], current_game: row(['e2e4']), current_id: 'a', total: 2, next_offset: 1 }))
    .mockResolvedValueOnce(Response.json({ games: [{ ...row(), id: 'older' }], current_id: 'a', total: 2, next_offset: null }));
  const repo = new GameRepository(fetcher);
  await repo.refresh();
  await repo.loadMore();
  expect(repo.snapshot().games.map(g => g.id)).toEqual(['a', 'older']);
  expect(repo.snapshot().currentId).toBe('a');
  expect(repo.snapshot().pending).toEqual([]);
  expect(fetcher.mock.calls[1][0]).toContain('offset=1');
});

it('survives offline reload and retries save-delete-save in order including resignation', async () => {
  const repo = new GameRepository(vi.fn().mockRejectedValue(new Error('offline')));
  repo.save(game(), true); repo.delete('a'); repo.save({ ...game(['e2e4']), result: 'resigned' }, true);
  await repo.flush();
  expect(repo.snapshot().error).toBeTruthy();
  const fetcher = vi.fn().mockImplementation((_url, init) => Promise.resolve(init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json(row())));
  const reloaded = new GameRepository(fetcher);
  await reloaded.flush();
  expect(fetcher.mock.calls.map(call => call[1].method)).toEqual(['POST', 'DELETE', 'POST']);
  expect(reloaded.snapshot().games[0].result).toBe('resigned');
  expect(reloaded.snapshot().pending).toEqual([]);
});

it('keeps commands in memory when durable enqueue fails and does not upload them ahead of storage', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(row(['e2e4'])));
  const repo = new GameRepository(fetcher);
  const setItem = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('quota'); };
  repo.save(game(['e2e4']), true);
  await repo.flush();
  expect(repo.snapshot().games[0].moves).toEqual(['e2e4']);
  expect(repo.snapshot().pending).toHaveLength(1);
  expect(repo.snapshot().durabilityError).toContain('quota');
  expect(fetcher).not.toHaveBeenCalled();
  localStorage.setItem = setItem;
  await repo.flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(repo.snapshot().durabilityError).toBe('');
  expect(new GameRepository().snapshot().games[0].moves).toEqual(['e2e4']);
});

it('does not upload a newer snapshot when its durable write failed during an older acknowledgement', async () => {
  const held = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValue(Response.json(row(['e2e4'])));
  const repo = new GameRepository(fetcher); repo.save(game(), true);
  const flushing = repo.flush();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const setItem = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('quota'); };
  repo.save(game(['e2e4']), true);
  held.resolve(Response.json(row())); await flushing;
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(repo.snapshot().pending[0]).toMatchObject({ game: { moves: ['e2e4'] } });
  localStorage.setItem = setItem;
  await repo.flush();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(new GameRepository().snapshot().games[0].moves).toEqual(['e2e4']);
});

it('preserves an acknowledged delete over a GET started while that delete was pending', async () => {
  const heldDelete = deferred<Response>(); const heldGet = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(heldDelete.promise).mockReturnValueOnce(heldGet.promise);
  localStorage.setItem(KEYS.saved, JSON.stringify([game()])); localStorage.setItem(MIGRATED_KEY, 'true');
  const repo = new GameRepository(fetcher); repo.delete('a'); const flushing = repo.flush();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  const loading = repo.refresh();
  heldDelete.resolve(new Response(null, { status: 204 })); await flushing;
  heldGet.resolve(Response.json({ games: [row()], current_id: 'a', total: 1 })); await loading;
  expect(repo.snapshot().games).toEqual([]);
  expect(repo.snapshot().currentId).toBeNull();
  expect(repo.snapshot().pending).toEqual([]);
});

it('migrates legacy pending operations even when the old migration marker is set', async () => {
  localStorage.setItem(KEYS.saved, JSON.stringify([game()]));
  localStorage.setItem(KEYS.current, JSON.stringify(game()));
  localStorage.setItem(MIGRATED_KEY, 'true');
  const pending = [{ op: 'delete', id: 'a' }, { op: 'save', game: game(['e2e4']), current: true }];
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(pending));
  const repo = new GameRepository(vi.fn().mockRejectedValue(new Error('offline')));
  await repo.flush();
  const restored = new GameRepository();
  expect(restored.snapshot().pending.map(({ version: _version, ...op }) => op)).toEqual(pending);
  expect(restored.snapshot().games[0].moves).toEqual(['e2e4']);
  expect(localStorage.getItem(OUTBOX_KEY)).toBe(JSON.stringify(pending));
});

it('coalesces only adjacent same-game saves and retains current-marker ordering', () => {
  const repo = new GameRepository();
  repo.save(game(), true); repo.save(game(['e2e4']), false);
  expect(repo.snapshot().pending).toHaveLength(1);
  expect(repo.snapshot().pending[0]).toMatchObject({ current: true, game: { moves: ['e2e4'] } });
  repo.save({ ...game(), id: 'b' }, true); repo.save(game(['e2e4', 'e7e5']), false);
  expect(repo.snapshot().pending).toHaveLength(3);
  expect(repo.snapshot().currentId).toBe('b');
});

it('refuses a competing tab write while retaining exportable local play', async () => {
  const first = new GameRepository(vi.fn().mockRejectedValue(new Error('offline')));
  const fetcher = vi.fn(); const second = new GameRepository(fetcher);
  first.save(game(), true); await first.flush();
  const before = localStorage.getItem('maia-board.games.v2');
  second.save(game(['e2e4']), true); await second.flush();
  expect(localStorage.getItem('maia-board.games.v2')).toBe(before);
  expect(second.snapshot().durabilityError).toContain('another tab');
  expect(JSON.parse(second.exportPending()).games[0].moves).toEqual(['e2e4']);
  expect(fetcher).not.toHaveBeenCalled();
});

it('cancels page hydration and deferred lifecycle work on cleanup', async () => {
  const fetcher = vi.fn(); const repo = new GameRepository(fetcher);
  const stop = repo.start(); stop();
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalled();
  const held = deferred<Response>(); fetcher.mockReturnValue(held.promise);
  const loading = repo.refresh();
  const stopAgain = repo.start(); stopAgain();
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  held.resolve(Response.json({ games: [row()], current_id: 'a', total: 1 }));
  await loading;
  expect(repo.snapshot().games).toEqual([]);
});

it('persists and restores legal histories beyond the inference budget', async () => {
  const moves = Array.from({ length: 260 }, (_, i) => ['g1f3', 'g8f6', 'f3g1', 'f6g8'][i % 4]);
  const fetcher = vi.fn().mockResolvedValue(Response.json(row(moves)));
  const repo = new GameRepository(fetcher);
  repo.save(game(moves), true); await repo.flush();
  expect(JSON.parse(fetcher.mock.calls[0][1].body).moves).toHaveLength(260);
  const restored = new GameRepository(fetcher);
  expect(restored.snapshot().games[0].moves).toEqual(moves);
});

it('retains malformed legacy operations for explicit recovery across reload', async () => {
  const corrupt = { op: 'save', game: { id: 'bad', moves: ['e9'] }, current: true };
  localStorage.setItem(OUTBOX_KEY, JSON.stringify([corrupt]));
  const repo = new GameRepository(); await repo.flush();
  const restored = new GameRepository();
  expect(restored.snapshot().recovery[0].value).toEqual(corrupt);
  expect(JSON.parse(restored.exportPending()).recovery[0].value).toEqual(corrupt);
  restored.discardPending(restored.snapshot().recovery[0].version);
  await restored.flush();
  expect(new GameRepository().snapshot().recovery).toEqual([]);
});

it('allows a corrected save to recover from a permanent server rejection', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ message: 'invalid game' }, { status: 400 })).mockResolvedValue(Response.json(row(['e2e4'])));
  const repo = new GameRepository(fetcher); repo.save(game(), true); await repo.flush();
  expect(repo.snapshot().failedVersion).toBe(repo.snapshot().pending[0].version);
  repo.save(game(['e2e4']), true); await repo.flush();
  expect(repo.snapshot().pending).toEqual([]);
  expect(repo.snapshot().error).toBe('');
  expect(repo.snapshot().failedVersion).toBeNull();
});

it('serializes cross-tab remote mutations with Web Locks', async () => {
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', { locks: { request: (name: string, work: () => Promise<unknown>) => {
    const next = (queues.get(name) ?? Promise.resolve()).then(work);
    queues.set(name, next.catch(() => {}));
    return next;
  } } });
  const held = deferred<Response>();
  const firstFetch = vi.fn().mockReturnValue(held.promise);
  const first = new GameRepository(firstFetch); first.save(game(), true);
  const firstFlush = first.flush();
  await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledTimes(1));
  const secondFetch = vi.fn().mockResolvedValue(Response.json(row(['e2e4'])));
  const second = new GameRepository(secondFetch); second.save(game(['e2e4']), true);
  const secondFlush = second.flush();
  await Promise.resolve();
  expect(secondFetch).not.toHaveBeenCalled();
  held.resolve(Response.json(row()));
  await Promise.all([firstFlush, secondFlush]);
  expect(secondFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(secondFetch.mock.calls[0][1].body).moves).toEqual(['e2e4']);
  expect(new GameRepository().snapshot().games[0].moves).toEqual(['e2e4']);
});

it('detects another tab changing the document during repository construction', async () => {
  const empty = JSON.stringify({ schema: 2, games: [], currentId: null, pending: [], recovery: [] });
  const newer = JSON.stringify({ schema: 2, games: [game(['e2e4'])], currentId: 'a', pending: [], recovery: [] });
  let reads = 0;
  localStorage.getItem = key => key === 'maia-board.games.v2' ? (++reads === 1 ? empty : newer) : null;
  const set = vi.fn(); localStorage.setItem = set;
  const repo = new GameRepository(); await repo.flush();
  expect(set).not.toHaveBeenCalled();
  expect(repo.snapshot().conflict).toBe(true);
});

it('keeps legacy deletes authoritative through migration and subsequent reload', async () => {
  localStorage.setItem(KEYS.saved, JSON.stringify([game()]));
  localStorage.setItem(KEYS.current, JSON.stringify(game()));
  localStorage.setItem(OUTBOX_KEY, JSON.stringify([{ op: 'delete', id: 'a' }]));
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const repo = new GameRepository(fetcher); await repo.flush();
  expect(fetcher.mock.calls.map(call => call[1].method)).toEqual(['DELETE']);
  const restored = new GameRepository();
  expect(restored.snapshot().games).toEqual([]);
  expect(restored.snapshot().pending).toEqual([]);
});

it('normalizes legacy operation games before exposing or uploading them', async () => {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify([{ op: 'save', game: { id: 'a', moves: ['e2e4'] }, current: true }]));
  const fetcher = vi.fn().mockResolvedValue(Response.json(row(['e2e4'])));
  const repo = new GameRepository(fetcher);
  expect(repo.snapshot().games[0].settings).toMatchObject({ userColor: 'white', model: '79m', temperature: 0 });
  await repo.flush();
  expect(repo.snapshot().pending).toEqual([]);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ model: '79m', user_color: 'white' });
});

it('requires the exact selected operation to be durable before uploading', async () => {
  const setItem = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === 'maia-board.games.v2' && JSON.parse(value).games[0]?.moves.length) throw new Error('quota on newer snapshot');
    return setItem(key, value);
  };
  const fetcher = vi.fn().mockResolvedValue(Response.json(row(['e2e4'])));
  const repo = new GameRepository(fetcher);
  repo.save(game(), true); const flushing = repo.flush();
  repo.save(game(['e2e4']), true);
  await flushing;
  expect(fetcher).not.toHaveBeenCalled();
  expect(repo.snapshot().pending[0]).toMatchObject({ game: { moves: ['e2e4'] } });
});
