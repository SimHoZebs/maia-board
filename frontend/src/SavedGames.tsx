import { useMemo, useState } from "react";
import {
  exportLine,
  loadLine,
  lineRecord,
  oppositeColor,
  resultTextForTip,
  sideName,
  storedGameResult,
  type StoredGame,
} from "./domain";
import type { Action, State } from "./state/index";
import { copyText } from "./BoardTools";
import { Button, IconButton } from "./components";
import { Dialog } from "./Dialog";
import { Check, Copy, Play, Trash2 } from "lucide-react";
import { BoardThumbnail } from "./BoardThumbnail";
import { useSyncSnapshot, useSyncStore } from "./syncStore";
import { useFlash } from "./useFlash";

// Result from the player's perspective: a resignation is always the player's
// own, so it reads as a loss; checkmate winners come from the result text.
function userOutcome(game: StoredGame, result: string): 'win' | 'loss' | 'draw' | 'unfinished' {
  if (result === 'Unfinished') return 'unfinished';
  if (result === 'Draw') return 'draw';
  const winner = game.result === 'resigned'
    ? oppositeColor(game.settings.userColor)
    : result.startsWith('White') ? 'white' : 'black';
  return winner === game.settings.userColor ? 'win' : 'loss';
}

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
  const [copiedId, flashCopied] = useFlash<string>();
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [resultFilter, setResultFilter] = useState<'all' | 'win' | 'loss' | 'draw' | 'unfinished'>('all');
  const [sideFilter, setSideFilter] = useState<'all' | 'white' | 'black'>('all');
  // Sync display reads come from the isolated history-sync store, so the
  // "Syncing…" indicator never re-renders the board through game state.
  const sync = useSyncStore();
  useSyncSnapshot(sync);
  const syncPending = sync.pending;
  const historyTotal = sync.total;
  const visibleGames = useMemo(() => state.saved.map(game => {
    const position = lineRecord(game.moves);
    const result = game.result === 'resigned' ? storedGameResult(game) : resultTextForTip(position.fen, position.terminal);
    return { game, position, result, outcome: userOutcome(game, result) };
  }).filter(({ game, outcome }) =>
    (resultFilter === 'all' || outcome === resultFilter) &&
    (sideFilter === 'all' || game.settings.userColor === sideFilter),
  ).sort((a, b) => {
    const time = (iso: string) => {
      const parsed = Date.parse(iso);
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    const delta = time(a.game.createdAt) - time(b.game.createdAt);
    return sortOrder === 'newest' ? -delta : delta;
  }), [state.saved, resultFilter, sideFilter, sortOrder]);
  const copyGame = (game: { id: string; moves: string[] }) =>
    void copyText(exportLine(loadLine("", game.moves.join(" ")))).then(
      (ok) => {
        if (!ok) return;
        flashCopied(game.id);
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
      {state.saved.length > 0 && (
        <div className="saved-controls" role="group" aria-label="Sort and filter games">
          <label className="field" htmlFor="history-sort">
            <span>Sort</span>
            <select id="history-sort" value={sortOrder} onChange={event => setSortOrder(event.target.value as 'newest' | 'oldest')}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
          <label className="field" htmlFor="history-result-filter">
            <span>Result</span>
            <select id="history-result-filter" value={resultFilter} onChange={event => setResultFilter(event.target.value as 'all' | 'win' | 'loss' | 'draw' | 'unfinished')}>
              <option value="all">All results</option>
              <option value="win">Wins</option>
              <option value="loss">Losses</option>
              <option value="draw">Draws</option>
              <option value="unfinished">Unfinished</option>
            </select>
          </label>
          <label className="field" htmlFor="history-side-filter">
            <span>Side</span>
            <select id="history-side-filter" value={sideFilter} onChange={event => setSideFilter(event.target.value as 'all' | 'white' | 'black')}>
              <option value="all">Either side</option>
              <option value="white">Played White</option>
              <option value="black">Played Black</option>
            </select>
          </label>
        </div>
      )}
      {state.saved.length > 0 && visibleGames.length !== state.saved.length && (
        <p className="saved-count" role="status">
          Showing {visibleGames.length} of {state.saved.length}
        </p>
      )}
      {state.saved.length > 0 && visibleGames.length === 0 && (
        <p className="empty-copy">No games match these filters.</p>
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
                    {sideName(game.settings.userColor)} · Bot{" "}
                    {game.settings.botElo}
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
