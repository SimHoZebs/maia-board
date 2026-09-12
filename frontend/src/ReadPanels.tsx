import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  candidateSan,
  exportLine,
  loadLine,
  replay,
  sideName,
  START_FEN,
  storedGameResult,
} from "./domain";
import type { Action, State } from "./state";
import { downloadPgn, Rating } from "./BoardTools";
import {
  Button,
  CandidateList,
  CandidateRow,
  EngineSection,
  IconButton,
} from "./components";
import { Dialog } from "./Dialog";
import {
  ArrowLeft,
  ArrowRight,
  SkipBack,
  SkipForward,
  Play,
  Search,
  Download,
  Trash2,
  CornerDownRight,
} from "lucide-react";
import { BoardThumbnail } from "./BoardThumbnail";
import type { Review } from "./useReview";
import { QualityBadge } from "./ReviewCharts";
import { getAnalysisRecords, isFreshRecord, lineHash } from "./analysisRecords";
import {
  describeMove,
  scoreValueText,
  whiteWin,
  type Evaluation,
  type Quality,
} from "./reviewMetrics";
import { ReviewOverview } from "./ReviewOverview";

function reviewRecord(review: Review) {
  return review.recordStatus.state === "fresh"
    ? review.recordStatus.record
    : review.recordStatus.state === "stale"
      ? review.recordStatus.record
      : undefined;
}

function isComplete(review: Review): boolean {
  const progress = review.progress;
  return !!progress &&
    !progress.running &&
    !progress.canceled &&
    progress.done === progress.total &&
    !progress.failed;
}

// Tab-bar action: the Analyze / Re-analyze / Restore button owns the right
// end of the tab row. While running it is replaced in place by the progress
// status.
function ReviewActionButton({ state, review }: { state: State; review: Review }) {
  const progress = review.progress;
  if (progress?.running) {
    return (
      <span role="status">
        Analyzing {progress.done} of {progress.total}…
      </span>
    );
  }
  const branch = state.analysis.branchFromPly !== null;
  if (branch) {
    return (
      <Button
        variant="primary"
        aria-label="Analyze explored line"
        disabled={review.tooLong}
        onClick={review.start}
      >
        Analyze
      </Button>
    );
  }
  if (
    isComplete(review) ||
    (review.coverage && review.coverage.covered === review.coverage.total)
  ) {
    return (
      <Button variant="primary" onClick={review.start}>
        Re-analyze
      </Button>
    );
  }
  if (progress && (progress.canceled || progress.failed > 0)) {
    return (
      <Button
        variant="primary"
        aria-label="Analyze entire game"
        disabled={review.tooLong}
        onClick={review.start}
      >
        Analyze
      </Button>
    );
  }
  if (review.coverage && reviewRecord(review)) {
    return (
      <Button
        variant="primary"
        aria-label="Restore remaining"
        onClick={review.start}
      >
        Restore
      </Button>
    );
  }
  if (review.recordStatus.state === "fresh")
    return (
      <Button variant="primary" aria-label="Loading analysis" disabled>
        Loading…
      </Button>
    );
  if (review.recordStatus.state === "checking")
    return (
      <Button variant="primary" aria-label="Checking analysis" disabled>
        Checking…
      </Button>
    );
  return (
    <Button
      variant="primary"
      aria-label="Analyze entire game"
      disabled={review.tooLong}
      onClick={review.start}
    >
      Analyze
    </Button>
  );
}

function hasReviewStatus(review: Review): boolean {
  if (review.progress?.running) return false;
  if (
    isComplete(review) ||
    (review.coverage && review.coverage.covered === review.coverage.total)
  )
    return false;
  const record = reviewRecord(review);
  if (review.coverage && record) return true;
  if (review.recordStatus.state === "stale" && record) return true;
  return false;
}

function ReviewStatus({ review }: { review: Review }) {
  if (review.progress?.running) return null;
  if (
    isComplete(review) ||
    (review.coverage && review.coverage.covered === review.coverage.total)
  )
    return null;
  const record = reviewRecord(review);
  if (review.coverage && record) {
    return (
      <div className="analysis-record">
        <p role="status">
          {review.coverage.covered} of {review.coverage.total} positions
          cached
        </p>
      </div>
    );
  }
  if (review.recordStatus.state === "stale" && record) {
    return (
      <div className="analysis-record">
        <p>Previously Maia {record.settings.elo_maia}</p>
      </div>
    );
  }
  return null;
}

