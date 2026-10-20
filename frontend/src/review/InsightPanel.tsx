import { type Dispatch, type ReactNode } from 'react';
import type { Action, State } from '../state/index';
import { Button, KeyMovesList } from '../components';
import { expectNonNull, plyAt, plyOrNull } from '../shared/explicit';
import type { Review } from './useReview';
import { describeMove } from './reviewMetrics';
import { deltaBaseline, deltaColumnTitle } from '../objective/winrate';
import { buildKeyMoves } from './keyMoves';
import { bestLinePreview, playedCapture } from '../theory/material';
import {
  BEST_LINE_SOURCE,
  resolveBestLineUcis,
  stockfishBestLineUcis,
} from '../theory/bestLineSource';
import { verdictInputsForPly } from '../theory/theory';
import { useLineOpenings } from '../theory/openings';
import { ReviewIssues, ReviewSummary } from './ReviewOverview';
import { SkeletonList, SkeletonText } from './ObjectiveBar';

// Footer action: the Analyze / Analyzed button owns the right
// end of the bottom button row. While running it is replaced in place by the progress
// status. Driven by the single reviewState (loading|partial|complete|failed).
function ReviewActionButton({ state, review }: { state: State; review: Review }) {
  const progress = review.progress;
  if (progress !== null && progress.running) {
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
  // left, the objective source on the right.
  const response = hasMove ? review.bot : review.botCurrent;
  // Indexed rows must exist: a ply in range always has a timeline node.
  // Out-of-range is a failure (throw), never silent `undefined`.
  const node = expectNonNull(
    review.nodes[hasMove ? focus : ply],
    `missing timeline node at ply ${hasMove ? focus : ply}`,
  );
  const candidates = hasMove
    ? review.objectiveCandidates.focus
    : review.objectiveCandidates.current;
  const insight = { fen: node.fen };
  const tipNode = hasMove
    ? expectNonNull(review.nodes[ply], `missing timeline node at ply ${ply}`)
    : null;
  // The UCI into the viewed position. Null at the root; empty anywhere else
  // is a failure, not a quiet skip.
  const played: string | null = tipNode === null ? null : tipNode.uci;
  if (hasMove && (played === null || played === '')) {
    throw new Error(`maia-board invariant: missing played UCI at ply ${ply}`);
  }
  const evaluation = hasMove ? review.focus : review.current;
  const afterEvaluation = hasMove ? plyAt(review.evaluations, ply, 'evaluations') : null;
  // Named book lines outrank engine grades in the verdict: theory is calmer
  // than low-depth scores in the opening, and the name needs no inference.
  // Terminal facts (mate, stalemate, repetition) outrank even the book name.
  const {
    opening: lineOpening,
    bookFlags: lineBookFlags,
    matches: lineMatches,
  } = useLineOpenings(review.timeline.moves, state.analysis.initialFen, ply);
  const exactOpening =
    lineOpening !== null && lineOpening.isExact
      ? { eco: lineOpening.eco, name: lineOpening.name }
      : null;
  // Material consequence: the Stockfish rank-1 PV rooted at the after-FEN
  // (see theory/bestLineSource.ts for the provider switch). Only cp-vs-cp
  // Mistake/Blunder render it (describeMove gates the labels; mate scores
  // stay silent so a forced mate is never reduced to a pawn note).
  // The preview bundles the note with its clickable SAN line so "This line"
  // always has an exact referent; the button below spawns the same UCIs as a
  // branch rooted at the current ply.
  const quality = hasMove ? plyAt(review.qualities, focus, 'qualities') : null;
  // Before/after rows for the viewed move. Missing evaluations are pending,
  // not silent — the gates below read them explicitly.
  const beforeNode = hasMove
    ? expectNonNull(review.nodes[focus], `missing timeline node at ply ${focus}`)
    : null;
  const afterNode =
    tipNode ?? expectNonNull(review.nodes[ply], `missing timeline node at ply ${ply}`);
  const qualityLabel = quality === null ? null : quality.label;
  const evalScore = evaluation === null ? null : evaluation.score;
  const afterScore = afterEvaluation === null ? null : afterEvaluation.score;
  const bestLine =
    hasMove &&
    played !== null &&
    beforeNode !== null &&
    !exactOpening &&
    (qualityLabel === 'Mistake' || qualityLabel === 'Blunder') &&
    evalScore !== null &&
    evalScore.type === 'cp' &&
    afterScore !== null &&
    afterScore.type === 'cp' &&
    evaluation !== null &&
    afterEvaluation !== null &&
    !evaluation.terminal &&
    !afterEvaluation.terminal
      ? bestLinePreview(
          afterNode.fen,
          resolveBestLineUcis({
            source: BEST_LINE_SOURCE,
            stockfishUcis: stockfishBestLineUcis(afterEvaluation, state.bestLineWindow),
            maiaUcis: review.objectiveBestLine.length ? review.objectiveBestLine : undefined,
          }),
          beforeNode.turn === 'white' ? 'white' : 'black',
          state.bestLineWindow,
          playedCapture(beforeNode.fen, played),
        )
      : null;
  const materialNote = bestLine === null ? null : bestLine.note;
  // Best move for pawn-note suppression: the highest-winrate objective
  // candidate when listed (max expected), else the grading best (objective
  // top else Stockfish best_move). Each source is explicit — a missing lane
  // (loading/failed) falls through to the next source by name, never via a
  // collapsed `?.` chain.
  const winrateBest: { uci: string; source: 'winrate' } | null =
    candidates !== null && candidates.entries.length > 0
      ? {
          uci: candidates.entries.reduce((a, b) => (b.expected > a.expected ? b : a)).uci,
          source: 'winrate',
        }
      : null;
  const focusObjectivePoint = hasMove ? plyAt(review.objective, focus, 'objective points') : null;
  const focusObjectiveTop =
    focusObjectivePoint === null || focusObjectivePoint.top === null
      ? null
      : focusObjectivePoint.top;
  const objectiveTop: { uci: string; source: 'objective' } | null =
    winrateBest !== null || focusObjectiveTop === null
      ? null
      : { uci: focusObjectiveTop, source: 'objective' };
  const sfBest: { uci: string; source: 'stockfish' } | null =
    winrateBest !== null || objectiveTop !== null
      ? null
      : evaluation === null || evaluation.best_move === null
        ? null
        : { uci: evaluation.best_move, source: 'stockfish' };
  const bestUci =
    winrateBest !== null
      ? winrateBest.uci
      : objectiveTop !== null
        ? objectiveTop.uci
        : sfBest !== null
          ? sfBest.uci
          : null;
  // Theory facts (terminal classification, dead draws, novelties, pawn
  // damage, positive whys) derive from the timeline rows, so branches
  // resolve through their own history. verdictInputsForPly owns fact gates;
  // describeMove's rule tables own priority and wording. Mate-force reads the
  // before/after score pair; the only-move fact reads the raw engine grade
  // (Critical), which the translated display quality cannot recover.
  // Previous ply for recapture-as-exchange framing: the UCI arriving at
  // the before-position plus the FEN before it. Null at the game start;
  // empty UCIs are failures upstream, so here empty reads as null by name.
  const prevNode = focus >= 1 ? plyAt(review.nodes, focus, 'nodes') : null;
  const prevBeforeNode = focus >= 1 ? plyAt(review.nodes, focus - 1, 'nodes') : null;
  const prevUci: string | null =
    focus >= 1 ? (prevNode !== null && prevNode.uci !== '' ? prevNode.uci : null) : null;
  const prevBeforeFen: string | null =
    focus >= 1 ? (prevBeforeNode !== null ? prevBeforeNode.fen : null) : null;
  const verdictFacts =
    hasMove && played !== null && beforeNode !== null
      ? verdictInputsForPly({
          beforeFen: beforeNode.fen,
          beforeCheck: beforeNode.check,
          afterFen: afterNode.fen,
          afterOutcome: afterNode.outcome,
          san: afterNode.san !== '' ? afterNode.san : played,
          playedUci: played,
          ply,
          quality,
          rarity: plyAt(review.rarities, focus, 'rarities'),
          opening: exactOpening,
          openingMatches: lineMatches,
          bookFlags: lineBookFlags,
          initialFen: state.analysis.initialFen,
          mover: beforeNode.turn === 'white' ? 'white' : 'black',
          bestRarity: plyOrNull(review.bestRarities, focus, 'best rarities'),
          rarity2400: plyOrNull(review.rarity2400, focus, '2400 rarities'),
          materialNote,
          bestUci,
          beforeScore: evaluation === null ? null : evaluation.score,
          afterScore: afterEvaluation === null ? null : afterEvaluation.score,
          isCritical: plyOrNull(review.engineGrades, focus, 'engine grades')?.label === 'Critical',
          isTop: plyOrNull(review.engineGrades, focus, 'engine grades')?.label === 'Top',
          prevUci,
          prevBeforeFen,
        })
      : null;
  const verdict = verdictFacts ? describeMove(verdictFacts) : null;
  const exploreBestLine = () => {
    if (!bestLine) return;
    dispatch({ type: 'explore-line', ucis: bestLine.ucis });
  };
  // Exploring a candidate means playing it instead of x, so step back to
  // x's before-position first: the reducer branches from the viewed position.
  // Replaying the already-played move is timeline navigation, not
  // exploration: land back on x without forking a duplicate branch.
  const exploreFromFocus = (uci: string) => {
    if (hasMove && uci === played) {
      dispatch({ type: 'view', ply });
      return;
    }
    if (hasMove) dispatch({ type: 'view', ply: focus });
    dispatch({ type: 'explore', uci });
  };
  // Loading signals: a missing result with no recorded error is in-flight
  // (foreground fetch, restore, or batch) rather than genuinely absent. The
  // foreground lane fetches the displayed move's before/after pair on every
  // navigation. Lines longer than the review limit never fetch, so they stay
  // empty instead of skeleton-loading forever.
  // Focus is always x's before-position, which is never terminal in a legal
  // line; the timeline outcome is the safety net (history-aware: FEN parses
  // miss threefold repetition).
  const hasError = typeof review.error === 'string' && review.error !== '';
  const tooLong = review.nodes.length > 257;
  // Terminality reads the history-aware timeline outcome, never a FEN parse
  // (which misses threefold repetition). No try/catch fallback: an illegal
  // FEN is a failure upstream, not a quiet `false` here.
  const terminalPosition =
    (evaluation !== null && evaluation.terminal !== null) || node.outcome !== null;
  const displayLoading = response === null && !hasError && !terminalPosition && !tooLong;
  const objectiveLoading =
    candidates === null && !node.outcome && !hasError && !terminalPosition && !tooLong;
  // The verdict needs both sides of the move; the foreground lane fetches
  // both, restore/batch fill the rest. Render as soon as the pair is
  // present regardless of batch progress (progress surfaces separately via
  // ReviewActionButton); skeleton only while a side is missing.
  const verdictLoading =
    hasMove &&
    played !== null &&
    !verdict &&
    !hasError &&
    !tooLong &&
    (evaluation === null || afterEvaluation === null);
  // Key moves card: one fused row per distinct move (Stockfish best, 2400
  // best by expected score, 2400 most-likely by policy, played) with the
  // 2400 share, the true game-shift delta (bar-vs-bar including the opponent
  // reply), and the viewed-Elo share. True deltas read from the child grading
  // rows the pipeline fetches; the builder falls back to the prospective
  // server/local comparison while a child is pending or failed.
  const beforePly = hasMove ? focus : ply;
  // Missing rows are pending/failed, not silent: each source branches by
  // name into its empty state instead of a collapsed `?. ??` chain.
  const beforePoint = plyAt(review.objective, beforePly, 'objective points');
  const beforeExpected = beforePoint === null ? null : beforePoint.expected;
  const displayListed = response === null ? [] : response.top_moves.slice(0, 5);
  const objectiveEntries = candidates === null ? [] : candidates.entries;
  const bestListed =
    objectiveEntries.length > 0
      ? Math.max(...objectiveEntries.map(candidate => candidate.expected))
      : null;
  const { kind } = deltaBaseline(beforeExpected, bestListed);
  const keyMoves = buildKeyMoves({
    sfBest: evaluation === null ? null : evaluation.best_move,
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
  const canRender = (response !== null || candidates !== null) && keyMoves.length > 0;
  return (
    <>
      {!hasMove && (
        <p className="move-verdict" role="status">
          Current position — explore a candidate or step forward to review a move.
        </p>
      )}
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
      <section aria-label="Key moves" className="engine-card">
        {response !== null && response.degraded && <p role="status">Bot fallback results.</p>}
        {candidates !== null && candidates.degraded && (
          <p role="status">Bot 2400 fallback results.</p>
        )}
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
              moves={keyMoves}
              deltaTitle={deltaTitle}
              mineTitle={mineTitle}
              objectiveColor={state.arrows.objective.color}
              botColor={state.arrows.bot.color}
              stockfishColor={state.arrows.stockfish.color}
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
      </section>
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
    dispatch({ type: 'view', ply: beforePly + 1 });
    document.getElementById('board')?.scrollIntoView({ block: 'start' });
  };
  // Graph points move the viewed position without leaving the analysis.
  const viewInPlace = (ply: number) => {
    dispatch({ type: 'view', ply });
  };
  const batchFailed = review.progress !== null && review.progress.failed > 0;
  const failedJobs = review.progress === null ? 0 : review.progress.failed;
  const showControls = review.tooLong || !!review.error || batchFailed;
  const userSide = state.analysis.ownGame ? state.analysis.perspective : null;
  const branch = state.analysis.branchFromPly !== null;
  const ply = state.analysis.index;
  return (
    <aside className="panel insight-panel" aria-label="Game analysis">
      {showControls && (
        <div className="analysis-section analysis-controls-section">
          {review.tooLong && <p role="status">Review supports up to 256 moves (plies).</p>}
          {(review.error || batchFailed) && (
            <p role="alert">
              {review.error || `${failedJobs} analysis jobs failed.`}{' '}
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
        <ReviewIssues review={review} userSide={userSide} branch={branch} onInspect={inspect} />
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
