import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@lichess-org/chessground/assets/chessground.base.css";
import "@lichess-org/chessground/assets/chessground.brown.css";
import "@lichess-org/chessground/assets/chessground.cburnett.css";
import "./styles.css";
import { BrowserRouter } from "react-router";
import { BoardRouter } from "./BoardRouter";
import { ErrorBoundary } from "./ErrorBoundary";
import { CommitRecorder } from "./perfCommits";

// "/" is the home page (Play): canonicalize it to /play before the router
// mounts, so the first commit already names Play instead of flashing one
// frame of a redirect target. Every other entry path passes through
// untouched: known destinations and dev-lab URLs mount directly, and unknown
// ones fall through to the router's NotFound route, which renders for the
// typed URL. Choice: leave unknown paths as-is rather than replacing to an
// alias such as /404. Both preserve the Back button (replaceState adds no
// entry either way) and first-commit behavior (the first commit already is
// the 404, so nothing flashes), but leaving the URL alone preserves what was
// asked for — still shareable, still debuggable — with no alias route to
// maintain. In-app unknown paths cannot occur; hand-typed ones land here.
const entryPath = window.location.pathname;
if (entryPath === "/") window.history.replaceState(null, "", "/play");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary label="app">
      <BrowserRouter>
        <CommitRecorder>
          <BoardRouter />
        </CommitRecorder>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
