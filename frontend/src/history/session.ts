import { createContext, useContext, useSyncExternalStore } from 'react';
import { fetchMe, loginLocal, logout, type Account, type FetchLike } from './account';

export type SessionStatus = 'checking' | 'signed-in' | 'signed-out';
export type SessionSnapshot = { status: SessionStatus; account: Account | null; error: string };

// Cross-layer 401 broadcast: any sender (gameClient, engine transport) that
// observes an Unauthorized response announces it here instead of handling
// login itself. The session owner re-checks /me (debounced) and drops to
// signed-out only when the session is really gone, so one expired tab does
// not log out a fresh login racing it.
const unauthorizedListeners = new Set<() => void>();
export function subscribeUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}
export function notifyUnauthorized(): void {
  // Snapshot iteration: listeners unsubscribe during dispatch.
  // oxlint-disable-next-line no-useless-spread
  for (const listener of [...unauthorizedListeners]) {
    try {
      listener();
    } catch {
      /* owner-side handling; never break senders */
    }
  }
}

export function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === 401
  );
}

export class SessionStore {
  private value: SessionSnapshot = { status: 'checking', account: null, error: '' };
  private listeners = new Set<() => void>();
  private inflight?: Promise<void>;
  private lastCheck = 0;
  constructor(private fetcher: FetchLike = fetch) {}
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    // Snapshot iteration: listeners unsubscribe during dispatch.
    // oxlint-disable-next-line no-useless-spread
    for (const listener of [...this.listeners]) listener();
  }
  private update(changes: Partial<SessionSnapshot>) {
    const next = { ...this.value, ...changes };
    if (
      next.status === this.value.status &&
      next.account === this.value.account &&
      next.error === this.value.error
    )
      return;
    this.value = next;
    this.emit();
  }
  // Re-check login. Concurrent callers share one flight; successful checks
  // within 5s reuse the snapshot so a burst of 401s causes one /me call.
  refresh = (): Promise<void> => {
    if (this.inflight) return this.inflight;
    if (this.value.status !== 'checking' && Date.now() - this.lastCheck < 5000)
      return Promise.resolve();
    this.inflight = (async () => {
      try {
        const account = await fetchMe(this.fetcher);
        this.lastCheck = Date.now();
        this.update(
          account
            ? { status: 'signed-in', account, error: '' }
            : { status: 'signed-out', account: null, error: '' },
        );
      } catch (error) {
        this.update({
          status: 'signed-out',
          account: null,
          error: error instanceof Error ? error.message : 'Login check failed.',
        });
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  };
  login = async (displayName: string): Promise<void> => {
    const account = await loginLocal(displayName, this.fetcher);
    this.lastCheck = Date.now();
    this.update({ status: 'signed-in', account, error: '' });
  };
  logout = async (): Promise<void> => {
    await logout(this.fetcher);
    this.update({ status: 'signed-out', account: null, error: '' });
  };
  adopt = (account: Account): void => {
    this.lastCheck = Date.now();
    this.update({ status: 'signed-in', account, error: '' });
  };
  // 401 observer entry: re-check, and only the refresh result moves state.
  onUnauthorized = (): void => {
    void this.refresh();
  };
}

export const SessionContext = createContext<SessionStore | null>(null);

export function useSessionStore(): SessionStore {
  const store = useContext(SessionContext);
  if (!store) throw new Error('useSessionStore must be used inside SessionContext.');
  return store;
}

export function useSessionSnapshot(store: SessionStore): SessionSnapshot {
  useSyncExternalStore(store.subscribe, store.snapshot);
  return store.snapshot();
}

// Display name for identity labels (player strips, history rows, review
// headers). Null outside a session provider (unit tests) or before login —
// callers fall back to 'You' so logged-out and test renders keep working.
export function useAccountName(): string | null {
  const store = useContext(SessionContext);
  const name = store?.snapshot().account?.display_name?.trim();
  return name ? name : null;
}
