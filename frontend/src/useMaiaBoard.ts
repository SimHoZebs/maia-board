import { useEffect, useReducer } from 'react';
import { requestMove } from './api';
import { initialState, reducer } from './state';
import { KEYS, writeStorage } from './storage';
import type { Mode } from './domain';

export function useMaiaBoard(mode: Mode) {
  const [state, dispatch] = useReducer(reducer, mode, initialState);
  // URL owns destination; reducer mode is its execution context. A guarded
  // render-time update settles it before children or request effects commit.
  if (state.mode !== mode) dispatch({ type: 'mode', mode });
  useEffect(() => { writeStorage(KEYS.settings, state.settings); }, [state.settings]);
  useEffect(() => { writeStorage(KEYS.current, state.play.moves.length ? state.play : null); }, [state.play]);
  useEffect(() => { writeStorage(KEYS.saved, state.saved); }, [state.saved]);
  useEffect(() => { writeStorage(KEYS.analysis, state.inputs); }, [state.inputs]);
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
