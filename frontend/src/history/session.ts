import { createContext, useContext, useSyncExternalStore } from 'react';
import { fetchMe, loginLocal, logout, type Account, type FetchLike } from './account';

// Explicit session machine: no `account: null` + `error: ''` sentinels.
// Each status carries exactly its own data — illegal combinations
// (signed-in with no account, signed-out with an account) do not typecheck.
export type SessionSnapshot =
  | { status: 'checking' }
  | { status: 'signed-in'; account: Account }
  | { status: 'signed-out'; reason: 'anonymous' | 'unavailable'; message: string | null };

// Cross-layer 401 broadcast: any sender (gameClient, engine transport) that
// observes an Unauthorized response announces it here instead of handling
// login itself. The session owner re-checks /me (debounced) and drops to
// signed-out only when the session is really gone, so one expired tab does
// not log out a fresh login racing it.
const unauthorizedListeners = new Set<() => void>();
let notifiedListenerError = false;
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
      if (!notifiedListenerError) {
        notifiedListenerError = true;
        console.warn('maia-board: unauthorized listener failed; sender continues.');
      }
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
  private value: SessionSnapshot = { status: 'checking' };
  private listeners = new Set<() => void>();
  private inflight: Promise<void> | null = null;
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
  private setSnapshot(next: SessionSnapshot) {
    if (JSON.stringify(this.value) === JSON.stringify(next)) return;
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
        const result = await fetchMe(this.fetcher);
        this.lastCheck = Date.now();
        if (result.kind === 'signed-in') {
          this.setSnapshot({ status: 'signed-in', account: result.account });
        } else {
          this.setSnapshot({ status: 'signed-out', reason: 'anonymous', message: null });
        }
      } catch (error) {
        this.setSnapshot({
          status: 'signed-out',
          reason: 'unavailable',
          message: error instanceof Error ? error.message : 'Login check failed.',
        });
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  };
  login = async (displayName: string): Promise<void> => {
    const account = await loginLocal(displayName, this.fetcher);
    this.lastCheck = Date.now();
    this.setSnapshot({ status: 'signed-in', account });
  };
  logout = async (): Promise<void> => {
    await logout(this.fetcher);
    this.setSnapshot({ status: 'signed-out', reason: 'anonymous', message: null });
  };
  adopt = (account: Account): void => {
    this.lastCheck = Date.now();
    this.setSnapshot({ status: 'signed-in', account });
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
// headers). Explicit states: known names vs anonymous (no provider, signed
// out, checking, or blank). Callers render via `accountDisplayName` — never
// `?? 'You'`, which collapses the reason.
export type AccountName =
  | { kind: 'known'; name: string }
  | { kind: 'anonymous'; reason: 'no-store' | 'checking' | 'signed-out' | 'blank-name' };

export function useAccountName(): AccountName {
  const store = useContext(SessionContext);
  if (store === null) return { kind: 'anonymous', reason: 'no-store' };
  const snapshot = store.snapshot();
  if (snapshot.status === 'checking') return { kind: 'anonymous', reason: 'checking' };
  if (snapshot.status === 'signed-out') return { kind: 'anonymous', reason: 'signed-out' };
  const name = snapshot.account.display_name.trim();
  if (name === '') return { kind: 'anonymous', reason: 'blank-name' };
  return { kind: 'known', name };
}

export function accountDisplayName(name: AccountName): string {
  return name.kind === 'known' ? name.name : 'You';
}
