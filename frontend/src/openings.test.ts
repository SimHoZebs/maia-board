import { describe, expect, it } from 'vitest';
import { fetchLineOpenings, openingAt, type OpeningMatch } from './openings';

const matches: OpeningMatch[] = [
  { ply: 1, eco: 'B00', name: 'Test Opening' },
  { ply: 3, eco: 'C50', name: 'Test Opening: Variation' },
];

describe('openingAt', () => {
  it('returns the deepest named ancestor at or before the viewed ply', () => {
    expect(openingAt(matches, 1)).toEqual({ eco: 'B00', name: 'Test Opening', matchedPly: 1, isExact: true });
    expect(openingAt(matches, 5)).toEqual({ eco: 'C50', name: 'Test Opening: Variation', matchedPly: 3, isExact: false });
    expect(openingAt(matches, 3)).toEqual({ eco: 'C50', name: 'Test Opening: Variation', matchedPly: 3, isExact: true });
  });

  it('names nothing at the root or off-book', () => {
    expect(openingAt(matches, 0)).toBeNull();
    expect(openingAt([], 4)).toBeNull();
    expect(openingAt([{ ply: 0, eco: 'X00', name: 'Root' }], 2)).toBeNull();
  });
});

describe('fetchLineOpenings', () => {
  const ok = (body: unknown) => (async () => ({ ok: true, status: 200, json: async () => body }) as Response);

  it('parses a well-formed response', async () => {
    const line = await fetchLineOpenings(
      ['e2e4', 'e7e5'], 'start',
      undefined,
      ok({ matches, book_flags: [true, false] }) as unknown as typeof fetch,
    );
    expect(line).toEqual({ matches, bookFlags: [true, false] });
  });

  it('rejects HTTP failures and misshapen bodies', async () => {
    const fail = (async () => ({ ok: false, status: 409, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    await expect(fetchLineOpenings(['e2e4'], 'start', undefined, fail)).rejects.toThrow('409');
    await expect(fetchLineOpenings(['e2e4'], 'start', undefined, ok({ matches, book_flags: [true, false, true] }) as unknown as typeof fetch)).rejects.toThrow();
    await expect(fetchLineOpenings(['e2e4'], 'start', undefined, ok({ matches, book_flags: ['yes'] }) as unknown as typeof fetch)).rejects.toThrow();
    await expect(fetchLineOpenings(['e2e4'], 'start', undefined, ok({ matches: [{ ply: '1', eco: 'B00', name: 'X' }], book_flags: [true] }) as unknown as typeof fetch)).rejects.toThrow();
  });
});
