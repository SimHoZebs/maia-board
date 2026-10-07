import { useEffect, useMemo, useRef, useState } from "react";
import {
  exportLine,
  loadLine,
  lineRecord,
  oppositeColor,
  resultTextForTip,
  sideName,
  storedGameResult,
  type StoredGame,
} from "../shared/domain";
import type { Action, State } from "../state/index";
import { copyText } from "../board/BoardTools";
import { Button, IconButton } from "../components";
import { Dialog } from "../app/Dialog";
import { ArrowUpDown, Check, ChevronDown, ChessPawn, Copy, Play, Trash2, Trophy, type LucideIcon } from "lucide-react";
import { BoardThumbnail } from "../board/BoardThumbnail";
import { useSyncSnapshot, useSyncStore } from "./syncStore";
import { useFlash } from "../app/useFlash";

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

type Outcome = 'win' | 'loss' | 'draw' | 'unfinished';

const RESULT_OPTIONS = [
  { value: 'win', label: 'Wins' },
  { value: 'loss', label: 'Losses' },
  { value: 'draw', label: 'Draws' },
  { value: 'unfinished', label: 'Unfinished' },
] as const;

const SIDE_OPTIONS = [
  { value: 'white', label: 'White' },
  { value: 'black', label: 'Black' },
] as const;

// Dropdown multi-select: a trigger button summarizing the selection opens a
// checkbox menu. Outside pointerdown and Escape close it (Escape refocuses
// the trigger), mirroring the mobile page menu's dismissal.
function MultiSelect<T extends string>({
  id,
  label,
  Icon,
  options,
  selected,
  onChange,
  layout = 'stacked',
}: {
  id: string;
  label: string;
  Icon: LucideIcon;
  options: readonly { value: T; label: string }[];
  selected: readonly T[];
  onChange: (next: T[]) => void;
  layout?: 'stacked' | 'inline';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !(event.target instanceof Node && root.current.contains(event.target))) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);
  const toggle = (value: T) => {
    const order = new Map(options.map((option, index) => [option.value, index] as const));
    const next = selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value];
    next.sort((a, b) => order.get(a)! - order.get(b)!);
    onChange(next);
  };
  const summary = selected.length === options.length
    ? 'All'
    : selected.length === 0
      ? 'None'
      : options.filter(option => selected.includes(option.value)).map(option => option.label).join(', ');
  return <div className="field multi-filter" ref={root}>
    <span id={`${id}-label`} title={label}><Icon size={14} aria-hidden="true" /><span className="visually-hidden">{label}</span></span>
    <button
      type="button"
      id={id}
      ref={trigger}
      className="multi-filter-trigger"
      aria-haspopup="true"
      aria-expanded={open}
      aria-controls={`${id}-menu`}
      aria-labelledby={`${id}-label ${id}`}
      onClick={() => setOpen(value => !value)}
    >
      <span className="multi-filter-value">{summary}</span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
    {open && <div className={`multi-filter-menu${layout === 'inline' ? ' multi-filter-menu--inline' : ''}`} id={`${id}-menu`} role="group" aria-label={label}>
      {options.map(option => (
        <label key={option.value}>
          <input
            type="checkbox"
            checked={selected.includes(option.value)}
            onChange={() => toggle(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>}
  </div>;
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
  const [resultSelection, setResultSelection] = useState<Outcome[]>(['win', 'loss', 'draw', 'unfinished']);
  const [sideSelection, setSideSelection] = useState<('white' | 'black')[]>(['white', 'black']);
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
    resultSelection.includes(outcome) &&
    sideSelection.includes(game.settings.userColor),
  ).sort((a, b) => {
    const time = (iso: string) => {
      const parsed = Date.parse(iso);
      return Number.isNaN(parsed) ? 0 : parsed;
    };
    const delta = time(a.game.createdAt) - time(b.game.createdAt);
    return sortOrder === 'newest' ? -delta : delta;
  }), [state.saved, resultSelection, sideSelection, sortOrder]);
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
          <label className="field" htmlFor="history-sort" title="Sort">
            <span><ArrowUpDown size={14} aria-hidden="true" /><span className="visually-hidden">Sort</span></span>
            <select id="history-sort" value={sortOrder} onChange={event => setSortOrder(event.target.value as 'newest' | 'oldest')}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
          <MultiSelect
            id="history-result-filter"
            label="Result"
            Icon={Trophy}
            options={RESULT_OPTIONS}
            selected={resultSelection}
            onChange={setResultSelection}
          />
          <MultiSelect
            id="history-side-filter"
            label="Side"
            Icon={ChessPawn}
            options={SIDE_OPTIONS}
            selected={sideSelection}
            onChange={setSideSelection}
            layout="inline"
          />
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
