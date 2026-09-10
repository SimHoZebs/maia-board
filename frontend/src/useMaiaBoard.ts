import { useEffect, useReducer, useRef } from 'react';
import { requestMove } from './api';
import { initialState, reducer } from './state';
import { KEYS, loadSaved, readStorage, restoreGame, writeStorage } from './storage';
import {
  deleteRemote, fetchGames, isMigrated, loadOutbox, markMigrated, migrationOps,
  pushOutbox, saveRemote, ServerGamesError, storeOutbox, toStoredGame,
} from './serverGames';
import type { Mode, StoredGame } from './domain';

const LAN_DOWN = 'Game history is unavailable. Check that the server is running on your LAN.';

export function useMaiaBoard(mode: Mode) {
  const [state, dispatch] = useReducer(reducer, mode, initialState);
  // URL owns destination; reducer mode is its execution context. A guarded
  // render-time update settles it before children or request effects commit.
  if (state.mode !== mode) dispatch({ type: 'mode', mode });
  useEffect(() => { writeStorage(KEYS.settings, state.settings); }, [state.settings]);
  useEffect(() => { writeStorage(KEYS.analysis, state.inputs); }, [state.inputs]);
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
    writeStorage(KEYS.current, state.play.moves.length ? state.play : null);
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
    // StrictMode's setup/cleanup rehearsal must not launch duplicate inference.
    queueMicrotask(() => {
      if (!active) return;
      void requestMove(request.payload, fetch, controller.signal).then(
        response => { if (active) dispatch({ type: 'reply', request, response }); },
        error => { if (active) dispatch({ type: 'failure', request, error }); },
      );
    });
    return () => { active = false; controller.abort(); };
  }, [state.request]);
  return { state, dispatch };
}