export function InsightPanel({
  state,
  dispatch,
  review,
  children,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  review: Review;
  children?: ReactNode;
}) {
  const [tab, setTab] = useState<"moves" | "overview">("moves");
  const moveTab = useRef<HTMLButtonElement>(null);
  const overviewTab = useRef<HTMLButtonElement>(null);
  const tabs = [
    { id: "moves", label: "Move analysis", ref: moveTab },
    { id: "overview", label: "Overview", ref: overviewTab },
  ] as const;
  const inspect = (beforePly: number) => {
    setTab("moves");
    dispatch({ type: "view", ply: beforePly });
    moveTab.current?.focus({ preventScroll: true });
    document.getElementById("board")?.scrollIntoView({ block: "start" });
  };
  const showControls =
    review.tooLong ||
    !!review.error ||
    !!review.progress?.failed ||
    hasReviewStatus(review);
  return (
    <aside className="panel insight-panel" aria-label="Game analysis">
      <div className="analysis-tabs analysis-section">
        <div
          role="tablist"
          aria-label="Game analysis views"
          className="analysis-tablist"
        >
        {tabs.map((item, index) => (
          <button
            key={item.id}
            ref={item.ref}
            type="button"
            role="tab"
            id={`analysis-tab-${item.id}`}
            aria-controls={`analysis-panel-${item.id}`}
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => {
              setTab(item.id);
              dispatch({ type: "preview", uci: null });
            }}
            onKeyDown={(event) => {
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : event.key === "ArrowRight"
                      ? (index + 1) % tabs.length
                      : event.key === "ArrowLeft"
                        ? (index + tabs.length - 1) % tabs.length
                        : null;
              if (next === null) return;
              event.preventDefault();
              event.stopPropagation();
              setTab(tabs[next].id);
              dispatch({ type: "preview", uci: null });
              tabs[next].ref.current?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
        </div>
        <div className="tab-action">
          <ReviewActionButton state={state} review={review} />
        </div>
      </div>
      {showControls && (
      <div className="analysis-section analysis-controls-section">
        {review.tooLong && (
          <p role="status">Review supports up to 256 moves (plies).</p>
        )}
        {(review.error || !!review.progress?.failed) && (
          <p role="alert">
            {review.error || `${review.progress!.failed} analysis jobs failed.`}{" "}
            <Button onClick={review.retry}>Retry failed</Button>
          </p>
        )}
        <ReviewStatus review={review} />
      </div>
      )}
      <div
        className="analysis-section"
        role="tabpanel"
        id="analysis-panel-moves"
        aria-labelledby="analysis-tab-moves"
        hidden={tab !== "moves"}
        tabIndex={0}
      >
        {tab === "moves" && (
          <MoveAnalysis state={state} dispatch={dispatch} review={review} />
        )}
      </div>
      <div
        className="analysis-section"
        role="tabpanel"
        id="analysis-panel-overview"
        aria-labelledby="analysis-tab-overview"
        hidden={tab !== "overview"}
        tabIndex={0}
      >
        {tab === "overview" && (
          <ReviewOverview
            review={review}
            ply={state.analysis.index}
            userSide={
              state.analysis.ownGame ? state.analysis.perspective : undefined
            }
            branch={state.analysis.branchFromPly !== null}
            onInspect={inspect}
          />
        )}
      </div>
      {children && <div className="analysis-section">{children}</div>}
    </aside>
  );
}

function MoveAnalysis({
  state,
  dispatch,
  review,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  review: Review;
}) {
  const response = review.maia;
  const node = review.nodes[state.analysis.index];
  const insight = response ? { fen: node.fen } : undefined;
  const played =
    review.nodes[state.analysis.index + 1]?.moves[state.analysis.index];
  const evaluation = review.current;
  // Verdict for the move played FROM this position: the same temporal
  // reference as the candidate lists (which mark it "(played)") and the
  // arrows. Nothing renders past the final position or pre-review.
  const bestUci = review.evaluations[state.analysis.index]?.best_move ?? undefined;
  const verdict = played
    ? describeMove({
        san: candidateSan(node.fen, played),
        quality: review.qualities[state.analysis.index],
        rarity: review.rarities?.[state.analysis.index],
        elo: review.maiaElo,
        bestSan: bestUci ? candidateSan(node.fen, bestUci) : undefined,
      })
    : null;
  return (
    <>
      {verdict && (
        <p className="move-verdict" role="status">
          {verdict}
        </p>
      )}
      <div className="engine-duo">
      <EngineSection
        label="Maia analysis"
        titleId="insight-title"
        dotClass="source-maia"
        title={
          <>
            Maia •{" "}
            <Rating
              inline
              id="analysis-rating"
              label="Maia rating"
              value={state.analysisSettings.eloMaia}
              disabled={review.progress?.running}
              onChange={(eloMaia) =>
                dispatch({ type: "analysis-settings", settings: { eloMaia } })
              }
            />
          </>
        }
      >
        {review.maiaStale && (
          <p role="status">
            Showing Maia {review.maiaElo}
            {review.maiaModel !== review.maiaWantedModel
              ? ` (${review.maiaModel})`
              : ""}{" "}
            · updating to {review.maiaWantedElo}
            {review.maiaModel !== review.maiaWantedModel
              ? ` (${review.maiaWantedModel})`
              : ""}
            …
          </p>
        )}
        {response && insight ? (
          <div id="insight-content">
            <CandidateList>
              {response.top_moves.slice(0, 5).map((candidate, index) => {
                const san = candidateSan(insight.fen, candidate.move);
                const isPlayed = candidate.move === played;
                const preview = () =>
                  dispatch({ type: "preview", uci: candidate.move });
                return (
                  <CandidateRow
                    key={candidate.move}
                    index={index}
                    san={san}
                    metric={`${Math.round(candidate.prob * 100)}%`}
                    isPlayed={isPlayed}
                    preview={{
                      label: `Preview ${san}${isPlayed ? " (played)" : ""}`,
                      active: state.preview === candidate.move,
                      onPreview: preview,
                    }}
                  />
                );
              })}
            </CandidateList>
          </div>
        ) : (
          <p className="empty-copy">No analysis yet.</p>
        )}
      </EngineSection>
      <EngineSection
        label="Stockfish evaluation"
        dotClass="source-stockfish"
        title={`Stockfish 19${evaluation && !evaluation.terminal ? ` · depth ${evaluation.depth}` : ""}`}
      >
        {evaluation ? (
          <StockfishBody
            fen={node.fen}
            evaluation={evaluation}
            played={played}
            previewUci={state.preview}
            onPreview={(uci) => dispatch({ type: "preview", uci })}
          />
        ) : (
          <p className="empty-copy">No analysis yet.</p>
        )}
      </EngineSection>
      </div>
    </>
  );
}

export function StockfishBar({
  evaluation,
  orientation,
}: {
  evaluation?: Evaluation;
  orientation: "white" | "black";
}) {
  const percent = evaluation ? whiteWin(evaluation.score) : 50;
  const score = evaluation ? scoreValueText(evaluation.score) : "—";
  const description = !evaluation
    ? "No evaluation yet"
    : evaluation.terminal === "draw"
      ? "Draw"
      : evaluation.terminal === "white_win"
        ? "White wins"
        : evaluation.terminal === "black_win"
          ? "Black wins"
          : `${score} · White perspective`;
  return (
    <section
      className={`stockfish-balance orientation-${orientation}${evaluation ? "" : " pending"}`}
      aria-label="Stockfish position evaluation"
    >
      <div
        className="balance-track"
        role="img"
        aria-label={`${description}${evaluation ? ` · estimated White winning chance ${Math.round(percent)}%` : ""}`}
        title={description}
      >
        <div className="balance-white" style={{ height: `${percent}%` }} />
        <strong className="balance-score" aria-hidden="true">
          {score}
        </strong>
      </div>
    </section>
  );
}

function StockfishBody({
  fen,
  evaluation,
  played,
  previewUci,
  onPreview,
}: {
  fen: string;
  evaluation: Evaluation;
  played?: string;
  previewUci: string | null;
  onPreview: (uci: string) => void;
}) {
  if (evaluation.terminal)
    return (
      <div>
        <p>
          {evaluation.terminal === "draw"
            ? "Draw"
            : evaluation.terminal === "white_win"
              ? "White wins"
              : "Black wins"}
        </p>
      </div>
    );
  return (
    <div>
      <CandidateList>
        {evaluation.lines.map((line, index) => {
          const san = candidateSan(fen, line.move);
          const isPlayed = line.move === played;
          return (
            <CandidateRow
              key={line.move}
              index={index}
              san={san}
              metric={scoreValueText(line.score)}
              isPlayed={isPlayed}
              preview={{
                label: `Preview ${san}${isPlayed ? " (played)" : ""}`,
                active: previewUci === line.move,
                onPreview: () => onPreview(line.move),
              }}
            />
          );
        })}
      </CandidateList>
    </div>
  );
}

export function MovesPanel({
  sans,
  ply,
  onView,
  onOriginalView,
  initialFen,
  historical,
  qualities,
  analysis = false,
  original,
  tools,
}: {
  sans: string[];
  ply: number;
  onView: (ply: number | null) => void;
  onOriginalView?: (ply: number) => void;
  initialFen: string;
  historical: boolean;
  qualities?: (Quality | undefined)[];
  analysis?: boolean;
  original?: { sans: string[]; fromPly: number };
  tools?: ReactNode;
}) {
  const active = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = list.current!;
    const reveal = () => {
      const button = active.current;
      if (button) {
        const bounds = button.getBoundingClientRect(),
          viewport = container.getBoundingClientRect();
        container.scrollLeft +=
          bounds.left -
          viewport.left -
          container.clientWidth / 2 +
          bounds.width / 2;
      } else if (ply === 0) {
        container.scrollLeft = 0;
        container.scrollTop = 0;
      }
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(container);
    return () => observer.disconnect();
  }, [ply, sans.length, analysis, original?.fromPly]);
  const parts = initialFen.split(" "),
    first = Number(parts[5]) * 2 + (parts[1] === "b" ? 1 : 0);
  const number = (index: number) => (
    <span>
      {Math.floor((first + index) / 2)}
      {(first + index) % 2 ? "…" : "."}
    </span>
  );
  // Every move reserves its badge box up front through the shared
  // QualityBadge: qualities fill in as evaluations settle, and mounting the
  // badge late would shift the row and push the selected move out of view.
  const move = (san: string, index: number) => (
    <button
      ref={ply === index + 1 ? active : undefined}
      className="move-cell"
      aria-current={ply === index + 1 ? "step" : undefined}
      key={index}
      onClick={() => onView(index + 1)}
    >
      {number(index)} {san}{" "}
      {qualities && <QualityBadge quality={qualities[index]} reserveSpace />}
    </button>
  );
  return (
    <section
      className={`notation${analysis ? " analysis-notation" : ""}`}
      aria-label="Move history"
    >
      <div className="move-list" id="move-list" ref={list}>
        {!sans.length && <span className="empty-copy">Moves appear here</span>}
        {original ? (
          <div className="original-line" aria-label="Original line">
            {original.sans
              .slice(0, Math.max(0, original.fromPly - 1))
              .map(move)}
            <div className="branch-point">
              {original.fromPly > 0 &&
                move(original.sans[original.fromPly - 1], original.fromPly - 1)}
              <div className="variation-line" aria-label="Explored variation">
                <CornerDownRight
                  className="branch-connector"
                  size={14}
                  aria-hidden="true"
                />
                {sans
                  .slice(original.fromPly)
                  .map((san, index) => move(san, original.fromPly + index))}
              </div>
            </div>
            {original.sans.slice(original.fromPly).map((san, offset) => (
              <button
                className="move-cell original-move"
                key={original.fromPly + offset}
                onClick={() =>
                  (onOriginalView ?? onView)(original.fromPly + offset + 1)
                }
              >
                {number(original.fromPly + offset)} {san}
              </button>
            ))}
          </div>
        ) : (
          sans.map(move)
        )}
      </div>
      <div className="move-navigation">
        <div className="board-actions">{tools}</div>
        <div className="nav-buttons">
          {[
            { id: "first", label: "First position", Icon: SkipBack, to: 0 },
            {
              id: "prev",
              label: "Previous position",
              Icon: ArrowLeft,
              to: ply - 1,
            },
            {
              id: "next",
              label: "Next position",
              Icon: ArrowRight,
              to: ply + 1,
            },
            {
              id: "last",
              label: "Last position",
              Icon: SkipForward,
              to: sans.length,
            },
          ].map((item) => (
            <IconButton
              key={item.id}
              id={`analysis-${item.id}`}
              label={item.label}
              disabled={item.to < 0 || item.to > sans.length || item.to === ply}
              onClick={() => onView(item.to)}
            >
              <item.Icon size={16} aria-hidden="true" />
            </IconButton>
          ))}
        </div>
      </div>
      <span id="analysis-index">
        Position {ply + 1} / {sans.length + 1}
      </span>
      {historical && (
        <Button className="return-game" onClick={() => onView(null)}>
          Return to game
        </Button>
      )}
    </section>
  );
}

export function SavedGames({
  state,
  dispatch,
  analysisOnly = false,
}: {
  state: State;
  dispatch: Dispatch<Action>;
  analysisOnly?: boolean;
}) {
  const [deleting, setDeleting] = useState<string | null>(null);
  // Line-level analyzed lookup, memoized on the saved list plus the current
  // analysis settings: the badge must agree with the detail view, which
  // compares records against global analysisSettings (History→Analyze keeps
  // them). Chunked client-side past the 200-hash server cap.
  const badgeKey = `${state.saved.map((game) => `${game.id}:${game.moves.join(",")}`).join("|")}|${state.analysisSettings.eloMaia}|${state.analysisSettings.model}|${JSON.stringify(state.stockfish)}`;
  const [analyzedLines, setAnalyzedLines] = useState<Set<string>>(new Set());
  useEffect(() => {
    const settings = {
      eloMaia: state.analysisSettings.eloMaia,
      eloUser: state.analysisSettings.eloMaia,
      model: state.analysisSettings.model,
      stockfish: state.stockfish,
    };
    const hashes = state.saved.map((game) => lineHash(START_FEN, game.moves));
    let cancelled = false;
    getAnalysisRecords(hashes).then(
      (records) => {
        if (!cancelled)
          setAnalyzedLines(
            new Set(
              records
                .filter((record) => isFreshRecord(record, settings))
                .map((record) => record.line_hash),
            ),
          );
      },
      () => {
        if (!cancelled) setAnalyzedLines(new Set());
      },
    );
    return () => {
      cancelled = true;
    };
  }, [badgeKey]);
  const badgeHashes = useMemo(
    () => state.saved.map((game) => lineHash(START_FEN, game.moves)),
    [badgeKey],
  );
  return (
    <section className="saved-panel" aria-label="Saved games">
      {!analysisOnly && (
        <div className="saved-heading">
          <h1>History</h1>
          {state.syncPending > 0 && <span role="status">Syncing…</span>}
          {state.historyTotal !== null &&
            state.historyTotal > state.saved.length && (
              <span>
                Showing {state.saved.length} of {state.historyTotal}
              </span>
            )}
        </div>
      )}
      {!state.saved.length && (
        <p className="empty-copy">Your games will appear here.</p>
      )}
      <div id="saved-games">
        {state.saved.map((game, index) => {
          const position = replay(game.moves);
          const result = storedGameResult(game);
          return (
            <article className="saved-game" key={game.id}>
              <BoardThumbnail
                fen={position.fen()}
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
                  {analyzedLines.has(badgeHashes[index]) && " · Analyzed"}
                </p>
              </div>
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
                <IconButton
                  label="Analyze"
                  onClick={() => dispatch({ type: "review", id: game.id })}
                >
                  <Search size={16} aria-hidden="true" />
                </IconButton>
                {!analysisOnly && (
                  <>
                    <IconButton
                      label="Export"
                      onClick={() =>
                        downloadPgn(
                          exportLine(loadLine("", game.moves.join(" "))),
                          "maia-game.pgn",
                        )
                      }
                    >
                      <Download size={16} aria-hidden="true" />
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
      {deleting && (
        <Dialog title="Delete saved game?" onCancel={() => setDeleting(null)}>
          <h2>Delete saved game?</h2>
          <p>This removes the game from this device.</p>
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
