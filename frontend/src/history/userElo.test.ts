import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../shared/domain';
import { computeUserElo, DEFAULT_USER_ELO, expectedScore, normalizeAnchor, normalizeUserElo, scoreForGame, updateUserElo } from './userElo';
import { KEYS } from './storage';

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) });
});

it('defaults to a 400 baseline and clamps stored values', () => {
  expect(DEFAULT_USER_ELO).toBe(400);
  expect(defaultSettings.userElo).toBe(400);
  expect(normalizeUserElo(undefined)).toBe(400);
  expect(normalizeUserElo(1675.4)).toBe(1675);
  expect(normalizeUserElo(1675.5)).toBe(1676);
  expect(normalizeUserElo(-10)).toBe(0);
  expect(normalizeUserElo(9000)).toBe(5000);
  expect(normalizeAnchor(null)).toEqual({ value: 400, updatedAt: new Date(0).toISOString() });
  expect(normalizeAnchor({ value: 1500, updatedAt: '2026-01-02T00:00:00.000Z' })).toEqual({ value: 1500, updatedAt: '2026-01-02T00:00:00.000Z' });
});

it('scores equal opponents at half and updates with K=32', () => {
  expect(expectedScore(1600, 1600)).toBeCloseTo(0.5, 10);
  expect(updateUserElo(1600, 1600, 1)).toBe(1616);
  expect(updateUserElo(1600, 1600, 0)).toBe(1584);
  expect(updateUserElo(1600, 1600, 0.5)).toBe(1600);
  // 400-point underdog winning gains near the full K value.
  expect(updateUserElo(400, 800, 1)).toBe(429);
});

it('scores finished games from the user side and skips unfinished lines', () => {
  const mate = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
  expect(scoreForGame({ moves: mate, settings: { ...defaultSettings, userColor: 'white' }, result: undefined })).toBe(0);
  expect(scoreForGame({ moves: mate, settings: { ...defaultSettings, userColor: 'black' }, result: undefined })).toBe(1);
  expect(scoreForGame({ moves: ['e2e4'], settings: { ...defaultSettings, userColor: 'white' }, result: undefined })).toBeNull();
  expect(scoreForGame({ moves: ['e2e4'], settings: { ...defaultSettings, userColor: 'white' }, result: 'resigned' })).toBe(0);
  const repetition = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'];
  expect(scoreForGame({ moves: repetition, settings: { ...defaultSettings, userColor: 'white' }, result: undefined })).toBe(0.5);
});

it('replays games since the anchor in time order', () => {
  const anchor = { value: 400, updatedAt: '2026-01-01T00:00:00.000Z' };
  const mate = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
  const games = [
    // Before the anchor: ignored even though it is a win.
    { id: 'old', createdAt: '2025-12-31T00:00:00.000Z', moves: mate, settings: { ...defaultSettings, userColor: 'black' as const, botElo: 800 }, result: undefined },
    // Unfinished: ignored.
    { id: 'live', createdAt: '2026-01-02T00:00:00.000Z', moves: ['e2e4'], settings: { ...defaultSettings, userColor: 'white' as const, botElo: 800 }, result: undefined },
    // User (black) mates an 800 bot as a 400 player: +29.
    { id: 'win', createdAt: '2026-01-03T00:00:00.000Z', moves: mate, settings: { ...defaultSettings, userColor: 'black' as const, botElo: 800 }, result: undefined },
  ];
  const summary = computeUserElo(anchor, games);
  expect(summary.counted).toBe(1);
  expect(summary.wins).toBe(1);
  expect(summary.rating).toBe(updateUserElo(400, 800, 1));
  void KEYS;
});
