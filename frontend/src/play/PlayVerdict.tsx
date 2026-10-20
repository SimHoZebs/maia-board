import type { State } from '../state/index';
import { START_FEN } from '../shared/domain';
import { plyAt, plyOrNull } from '../shared/explicit';
import { bestLinePreview, playedCapture } from '../theory/material';
import {
  BEST_LINE_SOURCE,
  resolveBestLineUcis,
  stockfishBestLineUcis,
} from '../theory/bestLineSource';
import { useLineOpenings } from '../theory/openings';
import { describeMove, botRarity } from '../review/reviewMetrics';
import { verdictInputsForPly } from '../theory/theory';
import { SkeletonText } from '../review/ObjectiveBar';
import type { PlayFeedback } from '../review/useReviewPipeline';

// Empty verdicts keep their line so the play layout does not jump when the
// verdict shows on the user's move and clears on the AI reply. Hidden from
// assistive tech: there is no content to announce.
function VerdictPlaceholder() {
  return (
    <p className="move-verdict play-verdict-empty" aria-hidden="true">
      {'\u00a0'}
    </p>
  );
}

// In-play verdict line, rendered under the move list when the option is on.
// Mirrors MoveAnalysis verdict wiring but on the play timeline: user-side
// grades only (opponent moves stay quiet except terminal/book facts), no
// explore-line button, no candidate lists.
export function PlayVerdict({ state, feedback }: { state: State; feedback: PlayFeedback }) {
  const moves = state.play.moves;
  const ply = state.viewedPly ?? moves.length;
  const {
    opening: lineOpening,
    bookFlags: lineBookFlags,
    matches: lineMatches,
  } = useLineOpenings(moves, START_FEN, ply);
  if (!state.playVerdict || !feedback.active) return null;
  const before = ply - 1;
  // Reserve the verdict line even before the first move or while the
  // timeline is settling so the first verdict does not push content down.
  if (before < 0) return <VerdictPlaceholder />;
  const timeline = feedback.timeline;
  const nodes = feedback.nodes;
  if (ply >= nodes.length || before >= timeline.moves.length) return <VerdictPlaceholder />;
  const beforeNode = plyAt(nodes, before, 'play nodes');
  const afterNode = plyAt(nodes, ply, 'play nodes');
  const played = afterNode.uci !== '' ? afterNode.uci : null;
  if (played === null) return <VerdictPlaceholder />;
  const quality = plyAt(feedback.qualities, before, 'play qualities');
  const move = plyAt(timeline.moves, before, 'play moves');
  const bot = plyAt(feedback.botResults, before, 'play bot results');
  const rarity = botRarity(bot, move);
  const objectivePoint = plyAt(feedback.objectivePoints, before, 'play objective points');
  const settledEval = plyAt(feedback.evaluations, before, 'play evaluations');
  const best = objectivePoint === null ? null : objectivePoint.top;
  const bestMove = best ?? (settledEval === null ? null : settledEval.best_move);
  const bestBot = plyAt(feedback.botResults, before, 'play bot results');
  const bestRarity = bestMove !== null ? botRarity(bestBot, bestMove) : null;
  const evaluation = plyAt(feedback.evaluations, before, 'play evaluations');
  const afterEvaluation = plyAt(feedback.evaluations, ply, 'play evaluations');
  const mover = beforeNode.turn === 'white' ? 'white' : 'black';
  const exactOpening =
    lineOpening !== null && lineOpening.isExact
      ? { eco: lineOpening.eco, name: lineOpening.name }
      : null;
  // Stockfish rank-1 PV (see theory/bestLineSource.ts) instead of the
  // grading-lane walk. PlayVerdict renders the note only (no explore
  // button); no frontier fetch is needed — the PV rides the already-fetched
  // after-position evaluation.
  // Best-line note for Blunder/Mistake only; every other shape (including
  // a missing preview) reads as no note — named once, never `?.`-chained.
  const bestLineNote = (() => {
    if (
      quality === null ||
      played === null ||
      exactOpening !== null ||
      (quality.label !== 'Mistake' && quality.label !== 'Blunder') ||
      evaluation === null ||
      evaluation.score.type !== 'cp' ||
      afterEvaluation === null ||
      afterEvaluation.score.type !== 'cp' ||
      evaluation.terminal !== null ||
      afterEvaluation.terminal !== null
    )
      return null;
    const preview = bestLinePreview(
      afterNode.fen,
      resolveBestLineUcis({
        source: BEST_LINE_SOURCE,
        stockfishUcis: stockfishBestLineUcis(afterEvaluation, state.bestLineWindow),
        maiaUcis: feedback.objectiveBestLine.length > 0 ? feedback.objectiveBestLine : null,
      }),
      mover,
      state.bestLineWindow,
      playedCapture(beforeNode.fen, played),
    );
    return preview === null ? null : preview.note;
  })();
  const materialNote = bestLineNote;
  const focusGrade = plyOrNull(feedback.engineGrades, before, 'play engine grades');
  const facts = verdictInputsForPly({
    beforeFen: beforeNode.fen,
    beforeCheck: beforeNode.check,
    afterFen: afterNode.fen,
    afterOutcome: afterNode.outcome,
    san: afterNode.san !== '' ? afterNode.san : played,
    playedUci: played,
    ply,
    quality,
    rarity,
    opening: exactOpening,
    openingMatches: lineMatches,
    bookFlags: lineBookFlags,
    initialFen: START_FEN,
    mover,
    bestRarity,
    materialNote,
    // No 2400 lane in the play room: cross-Elo notes stay off by name.
    rarity2400: null,
    // Highest-winrate proxy for pawn-note suppression (no candidate list in
    // play room): objective top else Stockfish best. "Doubles a pawn" stays
    // silent when the played move IS the best or the best incurs the same
    // damage.
    bestUci: bestMove,
    beforeScore: evaluation === null ? null : evaluation.score,
    afterScore: afterEvaluation === null ? null : afterEvaluation.score,
    isCritical: focusGrade !== null && focusGrade.label === 'Critical',
    isTop: focusGrade !== null && focusGrade.label === 'Top',
    prevUci: before >= 1 ? plyAt(nodes, before, 'play nodes').uci || null : null,
    prevBeforeFen: before >= 1 ? plyAt(nodes, before - 1, 'play nodes').fen : null,
  });
  const verdict = describeMove(facts);
  if (verdict)
    return (
      <p className="move-verdict" role="status">
        {verdict}
      </p>
    );
  const tooLong = timeline.moves.length > 256;
  const hasError = feedback.error !== null;
  const isUserMove = mover === state.play.settings.userColor;
  // Opponent moves, failed evaluations, and overlong lines never produce a
  // verdict, but the reserved line stays so the layout does not collapse
  // between the user's move and the AI reply.
  if (hasError || tooLong || !isUserMove) return <VerdictPlaceholder />;
  if (
    evaluation === null ||
    afterEvaluation === null ||
    (quality !== null && quality.label === 'Unreviewed')
  ) {
    return <SkeletonText label="Loading move verdict" />;
  }
  return <VerdictPlaceholder />;
}
