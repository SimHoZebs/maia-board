import { useCallback, useEffect, useRef, useState } from 'react';
import { MaiaApiError } from './api';
import { ReviewCoordinator } from './reviewCoordinator';
import { initialState, reducer, snapshotOf, type Action, type State } from './state/index';
import { KEYS, readStorage, writeStorage } from './storage';
import { GameRepository } from './gameRepository';
import { HistorySyncStore } from './syncStore';
import type { Mode } from './domain';
import type { UrlLine } from './analysisUrl';
import { STOCKFISH_STORAGE_KEY } from './stockfishSettings';

type PlayFlight = { id: number };
type FlightRef = { current: PlayFlight | null };

// Play POST execution, shared by dispatch and the mount effect. Firing is
// deferred a microtask so a supersede (or StrictMode rehearsal cleanup) that
// lands in the same tick cancels before any byte is sent. The flight itself
// rides the foreground scheduler (ReviewCoordinator.playMove: latest-wins
// with the shared transport deadline); this record is only the firing
// identity — reply and failure match by request identity in the reducer, and
// the record guard drops a late response a newer game superseded, so it can
// never land on a newer game.
function firePlayRequest(request: State['request'], flight: FlightRef, commit: (action: Action) => void, coordinator: ReviewCoordinator) {
  const running = flight.current;
  if (!request) {
    if (running) { flight.current = null; coordinator.abortPlayMove(); }
    return;
  }
  if (running && running.id === request.id) return;
  // Supersede frees the scheduler slot now; the replacement fires below.
  if (running) coordinator.abortPlayMove();
  const record: PlayFlight = { id: request.id };
  flight.current = record;
  queueMicrotask(() => {
    if (flight.current !== record) return;
    void coordinator.playMove(request.payload).then(
      response => {
        if (flight.current !== record) return;
        flight.current = null;
        commit({ type: 'reply', request, response });
      },
      error => {
        if (flight.current !== record) return;
        flight.current = null;
        commit({ type: 'failure', request, error: error instanceof DOMException ? new MaiaApiError('server_unreachable', 'The Maia server could not be reached.') : error });
      },
    );
  });
}

export function useMaiaBoard(mode: Mode, urlLine?: UrlLine) {
  const [repository] = useState(() => new GameRepository());
  const [state, setState] = useState(() => initialState(mode, urlLine, repository.snapshot()));
  const current = useRef(state);
  const [sync] = useState(() => new HistorySyncStore());
  // The play /move flight rides the foreground scheduler; dispatch owns only
  // the firing identity (see firePlayRequest).
  // In-flight play POST, owned by dispatch — the shared function every board
  // event funnels through (the doc's "extract a function called from event
  // handlers"). An interaction-caused POST runs because of the interaction,
  // not because the component displayed. state.request stays the UI source
  // of truth (thinking indicator, retry gating); the coordinator owns the
  // network flight.
  const [playCoordinator] = useState(() => new ReviewCoordinator());
  const flight = useRef<PlayFlight | null>(null);
  const lastPersisted = useRef(new Map<string, string>());
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
    // Execute a fresh play request; abort a superseded flight (takeback,
    // resign, and new games clear `request` through transition, so the abort
    // rides along with the same dispatch — no separate effect needed).
    firePlayRequest(next.request, flight, dispatch, playCoordinator);
  }, [repository, sync, playCoordinator]);
  // Boot + unmount: a restored game with Maia to move carries a request from
  // initialState that no dispatch may ever produce (e.g. history sync fails
  // or returns nothing new), so the mount pass fires it directly — the
  // same-id guard makes the later sync dispatch a no-op, and StrictMode
  // rehearsal single-fires through the microtask cancellation above.
  // Unmount aborts the scheduler flight; its handlers ignore it by record
  // identity.
  useEffect(() => {
    const boot = current.current.request;
    if (boot && !flight.current) firePlayRequest(boot, flight, dispatch, playCoordinator);
    return () => {
      flight.current = null;
      playCoordinator.abortPlayMove();
    };
  }, [dispatch, playCoordinator]);
  // Mode arrives exclusively through dispatch: tab taps sync it in their
  // click handlers, Back/Forward in the popstate listener, and the review /
  // unload / saved navigations through their own actions. There is no
  // render-phase correction, so `current` stays dispatch-owned (updated
  // beside every setState above) and every request — including one queued
  // by entering play with Maia to move — fires through firePlayRequest in
  // dispatch itself. No sync or backstop effects needed.

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
      [KEYS.settings, state.play.settings], [KEYS.feedback, state.feedback], [KEYS.playVerdict, state.playVerdict], [KEYS.badgeLoading, state.badgeLoading], [KEYS.coordinatesOnSquares, state.coordinatesOnSquares], [KEYS.boardOrientation, state.boardOrientation], [KEYS.bestLineWindow, state.bestLineWindow], [KEYS.arrows, state.arrows], [KEYS.arrowBasis, state.arrowBasis],
      [STOCKFISH_STORAGE_KEY, state.stockfish], [KEYS.analysis, state.inputs],
      [KEYS.snapshot, state.analysisLoaded ? snapshotOf(state.analysis, state.analysisSourceId ?? undefined) : null],
    ] as const) {
      // Dirty-check: analysis object identity turns over on every move, but
      // its serialized inputs usually do not. Skip identical payloads so a
      // scrub through the move list does not rewrite every key per ply.
      let serialized: string;
      try {
        serialized = JSON.stringify(value) ?? 'null';
      } catch {
        continue;
      }
      if (lastPersisted.current.get(key) === serialized) continue;
      const error = writeStorage(key, value);
      if (error) errorMessage = error.message;
      else lastPersisted.current.set(key, serialized);
    }
    sync.setPreferenceError(errorMessage);
  }, [state.play.settings, state.feedback, state.playVerdict, state.badgeLoading, state.coordinatesOnSquares, state.boardOrientation, state.bestLineWindow, state.arrows, state.arrowBasis, state.stockfish, state.inputs, state.analysisLoaded, state.analysis, state.analysisSourceId, sync]);

  return { state, dispatch, sync, repository };
}
