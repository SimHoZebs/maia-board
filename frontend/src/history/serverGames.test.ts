import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type StoredGame } from '../shared/domain';
import {
  deleteRemote,
  fetchGames,
  mergeSync,
  saveRemote,
  toStoredGame,
  type OutboxOp,
} from './serverGames';

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  });
});

const game = (id: string, moves: string[] = []): StoredGame => ({
  id,
  createdAt: '2026-09-10T00:00:00Z',
  moves,
  settings: { ...defaultSettings },
});
const row = (id: string, moves: string[] = []) => ({
  id,
  created_at: '2026-09-10T00:00:00Z',
  updated_at: '2026-09-10T00:00:00Z',
  user_color: 'white',
  elo_maia: 1600,
  elo_user: 1400,
  model: '79m',
  moves,
  temperature: 0,
});

describe('server mapping', () => {
  it('round-trips stored games and rejects invalid rows', () => {
    expect(toStoredGame(row('a', ['e2e4']))).toMatchObject({ id: 'a', moves: ['e2e4'] });
    expect(toStoredGame({ ...row('b'), moves: ['e9'] })).toBeUndefined();
    // Unknown colors coerce like other legacy settings; the server never sends them.
    expect(toStoredGame({ ...row('c'), user_color: 'green' })).toMatchObject({
      settings: { userColor: 'white' },
    });
  });
  it('round-trips resignation results', () => {
    expect(toStoredGame({ ...row('r', ['e2e4']), result: 'resigned' })).toMatchObject({
      id: 'r',
      result: 'resigned',
    });
    expect(toStoredGame({ ...row('u', ['e2e4']), result: 'unknown-future' })).toMatchObject({
      id: 'u',
    });
    expect(
      toStoredGame({ ...row('u', ['e2e4']), result: 'unknown-future' })?.result,
    ).toBeUndefined();
  });
  it('preserves lichess sources so the Elo replay can skip imports', () => {
    expect(toStoredGame({ ...row('l', ['e2e4']), source: 'lichess:abcd1234' })).toMatchObject({
      id: 'l',
      source: 'lichess:abcd1234',
    });
    expect(toStoredGame(row('n', ['e2e4']))).toMatchObject({ source: 'local' });
    expect(toStoredGame(row('n', ['e2e4']))).toMatchObject({ opponent: 'Maia 1600' });
  });
  it('round-trips lichess rating diffs and drops out-of-range values', () => {
    expect(toStoredGame({ ...row('d', ['e2e4']), rating_diff: 12 })?.ratingDiff).toBe(12);
    expect(toStoredGame({ ...row('e', ['e2e4']), rating_diff: -5 })?.ratingDiff).toBe(-5);
    expect(toStoredGame({ ...row('f', ['e2e4']), rating_diff: 5000 })?.ratingDiff).toBeUndefined();
    expect(toStoredGame(row('g', ['e2e4']))?.ratingDiff).toBeUndefined();
  });
  it('round-trips time controls and drops unknown pools', () => {
    expect(
      toStoredGame({ ...row('t', ['e2e4']), time_control: '300+3', speed: 'blitz' }),
    ).toMatchObject({ timeControl: '300+3', speed: 'blitz' });
    const dropped = toStoredGame({
      ...row('u', ['e2e4']),
      time_control: 'junk',
      speed: 'hyperbullet',
    });
    expect(dropped?.timeControl).toBeUndefined();
    expect(dropped?.speed).toBeUndefined();
    expect(toStoredGame(row('v', ['e2e4']))?.timeControl).toBeUndefined();
  });
  it('round-trips per-ply readings and drops misshapen arrays', () => {
    expect(toStoredGame({ ...row('c', ['e2e4', 'e7e5']), clocks: [18000, 17950] })?.clocks).toEqual(
      [18000, 17950],
    );
    expect(toStoredGame({ ...row('d', ['e2e4']), clocks: [18000, -5] })?.clocks).toBeUndefined();
    expect(
      toStoredGame({ ...row('e', ['e2e4']), clocks: 'soon' as unknown as number[] })?.clocks,
    ).toBeUndefined();
    expect(toStoredGame(row('f', ['e2e4']))?.clocks).toBeUndefined();
  });
  it('fetches lists, saves, and deletes with server errors preserved', async () => {
    const list = {
      games: [row('a')],
      current_id: 'a',
      current_game: row('a'),
      total: 1,
      next_offset: null,
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json(list))
      .mockResolvedValueOnce(Response.json(row('b', ['e2e4'])))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            title: 'Bad Request',
            status: 400,
            detail: 'bad elo',
            errors: [{ message: 'invalid_elo' }],
          },
          { status: 400 },
        ),
      );
    await expect(fetchGames(fetchImpl)).resolves.toEqual(list);
    await expect(saveRemote(game('b', ['e2e4']), true, fetchImpl)).resolves.toMatchObject({
      id: 'b',
    });
    await expect(deleteRemote('b', fetchImpl)).resolves.toBeUndefined();
    await expect(saveRemote(game('c'), false, fetchImpl)).rejects.toMatchObject({
      code: 'invalid_elo',
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/games?limit=100&offset=0', expect.anything());
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      '/games',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      '/games/b',
      expect.objectContaining({ method: 'DELETE' }),
    );
    await expect(fetchGames(vi.fn().mockRejectedValue(new Error('down')))).rejects.toMatchObject({
      code: 'server_unreachable',
    });
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
    expect(mergeSync(saved, 'a', [{ op: 'delete', id: 'a' }])).toEqual({
      saved: [game('b')],
      currentId: null,
    });
  });
});

// The v1 outbox/marker one-time import was deleted with the live migration
// branch; its documented script lives on the OutboxOp declaration in
// serverGames.ts.
