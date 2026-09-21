import { describe, expect, it, vi } from 'vitest';
import { MaiaApiError, parseMoveResponse, readableApiError, requestMaiaAnalysis, requestMove } from './api';
import { START_FEN } from './domain';
import { maiaFixture } from './evaluationTestFixtures';
import { requestBodyText } from './testUtils';

const payload = {
  fen: START_FEN,
  moves: [],
  elo_maia: 1600,
  elo_user: 1400,
  model: '79m' as const,
  maia_color: 'white' as const,
};

describe('requestMove', () => {
  it('passes cancellation through without changing the wire payload', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      move: 'e2e4', top_moves: [{ move: 'e2e4', prob: 0.6, wdl: [0.2, 0.3, 0.5] }], wdl: [0.2, 0.3, 0.5], model_used: '79m', degraded: false,
    })));
    await requestMove(payload, fetchImpl, controller.signal);
    expect(fetchImpl).toHaveBeenCalledWith('/move', expect.objectContaining({ signal: expect.any(AbortSignal), body: JSON.stringify(payload) }));
  });
  it('maps a successful API response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      move: 'e2e4',
      top_moves: [{ move: 'e2e4', prob: 0.6, wdl: [0.2, 0.3, 0.5] }],
      wdl: [0.2, 0.3, 0.5],
      model_used: '79m',
      degraded: false,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await expect(requestMove(payload, fetchImpl)).resolves.toMatchObject({ move: 'e2e4', model_used: '79m' });
    expect(fetchImpl).toHaveBeenCalledWith('/move', expect.objectContaining({ method: 'POST' }));
  });

  it('preserves server error codes for user-facing mapping', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 'not_maia_turn',
      message: 'fen side-to-move is not maia_color',
    }), { status: 400 }));

    const error = await requestMove(payload, fetchImpl).catch((value: unknown) => value);
    if (!(error instanceof MaiaApiError)) throw error;
    expect(error).toBeInstanceOf(MaiaApiError);
    expect(error.code).toBe('not_maia_turn');
    expect(readableApiError(error)).toBe('Maia is not on move in this position.');
  });

  it('maps network failures to server unreachable', async () => {
    const error = await requestMove(payload, vi.fn().mockRejectedValue(new Error('offline'))).catch((value: unknown) => value);
    if (!(error instanceof MaiaApiError)) throw error;
    expect(error.code).toBe('server_unreachable');
  });

  it('routes play and analysis to their own endpoints without a lane header', async () => {
    const body = JSON.stringify({
      move: 'e2e4',
      top_moves: [{ move: 'e2e4', prob: 0.6, wdl: [0.2, 0.3, 0.5] }],
      wdl: [0.2, 0.3, 0.5],
      model_used: '79m',
      degraded: false,
    });
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(body));
    // Live replies ride the Play lane (POST /move); retrospective analysis
    // rides Focus (POST /move/analysis), so the two queue by endpoint.
    await requestMove({ ...payload, temperature: 1 }, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/move', expect.objectContaining({
      headers: expect.not.objectContaining({ 'X-Priority': expect.anything() }),
    }));
    fetchImpl.mockClear();
    await requestMaiaAnalysis(payload, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith('/move/analysis', expect.objectContaining({
      headers: expect.not.objectContaining({ 'X-Priority': expect.anything() }),
    }));
  });

  it('preserves the scheduler 409 code without retrying it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'superseded', message: 'superseded' }), { status: 409 }));
    const error = await requestMove(payload, fetchImpl).catch((value: unknown) => value);
    if (!(error instanceof MaiaApiError)) throw error;
    expect(error).toBeInstanceOf(MaiaApiError);
    expect(error.code).toBe('superseded');
    // retryBusy only retries engine_busy: exactly one attempt here.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readableApiError(new MaiaApiError('superseded', 'x'))).toBe('A newer request replaced this position.');
  });

  it.each([
    ['invalid_elo', 'The Elo settings are invalid. Choose both ratings before trying again.'],
    ['missing_elo', 'The Elo settings are invalid. Choose both ratings before trying again.'],
    ['invalid_maia_color', 'The Maia side setting is invalid. Choose White or Black and try again.'],
    ['invalid_request', 'The Maia server could not read this request.'],
    ['invalid_json', 'The Maia server could not read this request.'],
    ['invalid_model', 'The Maia server could not read this request.'],
    ['method_not_allowed', 'The Maia server could not read this request.'],
  ] as const)('maps %s to curated copy', (code, message) => {
    expect(readableApiError(new MaiaApiError(code, 'raw server message'))).toBe(message);
  });
});

