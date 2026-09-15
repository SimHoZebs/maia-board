import type { StoredGame } from './domain';
import { deleteRemote, fetchGames, mergeSync, restoreOutboxOp, saveRemote, toStoredGame, type FetchLike, type OutboxOp } from './serverGames';
import { KEYS, loadSaved, readStorage, restoreGame, writeStorage } from './storage';

export const REPOSITORY_KEY = 'maia-board.games.v2';
// Single lock name for repository writes and history sync. Cooperating tabs
// serialize both the local compare-and-write and the remote flush under this
// one Web Lock, so a second tab never overwrites the document or uploads
// ahead of the tab holding it.
export type PendingGameOperation = OutboxOp & { version: string };
export type RecoveryItem = { version: string; value: unknown };
type DurableGames = { schema: 2; games: StoredGame[]; currentId: string | null; pending: PendingGameOperation[]; recovery: RecoveryItem[] };
export type RepositorySnapshot = DurableGames & { error: string; durabilityError: string; conflict: boolean; failedVersion: string | null; total: number | null; nextOffset: number | null; loading: boolean };
let sequence = 0;
const version = () => `${typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}-${++sequence}`;

// Game-delete broadcast (REFACTOR_PLAN §2): the review-batch owner lives in a
// different subtree with no shared handle, so deletes are announced on this
// module channel. Subscribers cancel their own jobs; settled cache survives.
// Conservative superset: any delete cancels the active batch, even for an
// unrelated game — a restart is one click, a starved engine slot is not.
export type GameDeleteListener = (id: string) => void;
const gameDeleteListeners = new Set<GameDeleteListener>();
export function subscribeGameDeletes(listener: GameDeleteListener): () => void {
  gameDeleteListeners.add(listener);
  return () => { gameDeleteListeners.delete(listener); };
}

// The v2 document atomically stores records, marker and write-ahead operations.
// Browsers without a v2 document seed read-only from the pre-database game
// keys; the v1 outbox/marker one-time import lives only as the documented
// script in serverGames.ts and is no longer read here.
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
  const merged = mergeSync(current ? [current, ...games.filter(g => g.id !== current.id)] : games, current?.id ?? null, []);
  return { schema: 2, games: merged.saved, currentId: merged.currentId, pending: [], recovery };
}

export class GameRepository {
  private value: RepositorySnapshot;
  private listeners = new Set<() => void>();
  private epoch = 0;
  private pageController?: AbortController;
  private flushController?: AbortController;
  private flushing?: Promise<void>;
  private writes = Promise.resolve();
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
    // Cooperating tabs serialize compare-and-write under the single
    // repository lock. Conflicts never overwrite another tab's document;
    // local legal play remains available in memory. The document is read
    // fresh at write time so a queued write can never clobber newer state.
    this.writes = this.writes.then(async () => {
      if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(REPOSITORY_KEY, () => { this.writeDocument(); });
      else this.writeDocument();
    }).catch(error => { this.update({ durabilityError: error instanceof Error ? error.message : String(error) }); });
  }
  private writeDocument() {
    const { games, currentId, pending, recovery } = this.value;
    const document: DurableGames = { schema: 2, games, currentId, pending, recovery };
    try {
      if (localStorage.getItem(REPOSITORY_KEY) !== this.expectedRaw) {
        this.update({ conflict: true });
        throw new Error('Game history changed in another tab. Export this tab’s pending work before reloading.');
      }
      const error = writeStorage(REPOSITORY_KEY, document);
      if (error) throw error;
      this.expectedRaw = JSON.stringify(document);
      if (this.value.durabilityError) this.update({ durabilityError: '' });
    } catch (error) { this.update({ durabilityError: error instanceof Error ? error.message : String(error) }); }
  }
  save(game: StoredGame, current: boolean) {
    this.epoch++;
    // Per-id last-save-wins: only the newest snapshot per game needs
    // transmission, so earlier saves for this id collapse. Deletes stay
    // ordered in place; the current marker ORs across the collapsed saves.
    current ||= this.value.pending.some(op => op.op === 'save' && op.game.id === game.id && op.current);
    const pending: PendingGameOperation[] = [...this.value.pending.filter(op => !(op.op === 'save' && op.game.id === game.id)), { op: 'save', game, current, version: version() }];
    this.update({ games: [game, ...this.value.games.filter(g => g.id !== game.id)], currentId: current ? game.id : this.value.currentId, pending });
    this.persist();
    if (this.active) void this.flush();
  }
  // Abort-scope hook for the lineKey owner (REFACTOR_PLAN §2): deleting a game
  // cancels its in-flight history hydration here. Foreground eval abort and
  // DELETE /reviews wiring live with that owner, not in the repository.
  cancelScope(_gameId: string) {
    this.pageController?.abort();
  }
  delete(id: string) {
    this.epoch++;
    this.cancelScope(id);
    for (const listener of [...gameDeleteListeners]) {
      try { listener(id); } catch { /* subscriber-owned cancel; never break delete */ }
    }
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
    // Crash safety: each op is persisted before transmit by awaiting the
    // persist chain directly. The single repository lock is held only across
    // one op's write+transmit+in-memory acknowledge, so cooperating tabs
    // serialize remote mutations without starving each other's queued writes;
    // the acknowledgement itself persists through the normal queue after the
    // lock is released (re-requesting the held name would deadlock).
    const transmit = async (op: PendingGameOperation) => {
      this.writeDocument();
      if (this.value.conflict || this.value.durabilityError) return;
      if (op.op === 'save') await saveRemote(op.game, op.current, this.fetcher, controller.signal);
      else await deleteRemote(op.id, this.fetcher, controller.signal);
      if (controller.signal.aborted) return;
      this.update({ pending: this.value.pending.filter(entry => entry.version !== op.version) });
    };
    const task = (async () => {
      this.persist();
      await this.writes;
      try {
        while (this.value.pending.length && !controller.signal.aborted && !this.value.conflict && !this.value.durabilityError) {
          const op = this.value.pending[0];
          if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(REPOSITORY_KEY, () => transmit(op));
          else await transmit(op);
          if (controller.signal.aborted) return;
          this.persist();
          await this.writes;
        }
        if (!controller.signal.aborted) this.update({ error: '', failedVersion: null });
      } catch (error) {
        if (!controller.signal.aborted) this.update({ error: error instanceof Error ? error.message : String(error), failedVersion: this.value.pending[0]?.version ?? null });
      }
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
        // Local play during a history fetch wins over the arriving page: the
        // page is neither merged nor dropped, so the skipped range stays
        // explicitly loadable via Load more instead of silently vanishing.
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
