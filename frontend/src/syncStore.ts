import { createContext, useContext, useSyncExternalStore } from 'react';
import type { RepositorySnapshot } from './gameRepository';

// Repository status and history controls have narrow subscriptions so an
// acknowledgement or page indicator does not re-render the board.
export class HistorySyncStore {
  private repo: RepositorySnapshot | null = null;
  private preferenceMessage = '';
  private listeners = new Set<() => void>();
  private revision = 0;
  loadMore: () => Promise<void> = async () => {};
  retry: () => Promise<void> = async () => {};
  exportPending: () => string = () => '';
  discardPending: (version: string) => void = () => {};
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.revision;
  private emit() {
    this.revision++;
    [...this.listeners].forEach(listener => listener());
  }
  private displayOf(repo: RepositorySnapshot | null, preference: string) {
    const pending = (repo?.pending.length ?? 0) + (repo?.recovery.length ?? 0);
    const recoveryMsg = (repo?.recovery.length ?? 0)
      ? `${repo!.recovery.length} stored item(s) need recovery. Export pending work before discarding them.`
      : '';
    const combined = [repo?.error ?? '', recoveryMsg].filter(Boolean).join(' ');
    const error = [repo?.durabilityError ?? '', preference, combined].filter(Boolean).join(' ');
    return {
      pending,
      total: repo?.total ?? null,
      error,
      durabilityError: repo?.durabilityError ?? '',
      hasMore: (repo?.nextOffset ?? null) !== null,
      loading: repo?.loading ?? false,
      pendingOperations: repo?.pending ?? [],
      recoveryItems: repo?.recovery ?? [],
      failedVersion: repo?.failedVersion ?? null,
      conflict: repo?.conflict ?? false,
    };
  }
  private currentDisplay() {
    return this.displayOf(this.repo, this.preferenceMessage);
  }
  get pending() { return this.currentDisplay().pending; }
  get error() { return this.currentDisplay().error; }
  get durabilityError() { return this.currentDisplay().durabilityError; }
  get hasMore() { return this.currentDisplay().hasMore; }
  get loading() { return this.currentDisplay().loading; }
  get pendingOperations() { return this.currentDisplay().pendingOperations; }
  get recoveryItems() { return this.currentDisplay().recoveryItems; }
  get failedVersion() { return this.currentDisplay().failedVersion; }
  get conflict() { return this.currentDisplay().conflict; }
  get total() { return this.currentDisplay().total; }
  setSnapshot(snapshot: RepositorySnapshot) {
    const before = this.currentDisplay();
    this.repo = snapshot;
    const after = this.currentDisplay();
    const pendingVersions = (ops: readonly { version: string }[]) => ops.map(op => op.version).join(',');
    const recoveryVersions = (items: readonly { version: string }[]) => items.map(item => item.version).join(',');
    if (
      before.pending === after.pending &&
      before.total === after.total &&
      before.error === after.error &&
      before.durabilityError === after.durabilityError &&
      before.hasMore === after.hasMore &&
      before.loading === after.loading &&
      pendingVersions(before.pendingOperations) === pendingVersions(after.pendingOperations) &&
      recoveryVersions(before.recoveryItems) === recoveryVersions(after.recoveryItems) &&
      before.failedVersion === after.failedVersion &&
      before.conflict === after.conflict
    ) return;
    this.emit();
  }
  // Local-storage preference writes (settings/feedback/badge/stockfish) fail
  // outside the repository snapshot, so their message stays separate. The
  // banner joins it with repo errors identically to the old 7-setter mirror.
  setPreferenceError(message: string) {
    if (message === this.preferenceMessage) return;
    this.preferenceMessage = message;
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
