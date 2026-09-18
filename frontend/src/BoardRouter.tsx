import { Suspense, lazy, useCallback, useEffect, useMemo, useRef } from "react";
import { flushSync } from "react-dom";
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
import { loadLine } from "./domain";
import type { Action, State } from "./state/index";
import { useMaiaBoard } from "./useMaiaBoard";
import { SyncContext } from "./syncStore";
import { analysisPath, analysisSearch, parseAnalysisSearch, sameLine } from "./analysisUrl";
import { RegionRecorder } from "./perfCommits";

export const destinations = [
  { mode: "play", path: "/play", label: "Play" },
  { mode: "analysis", path: "/analyze", label: "Analyze" },
  { mode: "history", path: "/history", label: "History" },
  { mode: "settings", path: "/settings", label: "Settings" },
] as const;
const pathFor = (mode: Mode) =>
  destinations.find((destination) => destination.mode === mode)!.path;

// Shared Analyze-tab intent: tapping Analyze while a line is loaded unloads
// to the importer instead of reopening behind a dialog. MobileMenu in
// workspaces.tsx duplicates this check (read-only here); keep both branches
// identical and report any drift.
export function shouldUnloadAnalysis(destMode: string, analysisLoaded: boolean): boolean {
  return destMode === "analysis" && analysisLoaded;
}

