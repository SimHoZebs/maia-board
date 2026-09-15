import { useCallback, useEffect, useRef, useState } from 'react';
import { MaiaApiError, requestMove } from './api';
import { initialState, reducer, snapshotOf, type Action } from './state';
import { KEYS, readStorage, writeStorage } from './storage';
import { GameRepository } from './gameRepository';
import { HistorySyncStore } from './syncStore';
import type { Mode } from './domain';
import type { UrlLine } from './analysisUrl';
import { STOCKFISH_STORAGE_KEY } from './stockfishSettings';

export function useMaiaBoard(mode: Mode, urlLine?: UrlLine) {
  const [repository] = useState(() => new GameRepository());
  const [state, setState] = useState(() => initialState(mode, urlLine, repository.snapshot()));
  const current = useRef(state);
  const [sync] = useState(() => new HistorySyncStore());
  const dispatch = useCallback((action: Action) => {
    const before = current.current;
    const next = reducer(before, action);
    current.current = next;
    setState(next);
    // Commands persist their accepted result immediately, outside React's
    // replayable reducer/render lifecycle. Hydration has no mutation command.
    if (action.type === 'delete') {
      repository.delete(action.id);
      const snapshot = readStorage<{ gameId?: string }>(KEYS.snapshot);
      if (snapshot?.gameId === action.id) {
        const error = writeStorage(KEYS.snapshot, null);
        if (error) sync.setPreferenceError(error.message);
      }
    } else if (action.type !== 'sync' && next !== before && (next.play !== before.play || action.type === 'saved' && next.started)) {
      if (next.started || next.play.moves.length || next.play.result === 'resigned') repository.save(next.play, next.started);
    }
  }, [repository, sync]);
  if (state.mode !== mode) dispatch({ type: 'mode', mode });

  useEffect(() => {
    sync.loadMore = repository.loadMore;
    sync.retry = repository.retry;
    sync.exportPending = repository.exportPending;
    sync.discardPending = version => repository.discardPending(version);
    let previousGames = repository.snapshot().games;
    let previousCurrent = repository.snapshot().currentId;
    const update = () => {
      const value = repository.snapshot();
      sync.setSnapshot(value);
      if (value.games !== previousGames || value.currentId !== previousCurrent) {
        previousGames = value.games;
        previousCurrent = value.currentId;
        dispatch({ type: 'sync', saved: value.games, currentId: value.currentId, total: value.total, pending: value.pending });
      }
    };
    const unsubscribe = repository.subscribe(update);
    update();
    const stop = repository.start();
    return () => { unsubscribe(); stop(); };
  }, [repository, sync, dispatch]);

  useEffect(() => {
    let errorMessage = '';
    for (const [key, value] of [
      [KEYS.settings, state.play.settings], [KEYS.feedback, state.feedback], [KEYS.badgeLoading, state.badgeLoading], [KEYS.coordinatesOnSquares, state.coordinatesOnSquares],
      [STOCKFISH_STORAGE_KEY, state.stockfish], [KEYS.analysis, state.inputs],
      [KEYS.snapshot, state.analysisLoaded ? snapshotOf(state.analysis, state.analysisSourceId ?? undefined) : null],
    ] as const) {
      const error = writeStorage(key, value);
      if (error) errorMessage = error.message;
    }
    sync.setPreferenceError(errorMessage);
  }, [state.play.settings, state.feedback, state.badgeLoading, state.coordinatesOnSquares, state.stockfish, state.inputs, state.analysisLoaded, state.analysis, state.analysisSourceId, sync]);

  useEffect(() => {
    const request = state.request;
    if (!request) return;
    const controller = new AbortController();
    let active = true;
    const stalled = window.setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), 150_000);
    queueMicrotask(() => {
      if (!active) return;
      void requestMove(request.payload, fetch, controller.signal, { priority: 'play' }).then(
        response => { window.clearTimeout(stalled); if (active) dispatch({ type: 'reply', request, response }); },
        error => {
          window.clearTimeout(stalled);
          if (active) dispatch({ type: 'failure', request, error: error instanceof DOMException ? new MaiaApiError('server_unreachable', 'The Maia server could not be reached.') : error });
        },
      );
    });
    return () => { active = false; window.clearTimeout(stalled); controller.abort(); };
  }, [state.request, dispatch]);
  return { state, dispatch, sync, repository };
}
