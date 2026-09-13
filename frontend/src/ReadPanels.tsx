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
import { copyText, Rating } from "./BoardTools";
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
  Copy,
  Check,
  Trash2,
  CornerUpRight,
  CornerDownRight,
} from "lucide-react";
import { Chess } from "chess.js";
import { BoardThumbnail } from "./BoardThumbnail";
import type { Review } from "./useReview";
import { QualityBadge, type BadgeLoading } from "./ReviewCharts";
import { getAnalysisRecords, isFreshRecord, lineHash } from "./analysisRecords";
import {
  describeMove,
  scoreValueText,
  whiteWin,
  type Evaluation,
  type Quality,
} from "./reviewMetrics";
import { ReviewOverview } from "./ReviewOverview";

function isComplete(review: Review): boolean {
  const progress = review.progress;
  return !!progress &&
    !progress.running &&
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
  if (progress && progress.failed > 0) {
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
  // Partial cache (including play-time saves with no analysis record yet) is
  // usable immediately: the batch server-hits cached positions and only
  // infers the missing ones. Never gate this behind the record lookup.
  if (review.coverage && review.coverage.covered < review.coverage.total) {
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
  if (review.recordStatus.state === "checking" || review.recordStatus.state === "fresh")
    return (
      <Button variant="primary" aria-label="Loading analysis" disabled>
        Loading…
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
    // Issues name the before-position; the verdict now renders after the
    // move, so land one ply forward.
    dispatch({ type: "view", ply: beforePly + 1 });
    moveTab.current?.focus({ preventScroll: true });
    document.getElementById("board")?.scrollIntoView({ block: "start" });
  };
  // Graph points move the viewed position without leaving the Overview tab:
  // the selection marker follows and the board updates underneath.
  const viewInPlace = (ply: number) => {
    dispatch({ type: "view", ply });
  };
  const showControls =
    review.tooLong ||
    !!review.error ||
    !!review.progress?.failed;
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
            onGraphView={viewInPlace}
          />
        )}
      </div>
      {children && <div className="analysis-section">{children}</div>}
    </aside>
  );
}

function SkeletonList({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="skeleton-list" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index} aria-hidden="true">
          <span className="skeleton-rank" />
          <span className="skeleton-bar skeleton-san" />
          <span className="skeleton-bar skeleton-metric" />
        </div>
      ))}
    </div>
  );
}

