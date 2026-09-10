import { useCallback } from 'react';
import { matchPath, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router';
import { App } from './App';
import type { Mode } from './domain';
import type { Action } from './state';
import { useMaiaBoard } from './useMaiaBoard';

const destinations = [
  { mode: 'play', path: '/play', label: 'Play' },
  { mode: 'analysis', path: '/analyze', label: 'Analyze' },
  { mode: 'history', path: '/history', label: 'History' },
] as const;
const pathFor = (mode: Mode) => destinations.find(destination => destination.mode === mode)!.path;

function DestinationNav() {
  return <nav aria-label="Destination">{destinations.map(({ mode, path, label }) => <NavLink id={`mode-${mode}`} key={mode} to={path} end>{label}</NavLink>)}</nav>;
}

export function BoardRouter() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Redirects start in an inert context until the destination URL is committed.
  const mode = destinations.find(destination => matchPath(destination.path, pathname))?.mode ?? 'history';
  const { state, dispatch: boardDispatch } = useMaiaBoard(mode);
  const dispatch = useCallback((action: Action) => {
    if (action.type === 'mode') { void navigate(pathFor(action.mode)); return; }
    // Loading a game and changing its URL form one React event update. The reducer
    // establishes the execution context before any request effect can run.
    if (action.type === 'review') void navigate(pathFor('analysis'));
    if (action.type === 'saved') void navigate(pathFor('play'));
    boardDispatch(action);
  }, [navigate, boardDispatch]);
  const workspace = <App state={state} dispatch={dispatch}><DestinationNav /></App>;
  return <Routes>
    {destinations.map(({ path }) => <Route key={path} path={path} element={workspace} />)}
    <Route path="/" element={<Navigate to="/play" replace />} />
    <Route path="*" element={<Navigate to="/play" replace />} />
  </Routes>;
}
