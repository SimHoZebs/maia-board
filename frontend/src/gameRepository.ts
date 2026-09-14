import type { StoredGame } from './domain';
import { deleteRemote, fetchGames, isMigrated, mergeSync, migrationOps, OUTBOX_KEY, restoreOutboxOp, saveRemote, toStoredGame, type FetchLike, type OutboxOp } from './serverGames';
import { KEYS, loadSaved, readStorage, restoreGame, writeStorage } from './storage';

export const REPOSITORY_KEY = 'maia-board.games.v2';
export type PendingGameOperation = OutboxOp & { version: string };
export type RecoveryItem = { version: string; value: unknown };
type DurableGames = { schema: 2; games: StoredGame[]; currentId: string | null; pending: PendingGameOperation[]; recovery: RecoveryItem[] };
export type RepositorySnapshot = DurableGames & { error: string; durabilityError: string; conflict: boolean; failedVersion: string | null; total: number | null; nextOffset: number | null; loading: boolean };
let sequence = 0;
const version = () => `${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}-${++sequence}`;

// The v2 document atomically stores records, marker and write-ahead operations.
// Legacy keys are read only during migration; the original outbox is retained.
export function readGameRepository(repositoryRaw?: string | null): DurableGames {
  const recovery: RecoveryItem[] = [];
  const recover = (value: unknown) => recovery.push({ version: version(), value });
  const read = (key: string): unknown => {
    let raw: string | null;
    try { raw = key === REPOSITORY_KEY && repositoryRaw !== undefined ? repositoryRaw : localStorage.getItem(key); } catch { return undefined; }
    if (raw === null) return undefined;
    try { return JSON.parse(raw); }
    catch { recover({ storageKey: key, raw }); return undefined; }
  };
  const stored = read(REPOSITORY_KEY) as Partial<DurableGames> | undefined;
  if (stored?.schema === 2 && Array.isArray(stored.games) && Array.isArray(stored.pending)) {
    const games = stored.games.flatMap(value => { const game = restoreGame(value); if (game) return [game]; recover(value); return []; });
    const pending = stored.pending.flatMap(value => {
      const op = restoreOutboxOp(value);
      if (op && typeof value.version === 'string') return [{ ...op, version: value.version }];
      recover(value); return [];
    });
    const merged = mergeSync(games, typeof stored.currentId === 'string' ? stored.currentId : null, pending);
    return { schema: 2, games: merged.saved, pending, currentId: merged.currentId,
      recovery: [...(Array.isArray(stored.recovery) ? stored.recovery : []), ...recovery] };
  }
  if (stored !== undefined) recover(stored);
  const games = loadSaved();
  const current = restoreGame(readStorage(KEYS.current)) ?? null;
  const rawLegacy = read(OUTBOX_KEY);
  const legacy = Array.isArray(rawLegacy) ? rawLegacy.flatMap(value => {
    const op = restoreOutboxOp(value); if (op) return [op]; recover(value); return [];
  }) : [];
  if (rawLegacy !== undefined && !Array.isArray(rawLegacy)) recover(rawLegacy);
  const touched = new Set(legacy.map(op => op.op === 'save' ? op.game.id : op.id));
  const imports = isMigrated() ? [] : migrationOps(games, current).filter(op => !touched.has(op.op === 'save' ? op.game.id : op.id));
  const pending = [...imports, ...legacy].map(op => ({ ...op, version: version() }));
  const merged = mergeSync(current ? [current, ...games.filter(g => g.id !== current.id)] : games, current?.id ?? null, pending);
  return { schema: 2, games: merged.saved, currentId: merged.currentId, pending, recovery };
}

