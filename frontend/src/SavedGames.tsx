import { useEffect, useMemo, useRef, useState } from "react";
import {
  exportLine,
  loadLine,
  lineRecord,
  resultTextForTip,
  sideName,
  storedGameResult,
} from "./domain";
import type { Action, State } from "./state";
import { copyText } from "./BoardTools";
import { Button, IconButton } from "./components";
import { Dialog } from "./Dialog";
import { Check, Copy, Play, Trash2 } from "lucide-react";
import { BoardThumbnail } from "./BoardThumbnail";
import { useSyncSnapshot, useSyncStore } from "./syncStore";

export function SavedGames({
  state,
  dispatch,
  analysisOnly = false,
}: {
  state: State;
  dispatch: React.Dispatch<Action>;
  analysisOnly?: boolean;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
  // Sync display reads come from the isolated history-sync store, so the
  // "Syncing…" indicator never re-renders the board through game state.
  const sync = useSyncStore();
  useSyncSnapshot(sync);
  const syncPending = sync.pending;
  const historyTotal = sync.total;
  const visibleGames = useMemo(() => state.saved.map(game => {
    const position = lineRecord(game.moves);
    return { game, position, result: game.result === 'resigned' ? storedGameResult(game) : resultTextForTip(position.fen, position.terminal) };
  }), [state.saved]);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );
  const copyGame = (game: { id: string; moves: string[] }) =>
    void copyText(exportLine(loadLine("", game.moves.join(" ")))).then(
      (ok) => {
        if (!ok) return;
        setCopiedId(game.id);
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopiedId(null), 2000);
      },
    );
  return (
    <section className="saved-panel" aria-label="Saved games">
      {!analysisOnly &&
        (syncPending > 0 ||
          (historyTotal !== null &&
            historyTotal > state.saved.length)) && (
          <div className="saved-heading">
            {syncPending > 0 && <span role="status">Syncing…</span>}
            {historyTotal !== null &&
              historyTotal > state.saved.length && (
              <span>
                Showing {state.saved.length} of {historyTotal}
              </span>
            )}
          </div>
        )}
      {!state.saved.length && (
        <p className="empty-copy">Your games will appear here.</p>
      )}
      <div id="saved-games">
        {visibleGames.map(({ game, position, result }) => {
          return (
            <article className="saved-game" key={game.id}>
              <button
                type="button"
                className="saved-open"
                aria-label={`Analyze game · ${result}`}
                onClick={() => dispatch({ type: "review", id: game.id })}
              >
                <BoardThumbnail
                  fen={position.fen}
                  orientation={game.settings.userColor}
                />
                <div className="saved-details">
                  <time dateTime={game.createdAt}>
                    {new Date(game.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </time>
                  <h2>
                    {sideName(game.settings.userColor)} · Maia{" "}
                    {game.settings.eloMaia}
                  </h2>
                  <p>
                    {result}
                  </p>
                </div>
              </button>
              <div className="actions saved-actions">
                {!analysisOnly && result === "Unfinished" && (
                  <IconButton
                    label="Resume"
                    data-game-id={game.id}
                    onClick={() => dispatch({ type: "saved", id: game.id })}
                  >
                    <Play size={16} aria-hidden="true" />
                  </IconButton>
                )}
                {!analysisOnly && (
                  <>
                    <IconButton label="Copy PGN" onClick={() => copyGame(game)}>
                      {copiedId === game.id ? (
                        <Check size={16} aria-hidden="true" />
                      ) : (
                        <Copy size={16} aria-hidden="true" />
                      )}
                    </IconButton>
                    <IconButton
                      label="Delete"
                      onClick={() => setDeleting(game.id)}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </IconButton>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {sync.hasMore && <Button disabled={sync.loading} onClick={() => void sync.loadMore()}>{sync.loading ? 'Loading…' : 'Load more'}</Button>}
      {copiedId !== null && (
        <span role="status" className="visually-hidden">
          PGN copied to clipboard
        </span>
      )}
      {deleting && (
        <Dialog title="Delete saved game?" onCancel={() => setDeleting(null)}>
          <h2>Delete saved game?</h2>
          <p>This deletes the saved game from server history and this browser.</p>
          <div className="actions">
            <Button
              onClick={() => {
                dispatch({ type: "delete", id: deleting });
                setDeleting(null);
              }}
            >
              Delete game
            </Button>
            <Button onClick={() => setDeleting(null)}>Cancel</Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
