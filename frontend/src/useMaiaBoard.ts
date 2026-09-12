import { useEffect, useReducer, useRef } from 'react';
import { MaiaApiError, requestMove } from './api';
import { maiaCacheKeyForMoveRequest } from './reviewCoordinator';
import { initialState, reducer, snapshotOf } from './state';
import { KEYS, loadSaved, readStorage, restoreGame, writeStorage } from './storage';
import {
  deleteRemote, fetchGames, isMigrated, loadOutbox, markMigrated, migrationOps,
  pushOutbox, saveRemote, ServerGamesError, storeOutbox, toStoredGame,
} from './serverGames';
import type { Mode, StoredGame } from './domain';
import type { UrlLine } from './analysisUrl';
import { STOCKFISH_STORAGE_KEY } from './stockfishSettings';

const LAN_DOWN = 'Game history is unavailable. Check that the server is running on your LAN.';

export function useMaiaBoard(mode: Mode, urlLine?: UrlLine) {
  // The initializer runs once on mount: a content URL wins over the snapshot
  // on first paint so shared links never flash the previous local line.
  const [state, dispatch] = useReducer(reducer, mode, m => initialState(m, urlLine));
  // URL owns destination; reducer mode is its execution context. A guarded
  // render-time update settles it before children or request effects commit.
  if (state.mode !== mode) dispatch({ type: 'mode', mode });
  useEffect(() => { writeStorage(KEYS.settings, state.settings); }, [state.settings]);
  useEffect(() => { writeStorage(KEYS.feedback, state.feedback); }, [state.feedback]);
  useEffect(() => { writeStorage(KEYS.badgeLoading, state.badgeLoading); }, [state.badgeLoading]);
  useEffect(() => { writeStorage(KEYS.bottomNav, state.bottomNav); }, [state.bottomNav]);
  useEffect(() => { writeStorage(STOCKFISH_STORAGE_KEY, state.stockfish); }, [state.stockfish]);
  useEffect(() => { writeStorage(KEYS.analysis, state.inputs); }, [state.inputs]);
  useEffect(() => {
    // The loaded analysis line persists independently of the import-form
    // inputs, so refresh restores the board, not the setup dialog.
    writeStorage(KEYS.snapshot, state.analysisLoaded ? snapshotOf(state.analysis, state.analysisSourceId ?? undefined) : null);
  }, [state.analysis, state.analysisLoaded, state.analysisSourceId]);
  useEffect(() => {
    fetchGames().then(
      list => dispatch({
        type: 'sync',
        saved: list.games.map(toStoredGame).filter((game): game is StoredGame => !!game),
        currentId: list.current_id, total: list.total, pending: loadOutbox(),
      }),
      () => {
        // Offline: queue anything the server has never seen so Retry uploads it.
        const have = new Set(loadOutbox().flatMap(op => op.op === 'save' ? [op.game.id] : []));
        let added = false;
        for (const op of migrationOps(loadSaved(), restoreGame(readStorage(KEYS.current)) ?? null)) {
          if (op.op === 'save' && have.has(op.game.id)) continue;
          pushOutbox(op);
          added = true;
        }
        if (added) dispatch({ type: 'sync-pending', pending: loadOutbox().length });
        dispatch({ type: 'sync-error', message: LAN_DOWN });
      },
    );
    if (!isMigrated()) {
      const saved = loadSaved();
      const current = restoreGame(readStorage(KEYS.current));
      for (const op of migrationOps(saved, current ?? null)) pushOutbox(op);
      markMigrated();
      dispatch({ type: 'sync-pending', pending: loadOutbox().length });
    }
  }, [state.flushNonce]);
  const mountedPlay = useRef(false);
  useEffect(() => {
    writeStorage(KEYS.current, state.play.moves.length || state.play.result === 'resigned' ? state.play : null);
    if (!mountedPlay.current) { mountedPlay.current = true; return; }
    // Persist every live game, including empty ones, so the current-game
    // marker and refresh resumption always agree. Fresh untouched boards
    // (never started) are the only records with nothing worth keeping.
    if (!state.started && !state.play.moves.length && !state.saved.some(game => game.id === state.play.id)) return;
    pushOutbox({ op: 'save', game: state.play, current: state.started });
    dispatch({ type: 'sync-pending', pending: loadOutbox().length });
  }, [state.play, state.started]);
  const prevSavedIds = useRef<string[] | null>(null);
  useEffect(() => {
    writeStorage(KEYS.saved, state.saved);
    const ids = state.saved.map(game => game.id);
    if (prevSavedIds.current !== null) {
      for (const id of prevSavedIds.current) {
        if (!ids.includes(id)) pushOutbox({ op: 'delete', id });
      }
      // Deleting the reviewed game retires its snapshot so refresh cannot
      // resurrect a just-deleted line as analyzed. Records stay: they are
      // keyed by line content and shared across duplicate lines.
      const snapshot = readStorage<{ gameId?: unknown }>(KEYS.snapshot);
      if (snapshot && typeof snapshot.gameId === 'string' && !ids.includes(snapshot.gameId)) writeStorage(KEYS.snapshot, null);
      dispatch({ type: 'sync-pending', pending: loadOutbox().length });
    }
    prevSavedIds.current = ids;
  }, [state.saved]);
  const flushing = useRef(false);
  useEffect(() => {
    if (flushing.current) return;
    flushing.current = true;
    void (async () => {
      try {
        for (;;) {
          const ops = loadOutbox();
          if (!ops.length) break;
          const [op] = ops;
          try {
            if (op.op === 'save') await saveRemote(op.game, op.current);
            else await deleteRemote(op.id);
          } catch (error) {
            if (error instanceof ServerGamesError && error.status === 400) {
              storeOutbox(ops.slice(1));
              dispatch({ type: 'sync-error', message: error.message });
              continue;
            }
            dispatch({ type: 'sync-error', message: error instanceof Error ? error.message : LAN_DOWN });
            break;
          }
          storeOutbox(ops.slice(1));
        }
        if (!loadOutbox().length) dispatch({ type: 'sync-error', message: '' });
      } finally {
        flushing.current = false;
        dispatch({ type: 'sync-pending', pending: loadOutbox().length });
      }
    })();
  }, [state.saved, state.play, state.flushNonce]);
  useEffect(() => {
    const request = state.request;
    if (!request) return;
    const controller = new AbortController();
    let active = true;
    // A request whose socket dies (mobile background, dropped LAN) may never
    // settle: without a stall budget the spinner wedges with no failure to
    // retry. Past the backend's 120s move window plus margin, fail into the
    // error banner so Retry can re-issue. Cleanup aborts set active false
    // first, so only the stall path dispatches.
    const stalled = window.setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 150_000);
    // StrictMode's setup/cleanup rehearsal must not launch duplicate inference.
    queueMicrotask(() => {
      if (!active) return;
      // Play-time Maia compute is filed for later analysis reuse under the
      // identical cache key batches use, so reviewing at the same Elo hits
      // the server cache instead of re-inferring. The coordinates ride along
      // on the read-through POST, replacing the old explicit PUT-after-reply.
      // Only deterministic (temperature 0) games participate: sampled moves
      // vary per call and the backend files them nowhere.
      // Analysis singles are intentionally not persisted here: on Maia-locked
      // positions the single lane is global-only while batches use the pinned
      // game Elo, so persisting singles would cache rows under an identity
      // batches never read.
      let payload = request.payload;
      if (request.mode === 'play' && (request.payload.temperature ?? 0) === 0) {
        const { key, hash } = maiaCacheKeyForMoveRequest(request.payload);
        payload = { ...request.payload, cache_key: key, cache_hash: hash };
      }
      void requestMove(payload, fetch, controller.signal).then(
        response => {
          window.clearTimeout(stalled);
          if (!active) return;
          dispatch({ type: 'reply', request, response });
        },
        error => {
          window.clearTimeout(stalled);
          if (!active) return;
          dispatch({ type: 'failure', request, error: error instanceof DOMException ? new MaiaApiError('server_unreachable', 'The Maia server could not be reached.') : error });
        },
      );
    });
    return () => { active = false; window.clearTimeout(stalled); controller.abort(); };
  }, [state.request]);
  return { state, dispatch };
}
