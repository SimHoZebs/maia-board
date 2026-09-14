import { createContext, useContext, useSyncExternalStore } from 'react';
import type { PendingGameOperation, RecoveryItem } from './gameRepository';

// Repository status and history controls have narrow subscriptions so an
// acknowledgement or page indicator does not re-render the board.
export class HistorySyncStore {
  private pendingCount = 0;
  private errorMessage = '';
  private durabilityMessage = '';
  private preferenceMessage = '';
  private more = false;
  private fetching = false;
  private operations: readonly PendingGameOperation[] = [];
  private recoverable: readonly RecoveryItem[] = [];
  private failed: string | null = null;
  private conflicting = false;
  loadMore: () => Promise<void> = async () => {};
  retry: () => Promise<void> = async () => {};
  exportPending: () => string = () => '';
  discardPending: (version: string) => void = () => {};
  private serverTotal: number | null = null;
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private emit() {
    this.revision++;
    [...this.listeners].forEach(listener => listener());
  }
  get pending() { return this.pendingCount; }
  get error() { return [this.durabilityMessage, this.preferenceMessage, this.errorMessage].filter(Boolean).join(' '); }
  get durabilityError() { return this.durabilityMessage; }
  get hasMore() { return this.more; }
  get loading() { return this.fetching; }
  get pendingOperations() { return this.operations; }
  get recoveryItems() { return this.recoverable; }
  get failedVersion() { return this.failed; }
  get conflict() { return this.conflicting; }
  setRecovery(operations: readonly PendingGameOperation[], recovery: readonly RecoveryItem[], failed: string | null, conflict: boolean) {
    if (this.operations === operations && this.recoverable === recovery && this.failed === failed && this.conflicting === conflict) return;
    this.operations = operations; this.recoverable = recovery; this.failed = failed; this.conflicting = conflict;
    this.emit();
  }
  setDurabilityError(message: string) {
    if (message === this.durabilityMessage) return;
    this.durabilityMessage = message;
    this.emit();
  }
  setPreferenceError(message: string) {
    if (message === this.preferenceMessage) return;
    this.preferenceMessage = message;
    this.emit();
  }
  setPage(hasMore: boolean, loading: boolean) {
    if (hasMore === this.more && loading === this.fetching) return;
    this.more = hasMore; this.fetching = loading; this.emit();
  }
  get total() { return this.serverTotal; }
  setPending(count: number) {
    if (this.pendingCount === count) return;
    this.pendingCount = count;
    this.emit();
  }
  setError(message: string) {
    if (this.errorMessage === message) return;
    this.errorMessage = message;
    this.emit();
  }
  clearError() { this.setError(''); }
  setTotal(total: number | null) {
    if (this.serverTotal === total) return;
    this.serverTotal = total;
    this.emit();
  }
}

export const SyncContext = createContext<HistorySyncStore | null>(null);

export function useSyncStore(): HistorySyncStore {
  const store = useContext(SyncContext);
  if (!store) throw new Error('useSyncStore must be used inside SyncContext.');
  return store;
}

// Narrow subscription for indicator components: re-renders the caller only
// when sync display state changes, independent of game-state renders.
export function useSyncSnapshot(store: HistorySyncStore) {
  useSyncExternalStore(store.subscribe, store.snapshot);
}
