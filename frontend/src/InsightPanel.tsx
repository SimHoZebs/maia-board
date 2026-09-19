import { useRef, useState, type Dispatch, type ReactNode } from "react";
import { TrendingDown, Users } from "lucide-react";
import type { Action, State } from "./state/index";
import { Rating } from "./BoardTools";
import { Button, EngineCandidateList, EngineSection } from "./components";
import { Chess } from "chess.js";
import type { Review } from "./useReview";
import { describeMove, outcomeExpected } from "./reviewMetrics";
import { fixedElo, sourceLabel } from "./objective";
import { formatWinrateDelta, maiaDisplayParts } from "./objective/maia";
import { bestLinePreview, playedCapture } from "./material";
import { verdictInputsForPly } from "./theory";
import { useLineOpenings } from "./openings";
import { ReviewIssues, ReviewSummary } from "./ReviewOverview";
import { SkeletonList, SkeletonText } from "./ObjectiveBar";

// Tab-bar action: the Analyze / Analyzed button owns the right
// end of the tab row. While running it is replaced in place by the progress
// status. Driven by the single reviewState (loading|partial|complete|failed).
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
  const label = branch ? 'Analyze explored line' : 'Analyze entire game';
  const doneLabel = branch ? 'Analyzed explored line' : 'Analyzed';
  switch (review.reviewState) {
    case 'complete':
      return branch ? (
        <Button variant="primary" aria-label={doneLabel} disabled onClick={review.start}>
          Analyzed
        </Button>
      ) : (
        <Button variant="primary" disabled>
          Analyzed
        </Button>
      );
    case 'loading':
      return (
        <Button variant="primary" aria-label="Loading analysis" disabled>
          Loading…
        </Button>
      );
    case 'failed':
    case 'partial':
    default:
      // Partial cache (including play-time saves with no analysis record yet)
      // is usable immediately: the batch server-hits cached positions and
      // only infers the missing ones. Failed batches retry from the same
      // button.
      return (
        <Button
          variant="primary"
          aria-label={label}
          disabled={review.tooLong}
          onClick={review.start}
        >
          Analyze
        </Button>
      );
  }
}

