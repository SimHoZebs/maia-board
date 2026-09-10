import { describe, expect, it, vi } from 'vitest';
import { MaiaApiError, readableApiError, requestMove } from './api';

const payload = {
  fen: 'start',
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
      move: 'e2e4', top_moves: [], wdl: [0.2, 0.3, 0.5], model_used: '79m', degraded: false,
    })));
    await requestMove(payload, fetchImpl, controller.signal);
    expect(fetchImpl).toHaveBeenCalledWith('/move', expect.objectContaining({ signal: controller.signal, body: JSON.stringify(payload) }));
  });
  it('maps a successful API response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      move: 'e2e4',
      top_moves: [{ move: 'e2e4', prob: 0.6 }],
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
    expect(error).toBeInstanceOf(MaiaApiError);
    expect((error as MaiaApiError).code).toBe('not_maia_turn');
    expect(readableApiError(error)).toBe('Maia is not on move in this position.');
  });

  it('maps network failures to server unreachable', async () => {
    const error = await requestMove(payload, vi.fn().mockRejectedValue(new Error('offline'))).catch((value: unknown) => value);
    expect((error as MaiaApiError).code).toBe('server_unreachable');
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
