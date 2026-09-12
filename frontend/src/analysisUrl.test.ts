import { describe, expect, it } from 'vitest';
import { START_FEN } from './domain';
import { analysisPath, analysisSearch, parseAnalysisSearch, sameLine } from './analysisUrl';

describe('analysis URLs', () => {
  it('leaves the empty starting position bare', () => {
    expect(analysisSearch({ initialFen: START_FEN, moves: [] })).toBe('');
    expect(analysisPath({ initialFen: START_FEN, moves: [] })).toBe('/analyze');
    expect(parseAnalysisSearch('')).toBeUndefined();
    expect(parseAnalysisSearch('?')).toBeUndefined();
  });
  it('round-trips startpos moves through the query', () => {
    const line = { initialFen: START_FEN, moves: ['e2e4', 'e7e5', 'g1f3'] };
    const search = analysisSearch(line);
    expect(search).toBe('?moves=e2e4,e7e5,g1f3');
    expect(parseAnalysisSearch(search)).toEqual(line);
  });
  it('round-trips custom starts including move-less positions', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 b - - 0 12';
    expect(parseAnalysisSearch(analysisSearch({ initialFen: fen, moves: [] }))).toEqual({ initialFen: fen, moves: [] });
    const line = { initialFen: fen, moves: ['e8d7', 'e2e4'] };
    const parsed = parseAnalysisSearch(analysisSearch(line));
    expect(parsed).toEqual(line);
    expect(analysisSearch(line)).toContain('fen=');
  });
  it('rejects tampered links back to the importer', () => {
    expect(parseAnalysisSearch('?fen=not-a-fen')).toBeUndefined();
    expect(parseAnalysisSearch('?moves=e2e4,zzz9')).toBeUndefined();
    expect(parseAnalysisSearch('?moves=e2e5')).toBeUndefined();
  });
  it('compares lines by normalized content', () => {
    expect(sameLine({ initialFen: START_FEN, moves: ['e2e4'] }, { initialFen: START_FEN, moves: ['e2e4'] })).toBe(true);
    expect(sameLine({ initialFen: START_FEN, moves: ['e2e4'] }, { initialFen: START_FEN, moves: ['d2d4'] })).toBe(false);
    expect(sameLine({ initialFen: START_FEN, moves: [] }, { initialFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', moves: [] })).toBe(true);
  });
});
