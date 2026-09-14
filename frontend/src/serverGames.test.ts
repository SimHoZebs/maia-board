import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type StoredGame } from './domain';
import {
  deleteRemote, fetchGames, isMigrated, loadOutbox, markMigrated, mergeSync, migrationOps,
  pushOutbox, saveRemote, storeOutbox, toStoredGame, type OutboxOp,
} from './serverGames';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) });
});

const game = (id: string, moves: string[] = []): StoredGame => ({ id, createdAt: '2026-09-10T00:00:00Z', moves, settings: { ...defaultSettings } });
const row = (id: string, moves: string[] = []) => ({
  id, created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z',
  user_color: 'white', elo_maia: 1600, elo_user: 1400, model: '79m', moves,
});

describe('server mapping', () => {
  it('round-trips stored games and rejects invalid rows', () => {
    expect(toStoredGame(row('a', ['e2e4']))).toMatchObject({ id: 'a', moves: ['e2e4'] });
    expect(toStoredGame({ ...row('b'), moves: ['e9'] })).toBeUndefined();
    // Unknown colors coerce like other legacy settings; the server never sends them.
    expect(toStoredGame({ ...row('c'), user_color: 'green' })).toMatchObject({ settings: { userColor: 'white' } });
  });
  it('round-trips resignation results', () => {
    expect(toStoredGame({ ...row('r', ['e2e4']), result: 'resigned' })).toMatchObject({ id: 'r', result: 'resigned' });
    expect(toStoredGame({ ...row('u', ['e2e4']), result: 'unknown-future' })).toMatchObject({ id: 'u' });
    expect(toStoredGame({ ...row('u', ['e2e4']), result: 'unknown-future' })?.result).toBeUndefined();
  });
  it('fetches lists, saves, and deletes with server errors preserved', async () => {
    const list = { games: [row('a')], current_id: 'a', total: 1 };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(list))
      .mockResolvedValueOnce(Response.json(row('b', ['e2e4'])))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ code: 'invalid_elo', message: 'bad elo' }, { status: 400 }));
    await expect(fetchGames(fetchImpl)).resolves.toEqual(list);
    await expect(saveRemote(game('b', ['e2e4']), true, fetchImpl)).resolves.toMatchObject({ id: 'b' });
    await expect(deleteRemote('b', fetchImpl)).resolves.toBeUndefined();
    await expect(saveRemote(game('c'), false, fetchImpl)).rejects.toMatchObject({ code: 'invalid_elo' });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/games?limit=500', expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/games', expect.objectContaining({ method: 'POST' }));
    expect(fetchImpl).toHaveBeenNthCalledWith(3, '/games/b', expect.objectContaining({ method: 'DELETE' }));
    await expect(fetchGames(vi.fn().mockRejectedValue(new Error('down')))).rejects.toMatchObject({ code: 'server_unreachable' });
  });
  it('treats delete of unknown games as success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(deleteRemote('missing', fetchImpl)).resolves.toBeUndefined();
  });
});

