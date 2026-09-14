import { createContext, useContext, useSyncExternalStore } from 'react';
import { loadOutbox } from './serverGames';

// History-sync display state, owned outside the game reducer. Persist/flush
// triggers still react to game state in effects, but the indicator values
// (pending count, error, server total) live here so updating them re-renders
// only their subscribers — never the board mid-animation. This replaces the
// old animation-window deferral: separation instead of timing workarounds.
export class HistorySyncStore {
  private pendingCount = loadOutbox().length;
  private errorMessage = '';
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
  get error() { return this.errorMessage; }
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
