import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../shared/domain';
import { computeUserElo } from './userElo';
import {
  LICHESS_SYNC_TTL_MS,
  downloadLichessGames,
  fetchLichessProfile,
  formatSyncAge,
  isLichessCacheStale,
  lichessEloRevisionForTests,
  loadLichessEloBasis,
  loadLichessEloCache,
  matchingLichessCache,
  normalizeLichessEloBasis,
  pickMostPlayedPerf,
  resolveEloBasis,
  saveLichessEloBasis,
  saveLichessEloCache,
  syncLichessElo,
  toImportPayload,
} from './lichessSync';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  });
});

function profileResponse(perfs: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ id: 'alice', username: 'Alice', perfs }),
  } as unknown as Response;
}

describe('pickMostPlayedPerf', () => {
  it('picks the standard pool with the most games', () => {
    const perfs = {
      blitz: { games: 412, rating: 1823 },
      rapid: { games: 120, rating: 1700 },
      bullet: { games: 30, rating: 1900 },
      puzzle: { games: 5000, rating: 2100 },
    };
    expect(pickMostPlayedPerf(perfs)).toEqual({ key: 'blitz', rating: 1823, games: 412 });
  });
  it('breaks ties toward longer controls and falls back past candidates', () => {
    expect(
      pickMostPlayedPerf({ blitz: { games: 10, rating: 1500 }, rapid: { games: 10, rating: 1600 } })
        ?.key,
    ).toBe('blitz');
    expect(pickMostPlayedPerf({ chess960: { games: 5, rating: 1500 } })?.key).toBe('chess960');
    expect(pickMostPlayedPerf({ blitz: { games: 0, rating: 1500 } })).toBeUndefined();
    expect(pickMostPlayedPerf(null)).toBeUndefined();
  });
});

describe('cache staleness', () => {
  const cache = {
    username: 'Alice',
    rating: 1800,
    perf: 'blitz',
    games: 100,
    basis: 'auto' as const,
    fetchedAt: 1_000_000,
  };
  it('treats missing, foreign, fresh, and hourly-stale entries', () => {
    expect(isLichessCacheStale(null, 'alice')).toBe(true);
    expect(isLichessCacheStale(cache, 'bob', 1_000_001)).toBe(true);
    expect(isLichessCacheStale(cache, 'alice', 1_000_001)).toBe(false);
    expect(isLichessCacheStale(cache, 'ALICE', cache.fetchedAt + LICHESS_SYNC_TTL_MS)).toBe(true);
    expect(isLichessCacheStale(cache, '', 1_000_001)).toBe(true);
  });
  it('goes stale when the basis changes', () => {
    expect(isLichessCacheStale(cache, 'alice', 1_000_001, 'auto')).toBe(false);
    expect(isLichessCacheStale(cache, 'alice', 1_000_001, 'rapid')).toBe(true);
  });
  it('round-trips through storage and matches case-insensitively', () => {
    saveLichessEloCache(cache);
    expect(loadLichessEloCache()).toEqual(cache);
    expect(matchingLichessCache(loadLichessEloCache(), 'alice')).toEqual(cache);
    expect(matchingLichessCache(loadLichessEloCache(), 'bob')).toBeNull();
    expect(formatSyncAge(cache.fetchedAt, cache.fetchedAt + 20 * 60000)).toBe('20m ago');
  });
});

describe('manual time-control basis', () => {
  const perfs = { blitz: { games: 412, rating: 1823 }, rapid: { games: 10, rating: 1500 } };
  it('pins the baseline to the chosen pool', () => {
    expect(resolveEloBasis(perfs, 'rapid')).toEqual({
      key: 'rapid',
      rating: 1500,
      games: 10,
      fellBack: false,
    });
    expect(resolveEloBasis(perfs, 'auto')).toMatchObject({ key: 'blitz', fellBack: false });
  });
  it('falls back to most-played when the pinned pool is unrated', () => {
    expect(resolveEloBasis(perfs, 'bullet')).toMatchObject({ key: 'blitz', fellBack: true });
    expect(resolveEloBasis({}, 'rapid')).toBeUndefined();
  });
  it('defaults unknown stored values to auto', () => {
    expect(normalizeLichessEloBasis('hyperbullet')).toBe('auto');
    expect(normalizeLichessEloBasis('rapid')).toBe('rapid');
    expect(loadLichessEloBasis()).toBe('auto');
    saveLichessEloBasis('classical');
    expect(loadLichessEloBasis()).toBe('classical');
  });
  it('syncs the pinned basis into the cache', async () => {
    const fetchImpl = (async () => profileResponse(perfs)) as typeof fetch;
    const cache = await syncLichessElo('Alice', fetchImpl, 3_000_000, 'rapid');
    expect(cache).toMatchObject({ username: 'Alice', rating: 1500, perf: 'rapid', basis: 'rapid' });
    const fellBack = await syncLichessElo('Alice', fetchImpl, 4_000_000, 'bullet');
    expect(fellBack).toMatchObject({ perf: 'blitz', basis: 'bullet' });
  });
});

