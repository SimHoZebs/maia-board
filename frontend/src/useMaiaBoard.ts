import { useEffect, useReducer } from 'react';
import { requestMove } from './api';
import { initialState, reducer } from './state';
import { KEYS, writeStorage } from './storage';

export function useMaiaBoard() {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
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