describe('native Maia response validation', () => {
  const valid = maiaFixture(START_FEN);
  it.each([NaN, Infinity, -0.1, 1.1])('rejects out-of-bound candidate and WDL probability %s', prob => {
    expect(() => parseMoveResponse({ ...valid, top_moves: [{ move: 'e2e4', prob, wdl: [0.2, 0.3, 0.5] }] })).toThrow();
    expect(() => parseMoveResponse({ ...valid, wdl: [prob, 0, 1] })).toThrow();
  });
  it('rejects empty, malformed, duplicate and illegal candidates', () => {
    expect(() => parseMoveResponse({ ...valid, top_moves: [] })).toThrow();
    expect(() => parseMoveResponse({ ...valid, move: 'e4' })).toThrow();
    expect(() => parseMoveResponse({ ...valid, top_moves: [valid.top_moves[0], valid.top_moves[0]] })).toThrow();
    expect(() => parseMoveResponse({ ...valid, top_moves: [{ move: 'a1a8', prob: 0.2, wdl: [0.2, 0.3, 0.5] }] }, payload)).toThrow();
    expect(() => parseMoveResponse({ ...valid, top_moves: [{ ...valid.top_moves[0], wdl: [0.2, 0.3] }] })).toThrow();
    expect(() => parseMoveResponse({ ...valid, top_moves: [{ ...valid.top_moves[0], wdl: [0.5, 0.5, 0.5] }] })).toThrow();
    expect(() => parseMoveResponse({ ...valid, top_moves: [{ move: 'e2e4', prob: 0.6 }] })).toThrow();
  });
  it('accepts 79m-to-5m fallback only with degraded and preserves actual identity', () => {
    const fallback = { ...valid, model_used: '5m' as const, degraded: true };
    expect(parseMoveResponse(fallback, payload)).toMatchObject({ model_used: '5m', degraded: true });
    expect(() => parseMoveResponse({ ...fallback, degraded: false }, payload)).toThrow();
    expect(() => parseMoveResponse(valid, { ...payload, model: '5m' })).toThrow();
  });
  it('accepts a tied deterministic selected move like the backend validator', () => {
    const tied = {
      ...valid,
      move: 'd2d4',
      top_moves: [{ move: 'e2e4', prob: 0.5, wdl: [0.2, 0.3, 0.5] }, { move: 'd2d4', prob: 0.5, wdl: [0.2, 0.3, 0.5] }],
      wdl: [0.2, 0.3, 0.5],
    };
    expect(parseMoveResponse(tied, payload).move).toBe('d2d4');
    expect(() => parseMoveResponse({ ...tied, top_moves: [{ move: 'e2e4', prob: 0.6, wdl: [0.2, 0.3, 0.5] }, { move: 'd2d4', prob: 0.4, wdl: [0.2, 0.3, 0.5] }] }, payload)).toThrow();
  });
  it('passes server-attached deltas through and drops malformed ones', () => {
    const attached = {
      ...valid,
      delta_baseline: { value: 65, kind: 'before' as const },
      top_moves: valid.top_moves.map((candidate, index) => ({ ...candidate, delta: index === 0 ? -11.85 : -11.8 })),
    };
    expect(parseMoveResponse(attached, payload)).toMatchObject({
      delta_baseline: { value: 65, kind: 'before' },
      top_moves: [{ delta: -11.85 }, { delta: -11.8 }],
    });
    // Malformed attachments never reject the row; the panel falls back.
    const sloppy = {
      ...valid,
      delta_baseline: { value: 'high', kind: 'before' },
      top_moves: valid.top_moves.map(candidate => ({ ...candidate, delta: 'low' })),
    };
    const parsed = parseMoveResponse(sloppy, payload);
    expect(parsed.delta_baseline).toBeUndefined();
    expect(parsed.top_moves.every(candidate => candidate.delta === undefined)).toBe(true);
  });
  it('does not issue client repair writes for invalid cache hits', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...valid, top_moves: [] }), { headers: { 'X-Eval-Cache': 'hit' } }));
    await expect(requestMove(payload, fetcher)).rejects.toBeInstanceOf(MaiaApiError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('/move');
    expect(JSON.parse(requestBodyText(fetcher.mock.calls[0][1]))).not.toHaveProperty('cache_hash');
  });
});
