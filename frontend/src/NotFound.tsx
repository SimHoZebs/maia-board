import { NavLink } from "react-router";
import { destinations, shouldUnloadAnalysis } from "./BoardRouter";
import type { Action, State } from "./state/index";

// Unknown-URL page: a message plus links to the four destinations. Layout
// reuses the existing `.entry` + `.panel` styles; the link row reuses the
// `.actions` flex row. Each link dispatches its mode at the click event —
// the same ownership as DestinationNav in BoardRouter and MobileMenu in
// workspaces.tsx (whose drift warning applies here too): navigating without
// the dispatch would move location alone and leave the reducer behind with
// nothing to correct it.
export function NotFound({
  state,
  dispatch,
}: {
  state: State;
  dispatch: (action: Action) => void;
}) {
  return (
    <main>
      <div className="entry panel" id="not-found">
        <h1>Page not found</h1>
        <p>This page doesn&apos;t exist. Pick a destination below.</p>
        <nav aria-label="Destination" className="actions">
          {destinations.map(({ mode: destMode, path, label }) => (
            <NavLink
              id={`mode-${destMode}`}
              key={destMode}
              to={path}
              end
              onClick={(event) => {
                dispatch({ type: "mode", mode: destMode });
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
      </div>
    </main>
  );
}
