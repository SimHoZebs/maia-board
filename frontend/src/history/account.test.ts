import { describe, expect, it, vi } from 'vitest';
import { bulkImport, fetchMe, loginLocal, startLichessLogin } from './account';

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
    const result = await bulkImport(games, fetchImpl);
    expect(result.saved).toHaveLength(2);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url) === '/imports/games')).toHaveLength(2);
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
});
