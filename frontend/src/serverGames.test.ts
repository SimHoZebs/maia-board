import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type StoredGame } from './domain';
import {
  deleteRemote, fetchGames, mergeSync,
  saveRemote, toStoredGame, type OutboxOp,
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
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/games?limit=100&offset=0', expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/games', expect.objectContaining({ method: 'POST' }));
    expect(fetchImpl).toHaveBeenNthCalledWith(3, '/games/b', expect.objectContaining({ method: 'DELETE' }));
    await expect(fetchGames(vi.fn().mockRejectedValue(new Error('down')))).rejects.toMatchObject({ code: 'server_unreachable' });
  });
  it('treats delete of unknown games as success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(deleteRemote('missing', fetchImpl)).resolves.toBeUndefined();
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

// The v1 outbox/marker one-time import was deleted with the live migration
// branch; its documented script lives on the OutboxOp declaration in
// serverGames.ts.