export class GameRepository {
  private value: RepositorySnapshot;
  private listeners = new Set<() => void>();
  private epoch = 0;
  private pageController?: AbortController;
  private flushController?: AbortController;
  private flushing?: Promise<void>;
  private writes = Promise.resolve();
  private durableVersions = new Set<string>();
  private expectedRaw: string | null = null;
  private active = false;
  private lifecycle = 0;
  constructor(private fetcher: FetchLike = fetch) {
    try { this.expectedRaw = localStorage.getItem(REPOSITORY_KEY); } catch { /* persist exposes the failure */ }
    this.value = { ...readGameRepository(this.expectedRaw), error: '', durabilityError: '', conflict: false, failedVersion: null, total: null, nextOffset: null, loading: false };
  }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private emit() { for (const listener of this.listeners) listener(); }
  private update(changes: Partial<RepositorySnapshot>) { this.value = { ...this.value, ...changes }; this.emit(); }
  private persist() {
    const { games, currentId, pending, recovery } = this.value;
    const document: DurableGames = { schema: 2, games, currentId, pending, recovery };
    const write = () => {
      try {
        if (localStorage.getItem(REPOSITORY_KEY) !== this.expectedRaw) {
          this.update({ conflict: true });
          throw new Error('Game history changed in another tab. Export this tab’s pending work before reloading.');
        }
        const error = writeStorage(REPOSITORY_KEY, document);
        if (error) throw error;
        this.expectedRaw = JSON.stringify(document);
        this.durableVersions = new Set(document.pending.map(op => op.version));
        if (this.value.durabilityError) this.update({ durabilityError: '' });
      } catch (error) { this.update({ durabilityError: error instanceof Error ? error.message : String(error) }); }
    };
    // Cooperating tabs serialize compare-and-write. Conflicts never overwrite
    // another tab's document; local legal play remains available in memory.
    this.writes = this.writes.then(async () => {
      if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(REPOSITORY_KEY, write);
      else write();
    }).catch(error => { this.update({ durabilityError: error instanceof Error ? error.message : String(error) }); });
  }
  save(game: StoredGame, current: boolean) {
    this.epoch++;
    const pending = [...this.value.pending];
    const previous = pending.at(-1);
    if (previous?.op === 'save' && previous.game.id === game.id) {
      pending.pop(); current ||= previous.current;
    }
    pending.push({ op: 'save', game, current, version: version() });
    this.update({ games: [game, ...this.value.games.filter(g => g.id !== game.id)], currentId: current ? game.id : this.value.currentId, pending });
    this.persist();
    if (this.active) void this.flush();
  }
  delete(id: string) {
    this.epoch++;
    this.update({ games: this.value.games.filter(g => g.id !== id), currentId: this.value.currentId === id ? null : this.value.currentId,
      pending: [...this.value.pending, { op: 'delete', id, version: version() }] });
    this.persist();
    if (this.active) void this.flush();
  }
  exportPending = () => JSON.stringify({ games: this.value.games, currentId: this.value.currentId, pending: this.value.pending, recovery: this.value.recovery }, null, 2);
  // Explicit recovery for a rejected operation. The original local game remains
  // available for export or a corrected save; no server delete is inferred.
  discardPending(version: string) {
    this.epoch++;
    this.update({ pending: this.value.pending.filter(op => op.version !== version), recovery: this.value.recovery.filter(op => op.version !== version), failedVersion: null, error: '' });
    this.persist();
    if (this.active) void this.flush();
  }
  flush = (): Promise<void> => {
    if (this.flushing) return this.flushing;
    const controller = new AbortController();
    this.flushController = controller;
    const run = async () => {
      this.persist();
      await this.writes;
      if (this.value.conflict || this.value.durabilityError) return;
      try {
        while (this.value.pending.length && !controller.signal.aborted && !this.value.conflict && !this.value.durabilityError) {
          const op = this.value.pending[0];
          if (!this.durableVersions.has(op.version)) { await this.writes; continue; }
          if (op.op === 'save') await saveRemote(op.game, op.current, this.fetcher, controller.signal);
          else await deleteRemote(op.id, this.fetcher, controller.signal);
          if (controller.signal.aborted) return;
          this.update({ pending: this.value.pending.filter(entry => entry.version !== op.version) });
          this.persist();
          await this.writes;
        }
        if (!controller.signal.aborted) this.update({ error: '', failedVersion: null });
      } catch (error) {
        if (!controller.signal.aborted) this.update({ error: error instanceof Error ? error.message : String(error), failedVersion: this.value.pending[0]?.version ?? null });
      }
    };
    const task = (async () => {
      if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(`${REPOSITORY_KEY}:sync`, run);
      else await run();
    })();
    this.flushing = task.catch(error => { this.update({ error: error instanceof Error ? error.message : String(error) }); })
      .finally(() => { this.flushing = undefined; });
    return this.flushing;
  };
  private async page(offset: number) {
    this.pageController?.abort();
    const controller = new AbortController();
    this.pageController = controller;
    const epoch = this.epoch;
    const pendingAtStart = this.value.pending;
    this.update({ loading: true });
    try {
      const list = await fetchGames(this.fetcher, offset, controller.signal);
      if (controller.signal.aborted) return;
      if (epoch !== this.epoch) {
        // The missing page remains explicitly loadable after local play wins.
        this.update({ total: list.total, nextOffset: offset });
        return;
      }
      const rows = [...list.games, ...(list.current_game ? [list.current_game] : [])].map(row => {
        const game = toStoredGame(row);
        if (!game) throw new Error(`Stored game ${row.id} contains an illegal move history.`);
        return game;
      });
      const games = new Map(this.value.games.map(g => [g.id, g]));
      for (const game of rows) games.set(game.id, game);
      const merged = mergeSync([...games.values()], list.current_id, pendingAtStart);
      this.update({ games: merged.saved, currentId: merged.currentId, total: list.total,
        nextOffset: list.next_offset === undefined ? (offset + list.games.length < list.total && list.games.length ? offset + list.games.length : null) : list.next_offset,
        error: this.value.pending.length ? this.value.error : '' });
      this.persist();
      await this.writes;
    } catch (error) {
      if (!controller.signal.aborted) this.update({ error: error instanceof Error ? error.message : String(error) });
    } finally { if (this.pageController === controller) this.update({ loading: false }); }
  }
  refresh = () => this.page(0);
  loadMore = async () => { if (!this.value.loading && this.value.nextOffset !== null) await this.page(this.value.nextOffset); };
  retry = async () => {
    const lifecycle = this.lifecycle;
    await this.flush();
    if (lifecycle === this.lifecycle && !this.value.conflict) await this.refresh();
  };
  start = () => {
    this.active = true;
    const lifecycle = ++this.lifecycle;
    // Deferral makes React StrictMode's setup/cleanup rehearsal cancellable.
    queueMicrotask(() => { if (this.active && lifecycle === this.lifecycle) void this.retry(); });
    return () => { this.active = false; this.lifecycle++; this.pageController?.abort(); this.flushController?.abort(); };
  };
}