function DestinationNav({
  state,
  dispatch,
}: {
  state: State;
  dispatch: (action: Action) => void;
}) {
  // The Analyze tab returns to the importer: tapping it while a line is
  // loaded unloads that line instead of reopening it behind a dialog.
  // Every tap also syncs the destination into the reducer explicitly, so
  // the router — not a render-phase correction — owns the mode.
  return (
    <nav aria-label="Destination">
      {destinations.map(({ mode: destMode, path, label }) => (
        <NavLink
          id={`mode-${destMode}`}
          key={destMode}
          to={path}
          end
          onClick={(event) => {
            dispatch({ type: 'mode', mode: destMode });
            if (shouldUnloadAnalysis(destMode, state.analysisLoaded)) {
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
  const prevMode = useRef(mode);
  const prevLoaded = useRef(state.analysisLoaded);
  // Latest push to a game URL; backs the popstate unload below. Declared up
  // here so the sync effect can record it.
  const lastContentRef = useRef("");
  // Set while an in-app unload's bare push is still pending: the board is
  // already empty at the old game URL, which must not reload. Cleared when
  // the bare URL lands. Back/Forward never set it (pushes don't pop).
  const unloadPendingRef = useRef(false);
  useEffect(() => {
    const wasMode = prevMode.current;
    const wasLoaded = prevLoaded.current;
    const syncRefs = (nextSearch: string) => {
      prevSearch.current = nextSearch;
      prevMode.current = mode;
      prevLoaded.current = state.analysisLoaded;
    };
    if (mode !== "analysis") {
      syncRefs(search);
      return;
    }
    if (!state.analysisLoaded) {
      syncRefs(search);
      // The board is empty but the URL names a game: Forward back to it after
      // backing out to the importer, or a pasted link. Load it so the view
      // matches the address bar. Bare stays the importer (and clears a
      // pending in-app unload). An in-app unload still in flight keeps its
      // empty board instead of reloading the old URL.
      if (!urlLine) {
        unloadPendingRef.current = false;
      } else if (!unloadPendingRef.current) {
        boardDispatch({
          type: "url-line",
          initialFen: urlLine.initialFen,
          moves: urlLine.moves,
        });
      }
      return;
    }
    if (search !== prevSearch.current) {
      syncRefs(search);
      // Bare `/analyze` never clears here: in-app unloads already unloaded,
      // and Back/Forward bare landings unload via the popstate listener
      // below, which a same-commit second setup pass cannot double-fire.
      // A content URL naming another line loads it; Back and Forward walk games.
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
    if (`/analyze${search}` === wanted) {
      syncRefs(search);
      return;
    }
    // Canonicalize in place when the URL already names this line (hand-edited
    // variants, present-but-empty ?moves=); only a genuinely new game pushes a
    // history entry, so Back still walks games instead of encodings.
    // Bare `/analyze` is the importer, not an intermediate: in-app loads push
    // to preserve it so Back returns to the list. Boot canonicalization (the
    // line was already loaded at mount) and bare pushes that just arrived
    // from another mode still replace.
    let replace: boolean;
    if (!urlLine) {
      replace = wasMode !== "analysis" || wasLoaded;
    } else {
      replace = sameLine(urlLine, state.analysis);
    }
    // Optimistic sync: a second setup pass on the same commit (StrictMode)
    // then takes the location-changed branch above instead of pushing again.
    // Bare URLs carry no line to clobber, so that pass dispatches nothing.
    syncRefs(analysisSearch(state.analysis));
    if (analysisSearch(state.analysis)) lastContentRef.current = analysisSearch(state.analysis);
    void navigate(wanted, { replace });
  }, [
    mode,
    search,
    urlLine,
    state.analysis,
    state.analysisLoaded,
    navigate,
    boardDispatch,
  ]);
  // Back out of a game to the bare importer restores the list itself, not the
  // game behind the importer's URL: the location effect above deliberately
  // leaves bare URLs alone, so this popstate listener unloads instead. Pushes
  // never fire popstate, so in-app unloads and game loads cannot trip it, and
  // a same-commit second setup pass cannot double-fire a DOM listener.
  // lastContent records the latest push to a game URL, so backing to a bare
  // URL that was already bare (e.g. the empty startpos line, whose URL is the
  // importer) restores its content intact instead of unloading it. It clears
  // on explicit unload; a stale entry can only unload an empty line, whose
  // inputs stay put for one more Load.
  const loadedRef = useRef(state.analysisLoaded);
  loadedRef.current = state.analysisLoaded;
  useEffect(() => {
    const onPopState = () => {
      const url = new URL(window.location.href);
      // Back/Forward moves location without an action: sync the reducer at
      // the event, the same explicit path as tab clicks (no-op when equal).
      const dest = destinations.find((destination) => matchPath(destination.path, url.pathname))?.mode ?? "history";
      boardDispatch({ type: "mode", mode: dest });
      if (url.pathname !== "/analyze" || parseAnalysisSearch(url.search)) return;
      if (loadedRef.current && lastContentRef.current) {
        lastContentRef.current = "";
        boardDispatch({ type: "unload" });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [boardDispatch]);
  // Latest committed board state for event handlers: a repository sync can
  // land between render and click, so the review push below must read the
  // ref, not the render-time snapshot, or it can push a stale URL that the
  // sync effect then loads over the fresh game.
  const stateRef = useRef(state);
  stateRef.current = state;
  const dispatch = useCallback(
    (action: Action) => {
      // Mode follows the destination, and the destination moves by location
      // (tab NavLinks, Back/Forward, and this wrapper's own navigations
      // below) — so a mode action only syncs the reducer and never
      // navigates itself. Navigating here would double-push behind the
      // NavLink that already owns the click.
      if (action.type === "mode") {
        boardDispatch(action);
        return;
      }
      // Loading a game and changing its URL form one React event update. The reducer
      // establishes the execution context before any request effect can run.
      // Reviews from outside analysis push the game's content URL directly, so
      // Back returns to the list they came from (history or play). The state
      // update lands while the URL is still outside analysis, where the sync
      // effect stays inert, so this push is the only entry. Reviews from the
      // importer are left to the sync effect, which pushes the game onto the
      // importer instead of replacing it away.
      if (action.type === "review" && mode !== "analysis") {
        const play = action.id
          ? stateRef.current.saved.find((game) => game.id === action.id)
          : stateRef.current.play;
        if (play) {
          try {
            const line = loadLine("", play.moves.join(" "));
            const wanted = analysisPath(line);
            if (`${pathname}${search}` !== wanted) {
              void navigate(wanted);
              const content = analysisSearch(line);
              if (content) lastContentRef.current = content;
            }
          } catch {
            // Invalid lines fall through: the reducer surfaces the error.
          }
        }
        boardDispatch(action);
        return;
      }
      if (action.type === "review") {
        boardDispatch(action);
        return;
      }
      if (action.type === "unload") {
        lastContentRef.current = "";
        unloadPendingRef.current = true;
        void navigate(pathFor("analysis"));
      }
      if (action.type === "saved" && mode !== "play") {
        // Commit the navigation synchronously before dispatching: the
        // reducer flips mode to play immediately, and a lagging location
        // would make the render-phase adjustment flap back to history and
        // orphan the new request with a same-payload twin.
        flushSync(() => { void navigate(pathFor("play")); });
      }
      boardDispatch(action);
    },
    [mode, navigate, boardDispatch, pathname, search],
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
  // Invariant: every destination change dispatches its mode at the event
  // (tab taps, popstate, the review/unload/saved navigations above, and the
  // pre-mount canonicalization in main.tsx). No new <Navigate> may appear
  // in these routes without one: location moving alone leaves the reducer
  // behind with nothing left to correct it — and a correcting effect would
  // flail against the eager dispatches (duplicate engine POSTs, see the
  // mode-ownership notes).
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
