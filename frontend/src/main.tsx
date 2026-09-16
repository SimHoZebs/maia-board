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

// Canonicalize unknown entry URLs before the router mounts, so the first
// commit already names a real destination instead of flashing one frame of
// a redirect target. In-app unknown paths cannot occur; hand-typed ones
// land here. Destination and dev-lab URLs pass through untouched.
const entryPath = window.location.pathname;
const knownEntry =
  ["/play", "/analyze", "/history", "/settings"].some(
    (base) => entryPath === base || entryPath.startsWith(`${base}/`),
  ) || entryPath.startsWith("/dev/");
if (!knownEntry) window.history.replaceState(null, "", "/play");

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