function SkeletonText({ label }: { label: string }) {
  return (
    <p className="skeleton-verdict" role="status" aria-label={label}>
      <span className="skeleton-bar" aria-hidden="true" />
    </p>
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
  const ply = state.analysis.index;
  // Displayed move: the board shows the position after move x (and before
  // move y), so this panel covers x — the move leading into the viewed
  // position. Candidate lists come from x's before-position with x marked
  // "(played)", matching the arrows.
  const focus = ply - 1;
  const hasMove = focus >= 0;
  const response = hasMove ? review.maia : undefined;
  const node = review.nodes[hasMove ? focus : ply];
  const insight = response ? { fen: node.fen } : undefined;
  const played = hasMove
    ? review.nodes[ply]?.moves[focus]
    : undefined;
  const evaluation = hasMove ? review.focus : undefined;
  const afterEvaluation = hasMove ? review.evaluations[ply] : undefined;
  const bestUci = evaluation?.best_move ?? undefined;
  const verdict = played
    ? describeMove({
        san: candidateSan(node.fen, played),
        quality: review.qualities[focus],
        rarity: review.rarities?.[focus],
        elo: review.maiaElo,
        bestSan: bestUci ? candidateSan(node.fen, bestUci) : undefined,
      })
    : null;
  // Exploring a candidate means playing it instead of x, so step back to
  // x's before-position first: the reducer branches from the viewed position.
  const exploreFromFocus = (uci: string) => {
    dispatch({ type: "view", ply: focus });
    dispatch({ type: "explore", uci });
  };
  // Loading signals: a missing result with no recorded error is in-flight
  // (foreground fetch, prime, or batch) rather than genuinely absent. The
  // foreground lane fetches the displayed move's before/after pair on every
  // navigation. Lines longer than the review limit never fetch, so they stay
  // empty instead of skeleton-loading forever. Before the first move there is
  // no x yet, so the panel is empty (not loading) with a stepping hint.
  // Focus is always x's before-position, which is never terminal in a legal
  // line; the terminal check below is a safety net only.
  const hasError = !!review.error;
  const tooLong = review.nodes.length > 257;
  let terminalPosition = !!evaluation?.terminal;
  if (!terminalPosition) {
    try {
      terminalPosition = new Chess(node.fen).isGameOver();
    } catch {
      terminalPosition = false;
    }
  }
  const maiaLoading = hasMove && !response && !hasError && !terminalPosition && !tooLong;
  const sfLoading = hasMove && !evaluation && !hasError && !tooLong;
  // The verdict needs both sides of the move; the foreground lane fetches
  // both, prime/batch backfill the rest. Gating on the batch lane keeps the
  // skeleton honest while a batch that will supply the missing side runs.
  const batchRunning = !!review.progress?.running;
  const verdictLoading =
    hasMove && !!played && !verdict && !hasError && !tooLong && (!evaluation || !afterEvaluation || batchRunning);
  if (!hasMove) {
    return (
      <>
        <p className="move-verdict" role="status">
          Starting position — step forward to review the first move.
        </p>
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
                label={review.maiaLocked ? "Maia rating (game Elo)" : "Maia rating"}
                value={review.maiaLocked ? review.maiaElo : state.analysisSettings.eloMaia}
                disabled={review.maiaLocked || review.progress?.running}
                onChange={(eloMaia) =>
                  dispatch({ type: "analysis-settings", settings: { eloMaia } })
                }
              />
            </>
          }
        >
          <p className="empty-copy">No move to review yet.</p>
        </EngineSection>
        <EngineSection
          label="Stockfish evaluation"
          dotClass="source-stockfish"
          title="Stockfish 19"
        >
          <p className="empty-copy">No move to review yet.</p>
        </EngineSection>
        </div>
      </>
    );
  }
  return (
    <>
      {verdict ? (
        <p className="move-verdict" role="status">
          {verdict}
        </p>
      ) : (
        verdictLoading && <SkeletonText label="Loading move verdict" />
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
              label={review.maiaLocked ? "Maia rating (game Elo)" : "Maia rating"}
              value={review.maiaLocked ? review.maiaElo : state.analysisSettings.eloMaia}
              disabled={review.maiaLocked || review.progress?.running}
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
                return (
                  <CandidateRow
                    key={`${candidate.move}:${index}`}
                    index={index}
                    san={san}
                    metric={`${Math.round(candidate.prob * 100)}%`}
                    isPlayed={isPlayed}
                    preview={{
                      label: `Explore ${san}${isPlayed ? " (played)" : ""}`,
                      active: state.preview === candidate.move,
                      onPreview: () =>
                        dispatch({ type: "preview", uci: candidate.move }),
                      onSelect: () => exploreFromFocus(candidate.move),
                    }}
                  />
                );
              })}
            </CandidateList>
          </div>
        ) : maiaLoading ? (
          <SkeletonList label="Loading Maia moves" rows={3} />
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
            onExplore={(uci) => exploreFromFocus(uci)}
          />
        ) : sfLoading ? (
          <SkeletonList label="Loading Stockfish lines" rows={2} />
        ) : (
          <p className="empty-copy">No analysis yet.</p>
        )}
      </EngineSection>
      </div>
    </>
  );
}

// -|_ tween: hold the old value briefly (-), snap through the middle (|),
// settle into the new value (_). Hold is skipped when retargeting mid-flight
// so fast scrubbing follows without stacking delays.
const BAR_HOLD_MS = 110;
const BAR_SNAP_MS = 260;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function useTweenedPercent(target: number): number {
  const [display, setDisplay] = useState(target);
  const displayRef = useRef(target);
  // True while a hold is pending or a snap is running. A retarget that
  // interrupts either skips its own hold so bursts follow without stacking
  // delays; only a change from rest holds first.
  const busyRef = useRef(false);
  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      busyRef.current = false;
      displayRef.current = target;
      setDisplay(target);
      return;
    }
    if (target === displayRef.current) {
      // Back at rest (e.g. returned to origin before the hold fired): no
      // tween is running after cleanup, so clear the flag. Otherwise one
      // skipped hold would leak into the next navigation.
      busyRef.current = false;
      return;
    }
    const from = displayRef.current;
    const hold = busyRef.current ? 0 : BAR_HOLD_MS;
    busyRef.current = true;
    let raf = 0;
    const holdId = window.setTimeout(() => {
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / BAR_SNAP_MS);
        const value = from + (target - from) * easeInOutCubic(t);
        displayRef.current = value;
        setDisplay(value);
        if (t < 1) {
          raf = requestAnimationFrame(tick);
        } else {
          busyRef.current = false;
        }
      };
      raf = requestAnimationFrame(tick);
    }, hold);
    return () => {
      window.clearTimeout(holdId);
      cancelAnimationFrame(raf);
    };
  }, [target]);
  return display;
}

