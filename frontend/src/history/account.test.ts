import { describe, expect, it, vi } from 'vitest';
import { bulkImport, fetchMe, importStatus, loginLocal, startLichessLogin, unownedGamesCount } from './account';

function jsonResponse(body: unknown, status = 200, cookies: string[] = []) {
  return {
    ok: status >= 200 && status < 300, status,
    json: async () => body,
    headers: { get: (name: string) => name.toLowerCase() === 'set-cookie' ? cookies.join(', ') : null },
  } as unknown as Response;
}

describe('account client', () => {
  it('returns null when logged out or disabled', async () => {
    await expect(fetchMe(async () => jsonResponse({}, 401))).resolves.toBeNull();
    await expect(fetchMe(async () => jsonResponse({}, 503))).resolves.toBeNull();
  });

  it('logs in and chunks bulk imports', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/auth/local') return jsonResponse({ id: 'u1', created_at: '2024-01-01T00:00:00Z', display_name: 'Alice' });
      if (url === '/imports/games') return jsonResponse({ saved: [{ id: 'g1' }], errors: {} });
      throw new Error('unexpected ' + url);
    });
    const user = await loginLocal('Alice', fetchImpl);
    expect(user.id).toBe('u1');
    const games = Array.from({ length: 55 }, (_, index) => ({
      user_color: 'white', elo_maia: 1500, elo_user: 1300, model: '79m', moves: ['e2e4'], created_at: `2024-01-${String(index % 28 + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const result = await bulkImport(games, undefined, fetchImpl);
    expect(result.saved).toHaveLength(1);
    expect(result.skipped).toBe(0);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url) === '/imports/games')).toHaveLength(1);
  });

  it('follows the authorization url instead of showing the start json', async () => {
    const assigned: string[] = [];
    vi.stubGlobal('window', { location: { origin: 'https://x.test', assign: (url: string) => { assigned.push(url); } } });
    try {
      const fetchImpl = (async () => jsonResponse({ authorization_url: 'https://lichess.org/oauth?x=1', state: 's' })) as typeof fetch;
      await startLichessLogin(fetchImpl);
      expect(assigned).toEqual(['https://lichess.org/oauth?x=1']);
      const failing = (async () => jsonResponse({}, 501)) as typeof fetch;
      await expect(startLichessLogin(failing)).rejects.toThrow('not configured');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads the unowned count for the claim gate', async () => {
    await expect(unownedGamesCount(async () => jsonResponse({ unowned: 3 }))).resolves.toBe(3);
    await expect(unownedGamesCount(async () => jsonResponse({}, 401))).rejects.toThrow('Adoption check failed');
  });

  it('reads import status with last run and total', async () => {
    const last = { id: 'r1', user_id: 'u1', provider: 'lichess', username: 'bob', requested: 10, saved: 8, skipped: 2, created_at: '2024-05-01T00:00:00Z' };
    await expect(importStatus(async () => jsonResponse({ last, total: 42 }))).resolves.toEqual({ last, total: 42 });
    await expect(importStatus(async () => jsonResponse({ last: null, total: 0 }))).resolves.toEqual({ last: null, total: 0 });
  });

  it('sends provider runs and sums skipped duplicates', async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return jsonResponse({ saved: [], errors: {}, skipped: 2 });
    }) as typeof fetch;
    const result = await bulkImport([{ user_color: 'white', elo_maia: 1, elo_user: 1, model: '79m', moves: [] }], { provider: 'lichess', username: 'bob' }, fetchImpl);
    expect(result.skipped).toBe(2);
    expect(seen[0]).toMatchObject({ provider: 'lichess', username: 'bob' });
  });
});
