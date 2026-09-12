import { describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ErrorBoundary, PanelError } from './ErrorBoundary';
import { fetchEvaluation } from './reviewCoordinator';
import { loadLine, testNodes } from './domain';
import { initialState, reducer } from './state';
import { MaiaApiError } from './api';

const local = () => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  });
};

describe('ErrorBoundary', () => {
  it('captures render errors into fallback state with the message', () => {
    const error = new Error('boom');
    expect(ErrorBoundary.getDerivedStateFromError(error)).toEqual({ error });
  });
  it('renders narrow panel fallbacks with scope, message, and retry', () => {
    const html = renderToString(<PanelError id="board-error" title="Board failed to render" message="injected board crash" onRetry={() => undefined} />);
    expect(html).toContain('id="board-error"');
    expect(html).toContain('Board failed to render');
    expect(html).toContain('rest of the board is unaffected');
    expect(html).toContain('injected board crash');
    expect(html).toContain('Try again');
    expect(html).toContain('role="alert"');
  });
});

describe('play request manual retry', () => {
  it('re-queues Maia after a failure without auto-looping', () => {
    local();
    let state = reducer(initialState(), { type: 'new', id: 'g', createdAt: '2026-09-10' });
    state = reducer(state, { type: 'move', from: 'e2', to: 'e4' });
    const request = state.request!;
    state = reducer(state, { type: 'failure', request, error: new MaiaApiError('engine_busy', 'busy') });
    expect(state.request).toBeNull();
    expect(state.error).toContain('busy');
    const retried = reducer(state, { type: 'retry' });
    expect(retried.request).not.toBeNull();
    expect(retried.error).toBe('');
    expect(retried.request!.payload.moves).toEqual(['e2e4']);
    // No request in flight and no error: retry is a no-op, never a loop.
    expect(reducer(retried, { type: 'retry' })).toBe(retried);
  });
});

describe('fetchEvaluation messages', () => {
  it('maps network failures and unreadable bodies to friendly copy', async () => {
    const line = loadLine('', '1. e4');
    const node = testNodes(line.initialFen, line.moves)[0];
    const signal = new AbortController().signal;
    await expect(fetchEvaluation(node, signal, (async () => { throw new TypeError('down'); }) as unknown as typeof fetch))
      .rejects.toThrow('Stockfish is unreachable');
    await expect(fetchEvaluation(node, signal, (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch))
      .rejects.toThrow('unreadable');
  });
});