describe('profile fetch + sync', () => {
  it('syncs the most-played rating into the anchor and cache', async () => {
    const fetchImpl = (async () =>
      profileResponse({
        blitz: { games: 412, rating: 1823 },
        rapid: { games: 10, rating: 1500 },
      })) as typeof fetch;
    const before = lichessEloRevisionForTests();
    const cache = await syncLichessElo('Alice', fetchImpl, 2_000_000);
    expect(cache).toMatchObject({
      username: 'Alice',
      rating: 1823,
      perf: 'blitz',
      fetchedAt: 2_000_000,
    });
    expect(loadLichessEloCache()).toEqual(cache);
    expect(lichessEloRevisionForTests()).toBeGreaterThan(before);
  });
  it('reports unknown users and empty rated pools', async () => {
    const missing = (async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(fetchLichessProfile('ghost', missing)).rejects.toMatchObject({
      code: 'not_found',
    });
    const unrated = (async () =>
      profileResponse({ blitz: { games: 0, rating: 1500 } })) as typeof fetch;
    await expect(fetchLichessProfile('alice', unrated)).rejects.toMatchObject({
      code: 'no_rated_games',
    });
  });
});

describe('game download mapping', () => {
  const line = (id: string, white: string, black: string) =>
    JSON.stringify({
      id,
      pgn: '1. e4 e5 2. Nf3 Nc6',
      createdAt: 1_000_000,
      winner: 'white',
      status: 'mate',
      players: {
        white: { rating: 1800, user: { id: white } },
        black: { rating: 1700, user: { id: black } },
      },
    });
  it('maps colors, ratings, and resignations with lichess sources', () => {
    expect(toImportPayload(JSON.parse(line('abcd1234', 'alice', 'bob')), 'alice')).toMatchObject({
      user_color: 'white',
      elo_maia: 1700,
      elo_user: 1800,
      source: 'lichess:abcd1234',
      opponent: 'bob',
    });
    expect(toImportPayload(JSON.parse(line('efgh5678', 'alice', 'bob')), 'BOB')).toMatchObject({
      user_color: 'black',
      opponent: 'alice',
    });
    expect(toImportPayload({ pgn: '' }, 'alice')).toBeUndefined();
    expect(toImportPayload(JSON.parse(line('zzzz', 'carol', 'dave')), 'alice')).toBeUndefined();
  });
  it('prefers PGN header names for opponent display case', () => {
    const tagged = JSON.stringify({
      id: 'hhhh9999',
      pgn: '[White "Alice Cooper"]\n[Black "Bob Marley"]\n\n1. e4 e5',
      createdAt: 1_000_000,
      players: {
        white: { rating: 1800, user: { id: 'alice' } },
        black: { rating: 1700, user: { id: 'bob' } },
      },
    });
    expect(toImportPayload(JSON.parse(tagged), 'alice')).toMatchObject({ opponent: 'Bob Marley' });
  });
  it('captures the mover ratingDiff for the user side only', () => {
    const withDiff = JSON.stringify({
      id: 'diff0001',
      pgn: '1. e4 e5',
      createdAt: 1_000_000,
      winner: 'black',
      status: 'mate',
      players: {
        white: { rating: 1800, ratingDiff: -7, user: { id: 'alice' } },
        black: { rating: 1700, ratingDiff: 12, user: { id: 'bob' } },
      },
    });
    expect(toImportPayload(JSON.parse(withDiff), 'alice')).toMatchObject({ rating_diff: -7 });
    expect(toImportPayload(JSON.parse(withDiff), 'bob')).toMatchObject({ rating_diff: 12 });
    const badDiff = JSON.stringify({
      id: 'diff0002',
      pgn: '1. e4 e5',
      createdAt: 1_000_000,
      players: {
        white: { rating: 1800, ratingDiff: 5000, user: { id: 'alice' } },
        black: { rating: 1700, user: { id: 'bob' } },
      },
    });
    expect(toImportPayload(JSON.parse(badDiff), 'alice')).not.toHaveProperty('rating_diff');
    expect(
      toImportPayload(JSON.parse(line('abcd1234', 'alice', 'bob')), 'alice'),
    ).not.toHaveProperty('rating_diff');
  });
  it('downloads ndjson and counts skipped lines', async () => {
    const body = `${line('aaaa1111', 'alice', 'bob')}\nnot json\n\n${line('bbbb2222', 'alice', 'bob')}`;
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      body: true,
      text: async () => body,
    })) as unknown as typeof fetch;
    const { payloads, skipped } = await downloadLichessGames('alice', undefined, fetchImpl);
    expect(payloads).toHaveLength(2);
    expect(skipped).toBe(1);
  });
});

describe('lichess games skip the local replay', () => {
  it('counts local games only once imports carry sources', () => {
    const mate = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
    const anchor = { value: 1800, updatedAt: '2026-01-01T00:00:00.000Z' };
    const games = [
      {
        id: 'import',
        createdAt: '2026-01-02T00:00:00.000Z',
        moves: mate,
        settings: { ...defaultSettings, userColor: 'white' as const, botElo: 800 },
        result: undefined,
        source: 'lichess:aaaa1111',
      },
      {
        id: 'local',
        createdAt: '2026-01-03T00:00:00.000Z',
        moves: mate,
        settings: { ...defaultSettings, userColor: 'black' as const, botElo: 800 },
        result: undefined,
      },
    ];
    const summary = computeUserElo(anchor, games);
    expect(summary.counted).toBe(1);
  });
});
