import { describe, expect, it, vi } from 'vitest';
import { START_FEN } from './domain';
import { getAnalysisRecords, isFreshRecord, lineHash, putAnalysisRecord, recordSettings, type AnalysisRecord } from './analysisRecords';

const settings = { eloMaia: 1600, eloUser: 1600, model: '79m' as const };
const record = (overrides: Partial<AnalysisRecord> = {}): AnalysisRecord => ({
  line_hash: '0'.repeat(16), settings: recordSettings(settings), positions: 6, failed: 0,
  completed_at: '2026-09-11T00:00:00Z', ...overrides,
});

describe('lineHash', () => {
  it('is stable and covers FEN normalization, moves, and length', () => {
    const base = lineHash(START_FEN, ['e2e4']);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(lineHash(START_FEN, ['e2e4'])).toBe(base);
    expect(lineHash(START_FEN, ['d2d4'])).not.toBe(base);
    expect(lineHash('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', [])).not.toBe(lineHash(START_FEN, []));
  });
});

describe('isFreshRecord', () => {
  it('accepts exact settings with zero failures', () => {
    expect(isFreshRecord(record(), settings)).toBe(true);
  });
  it('rejects failures, rating, model, and policy drift', () => {
    expect(isFreshRecord(record({ failed: 1 }), settings)).toBe(false);
    expect(isFreshRecord(record(), { ...settings, eloMaia: 1700 })).toBe(false);
    expect(isFreshRecord(record(), { ...settings, model: '5m' })).toBe(false);
    expect(isFreshRecord(record({ settings: { ...recordSettings(settings), search_policy: 'other' } }), settings)).toBe(false);
  });
});

describe('record requests', () => {
  it('chunks batch lookups at the server limit', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string) => { seen.push(input); return new Response('{"analyses":[]}'); }) as unknown as typeof fetch;
    await getAnalysisRecords(Array.from({ length: 201 }, (_, index) => index.toString(16).padStart(16, '0')), fetchImpl);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('line=');
  });
  it('puts completion records under the line hash', async () => {
    const seen: Array<[string, RequestInit?]> = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => { seen.push([input, init]); return new Response(JSON.stringify(record())); }) as unknown as typeof fetch;
    const saved = await putAnalysisRecord('a'.repeat(16), settings, 6, 0, fetchImpl);
    expect(seen[0][0]).toBe('/analyses/' + 'a'.repeat(16));
    expect(seen[0][1]?.method).toBe('PUT');
    expect(saved.positions).toBe(6);
  });
});