export function StockfishBar({
  evaluation,
  orientation,
  failed,
}: {
  evaluation?: Evaluation;
  orientation: "white" | "black";
  failed?: boolean;
}) {
  // Retain the last settled evaluation while the next position loads: the bar
  // keeps showing the previous value (dimmed/pulsing via .loading) so the
  // tween runs previous -> current instead of previous -> 50 -> current.
  const lastRef = useRef<Evaluation | undefined>(evaluation);
  useEffect(() => {
    if (evaluation) lastRef.current = evaluation;
  }, [evaluation]);
  const display = evaluation ?? lastRef.current;
  const percent = display ? whiteWin(display.score) : 50;
  const shown = useTweenedPercent(percent);
  const score = display ? scoreValueText(display.score) : "—";
  const pending = !evaluation;
  // A failed fetch is not loading: drop the pulse so the bar never spins
  // forever on the old value. Retry clears the failure upstream and the pulse
  // resumes while the refetch is in flight.
  const loading = pending && !!display && !failed;
  const statusSuffix = loading ? " · updating" : failed && pending ? " · update failed" : "";
  const description = !display
    ? "No evaluation yet"
    : display.terminal === "draw"
      ? "Draw"
      : display.terminal === "white_win"
        ? "White wins"
        : display.terminal === "black_win"
          ? "Black wins"
          : `${score} · White perspective`;
  const accessibleName = !display
    ? `${description}${failed && pending ? " · update failed" : ""}`
    : `${description} · estimated White winning chance ${Math.round(percent)}%${statusSuffix}`;
  return (
    <section
      className={`stockfish-balance orientation-${orientation}${pending ? " pending" : ""}${loading ? " loading" : ""}`}
      aria-label="Stockfish position evaluation"
      aria-busy={loading || undefined}
    >
      <div
        className="balance-track"
        role="img"
        aria-label={accessibleName}
        title={description}
      >
        <div className="balance-white" style={{ height: `${shown}%` }} />
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
  onExplore,
}: {
  fen: string;
  evaluation: Evaluation;
  played?: string;
  previewUci: string | null;
  onPreview: (uci: string) => void;
  onExplore: (uci: string) => void;
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
              key={`${line.move}:${index}`}
              index={index}
              san={san}
              metric={scoreValueText(line.score)}
              isPlayed={isPlayed}
              preview={{
                label: `Explore ${san}${isPlayed ? " (played)" : ""}`,
                active: previewUci === line.move,
                onPreview: () => onPreview(line.move),
                onSelect: () => onExplore(line.move),
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
  qualities,
  analysis = false,
  badgeLoading = 'reel',
  original,
  tools,
  branchUp = false,
  menu,
}: {
  sans: string[];
  ply: number;
  onView: (ply: number | null) => void;
  onOriginalView?: (ply: number) => void;
  initialFen: string;
  qualities?: (Quality | undefined)[];
  analysis?: boolean;
  badgeLoading?: BadgeLoading;
  original?: { sans: string[]; fromPly: number };
  tools?: ReactNode;
  branchUp?: boolean;
  menu?: ReactNode;
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
      {qualities && <QualityBadge quality={qualities[index]} reserveSpace loading={badgeLoading} />}
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
                {branchUp ? (
                  <CornerUpRight
                    className="branch-connector"
                    size={14}
                    aria-hidden="true"
                  />
                ) : (
                  <CornerDownRight
                    className="branch-connector"
                    size={14}
                    aria-hidden="true"
                  />
                )}
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
        {tools && <div className="board-actions">{tools}</div>}
        {menu && <div className="menu-slot">{menu}</div>}
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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimer = useRef<number | null>(null);
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
      {!analysisOnly &&
        (state.syncPending > 0 ||
          (state.historyTotal !== null &&
            state.historyTotal > state.saved.length)) && (
          <div className="saved-heading">
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
              <button
                type="button"
                className="saved-open"
                aria-label={`Analyze game · ${result}`}
                onClick={() => dispatch({ type: "review", id: game.id })}
              >
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
      {copiedId !== null && (
        <span role="status" className="visually-hidden">
          PGN copied to clipboard
        </span>
      )}
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
