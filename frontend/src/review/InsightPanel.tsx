import { type Dispatch, type ReactNode } from "react";
import type { Action, State } from "../state/index";
import { Rating } from "../board/BoardTools";
import { Button, EngineSection, KeyMovesList } from "../components";
import { Chess } from "chess.js";
import type { Review } from "./useReview";
import { describeMove } from "./reviewMetrics";
import { deltaBaseline, deltaColumnTitle } from "../objective/winrate";
import { buildKeyMoves } from "./keyMoves";
import { bestLinePreview, playedCapture } from "../theory/material";
import { verdictInputsForPly } from "../theory/theory";
import { useLineOpenings } from "../theory/openings";
import { ReviewIssues, ReviewSummary } from "./ReviewOverview";
import { SkeletonList, SkeletonText } from "./ObjectiveBar";

// Footer action: the Analyze / Analyzed button owns the right
// end of the bottom button row. While running it is replaced in place by the progress
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
  const response = hasMove ? review.bot : review.botCurrent;
  const node = review.nodes[hasMove ? focus : ply];
  const candidates = hasMove ? review.objectiveCandidates.focus : review.objectiveCandidates.current;
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
  // Material consequence: the grading-lane walk rooted at the after-FEN
  // (bot-2400 tops, Stockfish-vetoed — never the Stockfish rank-1 PV, whose
  // first move the badge can grade as a mistake). Only cp-vs-cp
  // Mistake/Blunder render it (describeMove gates the labels; mate scores
  // stay silent so a forced mate is never reduced to a pawn note).
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
      review.objectiveBestLine.length ? review.objectiveBestLine : undefined,
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
  // (foreground fetch, restore, or batch) rather than genuinely absent. The
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
  // both, restore/batch fill the rest. Render as soon as the pair is
  // present regardless of batch progress (progress surfaces separately via
  // ReviewActionButton); skeleton only while a side is missing.
  const verdictLoading =
    hasMove && !!played && !verdict && !hasError && !tooLong && (!evaluation || !afterEvaluation);
  // Key moves card: one fused row per distinct move (Stockfish best, 2400
  // best by expected score, 2400 most-likely by policy, played) with the
  // 2400 share, the true game-shift delta (bar-vs-bar including the opponent
  // reply), and the viewed-Elo share. True deltas read from the child grading
  // rows the pipeline fetches; the builder falls back to the prospective
  // server/local comparison while a child is pending or failed.
  const beforePly = hasMove ? focus : ply;
  const beforeExpected = review.objective[beforePly]?.expected ?? null;
  const displayListed = response?.top_moves.slice(0, 5) ?? [];
  const objectiveEntries = candidates?.entries ?? [];
  const bestListed = objectiveEntries.length > 0
    ? Math.max(...objectiveEntries.map(candidate => candidate.expected))
    : null;
  const { kind } = deltaBaseline(beforeExpected, bestListed);
  const keyMoves = buildKeyMoves({
    sfBest: evaluation?.best_move ?? null,
    objective: candidates,
    displayTopMoves: displayListed,
    played,
    beforeExpected,
    trueDeltaByUci: review.trueDeltaByUci,
  });
  const deltaTitle = deltaColumnTitle(kind);
  const mineTitle = `Share of play at bot ${review.botElo}`;
  // Either bot lane renders the card: the objective lane alone still names
  // the 2400 rows (the viewed-Elo share reads — until the display lane
  // lands), mirroring how the old per-lane sections settled independently.
  // Missing sides stay em-dashes; only a fully empty card skeletons.
  const canRender = (!!response || !!candidates) && keyMoves.length > 0;
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
      <EngineSection
        label="Key moves"
        titleId="insight-title"
        title={
          <>
            You:{" "}
            <Rating
              inline
              id="analysis-rating"
              label={review.botLocked ? "Bot rating (game Elo)" : "Bot rating"}
              value={review.botLocked ? review.botElo : state.analysisSettings.botElo}
              disabled={review.botLocked || review.progress?.running}
              onChange={(botElo) =>
                dispatch({ type: "analysis-settings", settings: { botElo } })
              }
            />
          </>
        }
      >
        {response?.degraded && <p role="status">Bot fallback results.</p>}
        {candidates?.degraded && <p role="status">Bot 2400 fallback results.</p>}
        {review.botStale && (
          <p role="status">
            Showing bot {review.botElo} · updating to {review.botWantedElo}…
          </p>
        )}
        {canRender ? (
          <div id="insight-content">
            <KeyMovesList
              fen={insight.fen}
              played={played}
              hasMove={hasMove}
              previewUci={state.preview}
              moves={keyMoves}
              deltaTitle={deltaTitle}
              mineTitle={mineTitle}
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
        ) : displayLoading || objectiveLoading ? (
          <SkeletonList label="Loading key moves" rows={3} />
        ) : (
          <p className="empty-copy">No analysis yet.</p>
        )}
      </EngineSection>
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
  const inspect = (beforePly: number) => {
    // Issues name the before-position; the verdict now renders after the
    // move, so land one ply forward.
    dispatch({ type: "view", ply: beforePly + 1 });
    document.getElementById("board")?.scrollIntoView({ block: "start" });
  };
  // Graph points move the viewed position without leaving the analysis.
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
      <div className="analysis-section analysis-section--summary">
        <MoveAnalysis state={state} dispatch={dispatch} review={review} />
        <ReviewSummary
          review={review}
          ply={ply}
          userSide={userSide}
          branch={branch}
          onGraphView={viewInPlace}
        />
      </div>
      <div className="analysis-section">
        <ReviewIssues
          review={review}
          userSide={userSide}
          branch={branch}
          onInspect={inspect}
        />
      </div>
      <div className="analysis-section analysis-footer-section footer-row">
        <div className="footer-actions">{children}</div>
        <div className="footer-analyze">
          <ReviewActionButton state={state} review={review} />
        </div>
      </div>
    </aside>
  );
}