describe('outbox', () => {
  it('persists ops across reloads and validates on read', () => {
    expect(loadOutbox()).toEqual([]);
    pushOutbox({ op: 'save', game: game('a'), current: true });
    pushOutbox({ op: 'delete', id: 'b' });
    localStorage.setItem('maia-board.outbox.v1', '[{"op":"save","game":{"id":1}}]');
    expect(loadOutbox()).toEqual([]);
    storeOutbox([{ op: 'delete', id: 'b' }]);
    expect(loadOutbox()).toEqual([{ op: 'delete', id: 'b' }]);
  });
  it('tracks migration exactly once', () => {
    expect(isMigrated()).toBe(false);
    markMigrated();
    expect(isMigrated()).toBe(true);
  });
  it('collapses consecutive saves for the same game to the latest snapshot', () => {
    pushOutbox({ op: 'save', game: game('a', ['e2e4']), current: true });
    pushOutbox({ op: 'save', game: game('a', ['e2e4', 'e7e5']), current: false });
    pushOutbox({ op: 'save', game: game('a', ['e2e4', 'e7e5', 'g1f3']), current: false });
    const ops = loadOutbox();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ op: 'save', game: game('a', ['e2e4', 'e7e5', 'g1f3']), current: true });
  });
  it('breaks coalescing runs on deletes and foreign ids', () => {
    pushOutbox({ op: 'save', game: game('a', ['e2e4']), current: false });
    pushOutbox({ op: 'save', game: game('b', ['d2d4']), current: false });
    pushOutbox({ op: 'save', game: game('a', ['e2e4', 'e7e5']), current: false });
    expect(loadOutbox()).toHaveLength(3);
    pushOutbox({ op: 'delete', id: 'a' });
    pushOutbox({ op: 'save', game: game('a', ['e2e4']), current: true });
    const ops = loadOutbox();
    expect(ops).toEqual([
      { op: 'save', game: game('a', ['e2e4']), current: false },
      { op: 'save', game: game('b', ['d2d4']), current: false },
      { op: 'save', game: game('a', ['e2e4', 'e7e5']), current: false },
      { op: 'delete', id: 'a' },
      { op: 'save', game: game('a', ['e2e4']), current: true },
    ]);
    // Collapsed runs merge identically to their uncollapsed form.
    expect(mergeSync([], null, ops).currentId).toBe('a');
  });
  it('merges a collapsed run exactly like its uncollapsed equivalent', () => {
    pushOutbox({ op: 'save', game: game('a', ['e2e4']), current: false });
    pushOutbox({ op: 'save', game: game('a', ['e2e4', 'e7e5']), current: true });
    pushOutbox({ op: 'save', game: game('a', ['e2e4', 'e7e5', 'g1f3']), current: false });
    const uncollapsed: OutboxOp[] = [
      { op: 'save', game: game('a', ['e2e4']), current: false },
      { op: 'save', game: game('a', ['e2e4', 'e7e5']), current: true },
      { op: 'save', game: game('a', ['e2e4', 'e7e5', 'g1f3']), current: false },
    ];
    expect(mergeSync([], null, loadOutbox())).toEqual(mergeSync([], null, uncollapsed));
  });
});

describe('mergeSync', () => {
  const saved = [game('a', ['e2e4']), game('b')];
  it('prefers server state with no pending ops', () => {
    expect(mergeSync(saved, 'b', [])).toEqual({ saved, currentId: 'b' });
    expect(mergeSync(saved, 'missing', [])).toEqual({ saved, currentId: null });
  });
  it('applies pending saves, deletes, and markers in order', () => {
    const pending: OutboxOp[] = [
      { op: 'save', game: game('c', ['d2d4']), current: false },
      { op: 'delete', id: 'a' },
      { op: 'save', game: game('b', ['e2e4']), current: true },
    ];
    const merged = mergeSync(saved, 'a', pending);
    expect(merged.saved.map(item => item.id)).toEqual(['b', 'c']);
    expect(merged.saved[0].moves).toEqual(['e2e4']);
    expect(merged.currentId).toBe('b');
  });
  it('clears the marker when its game is deleted', () => {
    expect(mergeSync(saved, 'a', [{ op: 'delete', id: 'a' }])).toEqual({ saved: [game('b')], currentId: null });
  });
});

describe('migrationOps', () => {
  it('enqueues oldest first with the live game last and current', () => {
    const current = game('live', ['e2e4']);
    const ops = migrationOps([game('new'), game('old'), current], current);
    expect(ops).toEqual([
      { op: 'save', game: game('old'), current: false },
      { op: 'save', game: game('new'), current: false },
      { op: 'save', game: current, current: true },
    ]);
  });
  it('dedups the live game and handles empty libraries', () => {
    expect(migrationOps([], null)).toEqual([]);
    expect(migrationOps([], game('live'))).toEqual([{ op: 'save', game: game('live'), current: true }]);
  });
});
