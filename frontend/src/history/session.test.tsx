import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { isUnauthorized, notifyUnauthorized, SessionStore, subscribeUnauthorized } from './session';
import { LoginGate } from './LoginGate';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const alice = { id: 'u1', created_at: '2024-01-01T00:00:00Z', display_name: 'Alice' };

describe('session store', () => {
  it('maps me to signed-in and 401 to signed-out', async () => {
    const store = new SessionStore(async () => jsonResponse(alice));
    await store.refresh();
    expect(store.snapshot()).toEqual({ status: 'signed-in', account: alice });
    const loggedOut = new SessionStore(async () => jsonResponse({}, 401));
    await loggedOut.refresh();
    expect(loggedOut.snapshot()).toEqual({
      status: 'signed-out',
      reason: 'anonymous',
      message: null,
    });
  });

  it('broadcasts unauthorized observations to subscribers', async () => {
    let observed = 0;
    const stop = subscribeUnauthorized(() => {
      observed++;
    });
    const store = new SessionStore(async () => jsonResponse(alice));
    const stopOwner = subscribeUnauthorized(store.onUnauthorized);
    notifyUnauthorized();
    await store.refresh();
    expect(observed).toBe(1);
    expect(store.snapshot().status).toBe('signed-in');
    stop();
    stopOwner();
  });

  it('detects 401 error shapes from every sender', () => {
    expect(isUnauthorized({ status: 401, message: 'x' })).toBe(true);
    expect(isUnauthorized({ status: 403 })).toBe(false);
    expect(isUnauthorized(new Error('boom'))).toBe(false);
  });
});

describe('login gate', () => {
  it('leads with Lichess and offers a local name', () => {
    const html = renderToString(
      <LoginGate
        session={{ status: 'signed-out', reason: 'anonymous', message: null }}
        onLogin={async () => undefined}
      />,
    );
    expect(html).toContain('Log in with Lichess');
    expect(html).toContain('Display name');
    expect(html).toContain('Continue with a local name');
    expect(html).toContain('aria-label="Log in"');
  });
});

describe('transport auth', () => {
  it('sends cookies on engine posts', async () => {
    const { postJson } = await import('../eval/evaluationTransport');
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(init ?? {});
      return jsonResponse({ ok: true }, 200);
    }) as typeof fetch;
    await postJson(fetchImpl, '/move', { fen: 'x' });
    expect(seen[0].credentials).toBe('include');
    // 401 responses announce themselves without a subscriber crashing.
    let announced = 0;
    const stop = subscribeUnauthorized(() => {
      announced++;
    });
    const failing = (async () => jsonResponse({}, 401)) as typeof fetch;
    const error = await postJson(failing, '/move', {}).catch(() => null);
    expect(error).not.toBeNull();
    expect(announced).toBe(1);
    stop();
  });
});