export function MoveAnalysis({
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
  // "(played)". At the root, candidates describe the current position.
  const focus = ply - 1;
  const hasMove = focus >= 0;
  // Two candidate lists: the display Elo's human-population list on the
  // left, the objective source on the right. Each list judges the displayed
  // move with "(played)" marking from its before-position; at the root the
  // current position's lists describe the position.
  const response = hasMove ? review.maia : review.maiaCurrent;
  const node = review.nodes[hasMove ? focus : ply];
  const candidates = hasMove ? review.objectiveCandidates.focus : review.objectiveCandidates.current;
  // Pinned Elo shown as a locked dropdown in the objective heading; null
  // hides it (sources without a rating).
  const objectiveElo = fixedElo();
  const insight = { fen: node.fen };
  const played = hasMove
    ? review.nodes[ply]?.uci ?? undefined
    : undefined;
  const evaluation = hasMove ? review.focus : review.current;
  const afterEvaluation = hasMove ? review.evaluations[ply] : undefined;
  // Named book lines outrank engine grades in the verdict: theory is calmer
  // than low-depth scores in the opening, and the name needs no inference.
  // Terminal facts (mate, stalemate, repetition) outrank even the book name.
  const { opening: lineOpening, bookFlags: lineBookFlags, matches: lineMatches } = useLineOpenings(review.timeline.moves, state.analysis.initialFen, ply);
  const exactOpening = lineOpening?.isExact ? { eco: lineOpening.eco, name: lineOpening.name } : null;
  // Material consequence: after-position rank-1 PV rooted at the after-FEN.
  // Only cp-vs-cp Mistake/Blunder render it (describeMove gates the labels;
  // mate scores stay silent so a forced mate is never reduced to a pawn note).
  // The preview bundles the note with its clickable SAN line so "This line"
  // always has an exact referent; the button below spawns the same UCIs as a
  // branch rooted at the current ply.
  const quality = hasMove ? review.qualities[focus] : undefined;
  const bestLine = hasMove && played && !exactOpening
    && (quality?.label === 'Mistake' || quality?.label === 'Blunder')
    && evaluation?.score.type === 'cp' && afterEvaluation?.score.type === 'cp'
    && !evaluation.terminal && !afterEvaluation.terminal
    ? bestLinePreview(
      review.nodes[ply].fen,
      afterEvaluation?.lines[0]?.pv,
      review.nodes[focus].turn === 'white' ? 'white' : 'black',
      state.bestLineWindow,
      playedCapture(review.nodes[focus].fen, played),
    ) : null;
  const materialNote = bestLine?.note ?? null;
  // Best move for pawn-note suppression: the highest-winrate objective
  // candidate when listed (max expected), else the grading best (objective
  // top else Stockfish best_move). "Doubles a pawn" reads as blame, so it
  // stays silent when the played move IS the best or the best incurs the
  // same structure damage.
  const winrateBest = candidates?.entries.length
    ? candidates.entries.reduce((a, b) => (b.expected > a.expected ? b : a)).uci
    : undefined;
  const bestUci = winrateBest ?? review.objective[focus]?.top ?? evaluation?.best_move ?? null;
  // Theory facts (terminal classification, dead draws, novelties, pawn
  // damage, positive whys) derive from the timeline rows, so branches
  // resolve through their own history. verdictInputsForPly owns fact gates;
  // describeMove's rule tables own priority and wording. Mate-force reads the
  // before/after score pair; the only-move fact reads the raw engine grade
  // (Critical), which the translated display quality cannot recover.
  const verdictFacts = hasMove && played
    ? verdictInputsForPly({
      beforeFen: review.nodes[focus].fen,
      afterFen: review.nodes[ply].fen,
      afterOutcome: review.nodes[ply].outcome,
      san: review.nodes[ply].san ?? played,
      playedUci: played,
      ply,
      quality,
      rarity: review.rarities?.[focus],
      opening: exactOpening,
      openingMatches: lineMatches,
      bookFlags: lineBookFlags,
      initialFen: state.analysis.initialFen,
      mover: review.nodes[focus].turn === 'white' ? 'white' : 'black',
      bestRarity: review.bestRarities?.[focus],
      rarity2400: review.rarity2400?.[focus],
      materialNote,
      bestUci,
      beforeScore: evaluation?.score ?? null,
      afterScore: afterEvaluation?.score ?? null,
      isCritical: review.engineGrades?.[focus]?.label === 'Critical',
      isTop: review.engineGrades?.[focus]?.label === 'Top',
      // Previous ply for recapture-as-exchange framing: the UCI arriving at
      // the before-position plus the FEN before it. Null at the game start.
      prevUci: focus >= 1 ? (review.nodes[focus]?.uci || null) : null,
      prevBeforeFen: focus >= 1 ? (review.nodes[focus - 1]?.fen ?? null) : null,
    })
    : null;
  const verdict = verdictFacts ? describeMove(verdictFacts) : null;
  const exploreBestLine = () => {
    if (!bestLine) return;
    // Single dispatch: explore-line goes through transition(), which already
    // clears the preview, so no separate preview-clear commit is needed.
    dispatch({ type: "explore-line", ucis: bestLine.ucis });
  };
  // Exploring a candidate means playing it instead of x, so step back to
  // x's before-position first: the reducer branches from the viewed position.
  const exploreFromFocus = (uci: string) => {
    dispatch({ type: "preview", uci: null });
    if (hasMove) dispatch({ type: "view", ply: focus });
    dispatch({ type: "explore", uci });
  };
  // Loading signals: a missing result with no recorded error is in-flight
  // (foreground fetch, prime, or batch) rather than genuinely absent. The
  // foreground lane fetches the displayed move's before/after pair on every
  // navigation. Lines longer than the review limit never fetch, so they stay
  // empty instead of skeleton-loading forever.
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
  const displayLoading = !response && !hasError && !terminalPosition && !tooLong;
  const objectiveLoading = !candidates && !node.outcome && !hasError && !terminalPosition && !tooLong;
  // The verdict needs both sides of the move; the foreground lane fetches
  // both, prime/batch backfill the rest. Render as soon as the pair is
  // present regardless of batch progress (progress surfaces separately via
  // ReviewActionButton); skeleton only while a side is missing.
  const verdictLoading =
    hasMove && !!played && !verdict && !hasError && !tooLong && (!evaluation || !afterEvaluation);
  // Display list values: policy share at the selected Elo plus winrate gain
  // from 2400's perspective. The played row (when present in the top 5) uses
  // the true temporal delta: after-position 2400 point (opponent-relative,
  // so inverted, or the terminal outcome) minus the before-position 2400
  // point — the same before/after the grades read. Hypothetical rows have no
  // after-position, so they use the within-row child value minus the before
  // point (no opponent reply yet). Without an objective point yet everything
  // falls back to the best listed winrate.
  const beforePly = hasMove ? focus : ply;
  const beforeExpected = review.objective[beforePly]?.expected ?? null;
  const afterPoint = hasMove ? review.objective[ply] : undefined;
  const afterMoverExpected = hasMove
    ? (outcomeExpected(review.nodes[ply]?.outcome) ?? (afterPoint?.expected != null ? 100 - afterPoint.expected : null))
    : null;
  const playedGain = hasMove && beforeExpected != null && afterMoverExpected != null
    ? afterMoverExpected - beforeExpected : null;
  const displayListed = response?.top_moves.slice(0, 5) ?? [];
  const objectiveEntries = candidates?.entries ?? [];
  const objectiveHasProb = objectiveEntries.length > 0
    && objectiveEntries.every(candidate => typeof candidate.prob === 'number' && Number.isFinite(candidate.prob));
  const objectiveBest = objectiveHasProb ? Math.max(...objectiveEntries.map(candidate => candidate.expected)) : 0;
  const baseline = beforeExpected ?? (objectiveHasProb ? objectiveBest : null);
  const displayParts = maiaDisplayParts(displayListed, baseline).map((part, index) => (
    playedGain != null && hasMove && displayListed[index]?.move === played
      ? { ...part, delta: formatWinrateDelta(playedGain) } : part));
  // One header set for both Maia lanes: play probability (Users) plus
  // win-rate gain vs the before position (TrendingDown). The display lane
  // carries low-Elo policy with 2400 values; the objective lane is 2400
  // throughout. The objective lane only gets it
  // when the provider supplies probabilities (Maia policy share); a lane
  // without them (Stockfish lines) keeps its single absolute-value column.
  const deltaTitle = beforeExpected != null
    ? "Win-rate gain versus position before move"
    : baseline != null
      ? "Win-rate change versus 2400 best"
      : "Win-rate change versus best listed move";
  const maiaListHeaders = {
    metric: <span title="Share of human play at this rating"><Users size={13} aria-hidden="true" /></span>,
    delta: <span title={deltaTitle}><TrendingDown size={13} aria-hidden="true" /></span>,
    label: `Probability of play, ${deltaTitle.charAt(0).toLowerCase()}${deltaTitle.slice(1)}`,
  };
  return (
    <>
      {!hasMove && <p className="move-verdict" role="status">Current position — explore a candidate or step forward to review a move.</p>}
      {verdict ? (
        <p className="move-verdict" role="status">
          {verdict}
          {bestLine && (
            <>
              {' '}
              <button
                type="button"
                className="verdict-line"
                onClick={exploreBestLine}
                aria-label={`Explore best line ${bestLine.text}`}
              >
                {bestLine.text}
              </button>
            </>
          )}
        </p>
      ) : (
        verdictLoading && <SkeletonText label="Loading move verdict" />
      )}
      <div className="engine-duo">
      <EngineSection
        label="Maia analysis"
        titleId="insight-title"
        dotClass="source-display"
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
        {response?.degraded && <p role="status">Maia fallback results.</p>}
        {review.maiaStale && (
          <p role="status">
            Showing Maia {review.maiaElo} · updating to {review.maiaWantedElo}…
          </p>
        )}
        {response ? (
          <div id="insight-content">
            <EngineCandidateList
              fen={insight.fen}
              played={played}
              hasMove={hasMove}
              previewUci={state.preview}
              items={displayListed.map((candidate, index) => ({
                uci: candidate.move,
                metric: displayParts[index].prob,
                delta: displayParts[index].delta,
              }))}
              headers={maiaListHeaders}
              onPreview={(uci) => dispatch({ type: "preview", uci })}
              onClear={() => dispatch({ type: "preview", uci: null })}
              onSelect={exploreFromFocus}
            />
          </div>
        ) : displayLoading ? (
          <SkeletonList label="Loading Maia moves" rows={3} />
        ) : (
          <p className="empty-copy">No analysis yet.</p>
        )}
      </EngineSection>
      <EngineSection
        label={sourceLabel()}
        dotClass="source-objective"
        title={
          <>
            Maia •{" "}
            {objectiveElo !== null && (
              <Rating
                inline
                id="objective-rating"
                label="Objective rating"
                value={objectiveElo}
                disabled
                onChange={() => undefined}
              />
            )}
          </>
        }
      >
        {candidates?.degraded && <p role="status">Maia3 fallback results.</p>}
        {candidates ? (
          <div>
            <EngineCandidateList
              fen={insight.fen}
              played={played}
              hasMove={hasMove}
              previewUci={state.preview}
              items={objectiveEntries.map((candidate) => (objectiveHasProb
                ? {
                  uci: candidate.uci,
                  metric: `${Math.round(candidate.prob! * 100)}%`,
                  delta: formatWinrateDelta(hasMove && playedGain != null && candidate.uci === played
                    ? playedGain : candidate.expected - (beforeExpected ?? objectiveBest)),
                }
                : { uci: candidate.uci, metric: `${Math.round(candidate.expected)}%` }))}
              headers={objectiveHasProb ? maiaListHeaders : {
                metric: <span title="Expected win rate for the side to move"><TrendingDown size={13} aria-hidden="true" /></span>,
                label: "Expected win rate for the side to move",
              }}
              onPreview={(uci) => dispatch({ type: "preview", uci })}
              onClear={() => dispatch({ type: "preview", uci: null })}
              onSelect={exploreFromFocus}
            />
          </div>
        ) : node.outcome ? (
          <p className="empty-copy" role="status">
            {node.outcome.kind === 'checkmate'
              ? `${node.outcome.winner === 'white' ? 'White' : 'Black'} wins`
              : 'Draw'}
          </p>
        ) : objectiveLoading ? (
          <SkeletonList label="Loading objective moves" rows={3} />
        ) : (
          <p className="empty-copy">No analysis yet.</p>
        )}
      </EngineSection>
      </div>
    </>
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
  const [tab, setTab] = useState<"moves" | "issues">("moves");
  const moveTab = useRef<HTMLButtonElement>(null);
  const issuesTab = useRef<HTMLButtonElement>(null);
  const tabs = [
    { id: "moves", label: "Move analysis", ref: moveTab },
    { id: "issues", label: "Moves to review", ref: issuesTab },
  ] as const;
  const inspect = (beforePly: number) => {
    setTab("moves");
    // Issues name the before-position; the verdict now renders after the
    // move, so land one ply forward.
    dispatch({ type: "view", ply: beforePly + 1 });
    moveTab.current?.focus({ preventScroll: true });
    document.getElementById("board")?.scrollIntoView({ block: "start" });
  };
  // Graph points move the viewed position without leaving the Move analysis
  // tab: the selection marker follows and the board updates underneath.
  const viewInPlace = (ply: number) => {
    dispatch({ type: "view", ply });
  };
  const showControls =
    review.tooLong ||
    !!review.error ||
    !!review.progress?.failed;
  const userSide = state.analysis.ownGame ? state.analysis.perspective : undefined;
  const branch = state.analysis.branchFromPly !== null;
  const ply = state.analysis.index;
  return (
    <aside className="panel insight-panel" aria-label="Game analysis">
      <div className="analysis-tabs">
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
          <>
            <MoveAnalysis state={state} dispatch={dispatch} review={review} />
            <ReviewSummary
              review={review}
              ply={ply}
              userSide={userSide}
              branch={branch}
              onGraphView={viewInPlace}
            />
          </>
        )}
      </div>
      <div
        className="analysis-section"
        role="tabpanel"
        id="analysis-panel-issues"
        aria-labelledby="analysis-tab-issues"
        hidden={tab !== "issues"}
        tabIndex={0}
      >
        {tab === "issues" && (
          <ReviewIssues
            review={review}
            userSide={userSide}
            branch={branch}
            onInspect={inspect}
          />
        )}
      </div>
      {children && <div className="analysis-section analysis-footer-section">{children}</div>}
    </aside>
  );
}
