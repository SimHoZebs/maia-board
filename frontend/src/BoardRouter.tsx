import { useCallback } from 'react';
import { matchPath, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import { App } from './App';
import type { Mode } from './domain';
import type { Action, State } from './state';
import { useMaiaBoard } from './useMaiaBoard';

const destinations = [
  { mode: 'play', path: '/play', label: 'Play' },
  { mode: 'analysis', path: '/analyze', label: 'Analyze' },
  { mode: 'history', path: '/history', label: 'History' },
] as const;
const pathFor = (mode: Mode) => destinations.find(destination => destination.mode === mode)!.path;

function DestinationNav({ state, dispatch }: { state: State; dispatch: (action: Action) => void }) {
  return <nav aria-label="Destination">{destinations.map(({ mode: destMode, path, label }) => <NavLink id={`mode-${destMode}`} key={destMode} to={path} end onClick={() => {
    // The tab is the game chooser: reopen it when already analyzing a game.
    if (destMode === 'analysis' && state.mode === 'analysis' && state.analysisLoaded && !state.importing) {
      dispatch({ type: 'import', open: true });
    }
  }}>{label}</NavLink>)}</nav>;
}

export function BoardRouter() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Redirects start in an inert context until the destination URL is committed.
  const mode = destinations.find(destination => matchPath(destination.path, pathname))?.mode ?? 'play';
  const { state, dispatch: boardDispatch } = useMaiaBoard(mode);
  const dispatch = useCallback((action: Action) => {
    if (action.type === 'mode') {
      if (action.mode !== mode) void navigate(pathFor(action.mode));
      return;
    }
    // Loading a game and changing its URL form one React event update. The reducer
    // establishes the execution context before any request effect can run.
    // Never push the destination already shown: Back must leave analysis.
    if (action.type === 'review' && mode !== 'analysis') void navigate(pathFor('analysis'));
    if (action.type === 'saved' && mode !== 'play') void navigate(pathFor('play'));
    boardDispatch(action);
  }, [mode, navigate, boardDispatch]);
  const workspace = <App state={state} dispatch={dispatch}><DestinationNav state={state} dispatch={dispatch} /></App>;
  return <Routes>
    {destinations.map(({ path }) => <Route key={path} path={path} element={workspace} />)}
    <Route path="/" element={<Navigate to="/play" replace />} />
    <Route path="*" element={<Navigate to="/play" replace />} />
  </Routes>;
}
