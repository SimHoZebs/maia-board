import { Suspense, lazy, useCallback, useEffect, useMemo, useRef } from "react";
import {
  matchPath,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router";
import { App } from "./App";
const EvalLoadingLab = lazy(() => import("./EvalLoadingLab").then(module => ({ default: module.EvalLoadingLab })));
import type { Mode } from "./domain";
import type { Action, State } from "./state";
import { useMaiaBoard } from "./useMaiaBoard";
import { SyncContext } from "./syncStore";
import { analysisPath, parseAnalysisSearch, sameLine } from "./analysisUrl";
import { RegionRecorder } from "./perfCommits";

export const destinations = [
  { mode: "play", path: "/play", label: "Play" },
  { mode: "analysis", path: "/analyze", label: "Analyze" },
  { mode: "history", path: "/history", label: "History" },
  { mode: "settings", path: "/settings", label: "Settings" },
] as const;
const pathFor = (mode: Mode) =>
  destinations.find((destination) => destination.mode === mode)!.path;

function DestinationNav({
  state,
  dispatch,
}: {
  state: State;
  dispatch: (action: Action) => void;
}) {
  // The Analyze tab returns to the importer: tapping it while a line is
  // loaded unloads that line instead of reopening it behind a dialog.
  return (
    <nav aria-label="Destination">
      {destinations.map(({ mode: destMode, path, label }) => (
        <NavLink
          id={`mode-${destMode}`}
          key={destMode}
          to={path}
          end
          onClick={(event) => {
            if (destMode === "analysis" && state.analysisLoaded) {
              event.preventDefault();
              dispatch({ type: "unload" });
            }
          }}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function BoardRouter() {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  // Redirects start in an inert context until the destination URL is committed.
  const mode =
    destinations.find((destination) => matchPath(destination.path, pathname))
      ?.mode ?? "history";
  // Parsed once per location: the initializer takes the mount value for boot,
  // the sync effect takes the live one for Back/Forward.
  const urlLine = useMemo(
    () => (mode === "analysis" ? parseAnalysisSearch(search) : undefined),
    [mode, search],
  );
  const { state, dispatch: boardDispatch, sync } = useMaiaBoard(mode, urlLine);
  // Loaded analyses own their URL: the address bar carries the game's content
  // (normalized FEN + UCI moves), so each game is linkable and Back walks games.
  // One effect serves both directions. A mismatch alone cannot tell a stale URL
  // (in-app load, state is newer) from a stale board (Back/Forward, location is
  // newer), so the previous search breaks the tie: a moved location loads into
  // state, an unchanged one is brought along by navigation.
  const prevSearch = useRef(search);
  useEffect(() => {
    if (mode !== "analysis" || !state.analysisLoaded) {
      prevSearch.current = search;
      return;
    }
    if (search !== prevSearch.current) {
      prevSearch.current = search;
      // Bare `/analyze` never clears: it is the empty importer, not a game.
      if (urlLine && !sameLine(urlLine, state.analysis)) {
        boardDispatch({
          type: "url-line",
          initialFen: urlLine.initialFen,
          moves: urlLine.moves,
        });
      }
      return;
    }
    const wanted = analysisPath(state.analysis);
    if (`/analyze${search}` === wanted) return;
    // Canonicalize in place when the URL already names this line (hand-edited
    // variants, present-but-empty ?moves=); only a genuinely new game pushes a
    // history entry, so Back still walks games instead of encodings.
    void navigate(wanted, {
      replace: !urlLine || sameLine(urlLine, state.analysis),
    });
  }, [
    mode,
    search,
    urlLine,
    state.analysis,
    state.analysisLoaded,
    navigate,
    boardDispatch,
  ]);
  const dispatch = useCallback(
    (action: Action) => {
      if (action.type === "mode") {
        if (action.mode !== mode) void navigate(pathFor(action.mode));
        return;
      }
      // Loading a game and changing its URL form one React event update. The reducer
      // establishes the execution context before any request effect can run.
      // Never push the destination already shown: Back must leave analysis.
      if (action.type === "review" && mode !== "analysis")
        void navigate(pathFor("analysis"));
      if (action.type === "unload") void navigate(pathFor("analysis"));
      if (action.type === "saved" && mode !== "play")
        void navigate(pathFor("play"));
      boardDispatch(action);
    },
    [mode, navigate, boardDispatch],
  );
  const workspace = (
    <RegionRecorder id="app">
      <SyncContext.Provider value={sync}>
        <App state={state} dispatch={dispatch}>
          <DestinationNav state={state} dispatch={dispatch} />
        </App>
      </SyncContext.Provider>
    </RegionRecorder>
  );
  return (
    <Routes>
      <Route path="/dev/eval-loading" element={<Suspense fallback={null}><EvalLoadingLab /></Suspense>} />
      {destinations.map(({ path }) => (
        <Route key={path} path={path} element={workspace} />
      ))}
      <Route path="/" element={<Navigate to="/play" replace />} />
      <Route path="*" element={<Navigate to="/play" replace />} />
    </Routes>
  );
}
