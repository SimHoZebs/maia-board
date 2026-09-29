import type { State } from './state/index';
import { START_FEN } from './domain';
import { bestLinePreview, playedCapture } from './material';
import { useLineOpenings } from './openings';
import { describeMove, botRarity } from './reviewMetrics';
import { verdictInputsForPly } from './theory';
import { SkeletonText } from './ObjectiveBar';
import type { PlayFeedback } from './useReviewPipeline';

// Empty verdicts keep their line so the play layout does not jump when the
// verdict shows on the user's move and clears on the AI reply. Hidden from
// assistive tech: there is no content to announce.
function VerdictPlaceholder() {
  return <p className="move-verdict play-verdict-empty" aria-hidden="true">{'\u00a0'}</p>;
}

// In-play verdict line, rendered under the move list when the option is on.
// Mirrors MoveAnalysis verdict wiring but on the play timeline: user-side
// grades only (opponent moves stay quiet except terminal/book facts), no
// explore-line button, no candidate lists.
export function PlayVerdict({ state, feedback }: { state: State; feedback: PlayFeedback }) {
  const moves = state.play.moves;
  const ply = state.viewedPly ?? moves.length;
  const { opening: lineOpening, bookFlags: lineBookFlags, matches: lineMatches } = useLineOpenings(moves, START_FEN, ply);
  if (!state.playVerdict || !feedback.active) return null;
  const focus = ply - 1;
  // Reserve the verdict line even before the first move or while the
  // timeline is settling so the first verdict does not push content down.
  if (focus < 0) return <VerdictPlaceholder />;
  const timeline = feedback.timeline;
  const nodes = feedback.nodes;
  if (ply >= nodes.length || focus >= timeline.moves.length) return <VerdictPlaceholder />;
  const beforeNode = nodes[focus];
  const afterNode = nodes[ply];
  if (!beforeNode || !afterNode) return <VerdictPlaceholder />;
  const played = afterNode.uci || undefined;
  if (!played) return <VerdictPlaceholder />;
  const quality = feedback.qualities[focus];
  const move = timeline.moves[focus];
  const bot = feedback.botResults[focus];
  const rarity = move && bot ? botRarity(bot, move) : undefined;
  const best = feedback.objectivePoints[focus]?.top ?? feedback.evaluations[focus]?.best_move;
  const bestBot = feedback.botResults[focus];
  const bestRarity = best && bestBot ? botRarity(bestBot, best) : undefined;
  const evaluation = feedback.evaluations[focus];
  const afterEvaluation = feedback.evaluations[ply];
  const mover = beforeNode.turn === 'white' ? 'white' : 'black';
  const exactOpening = lineOpening?.isExact ? { eco: lineOpening.eco, name: lineOpening.name } : null;
  const materialNote = quality && played && !exactOpening
    && (quality.label === 'Mistake' || quality.label === 'Blunder')
    && evaluation?.score.type === 'cp' && afterEvaluation?.score.type === 'cp'
    && !evaluation.terminal && !afterEvaluation.terminal
    ? bestLinePreview(afterNode.fen, afterEvaluation?.lines[0]?.pv, mover, state.bestLineWindow, playedCapture(beforeNode.fen, played))?.note ?? null
    : null;
  const facts = verdictInputsForPly({
    beforeFen: beforeNode.fen,
    afterFen: afterNode.fen,
    afterOutcome: afterNode.outcome,
    san: afterNode.san || played,
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
    // Highest-winrate proxy for pawn-note suppression (no candidate list in
    // play room): objective top else Stockfish best. "Doubles a pawn" stays
    // silent when the played move IS the best or the best incurs the same
    // damage.
    bestUci: best ?? null,
    beforeScore: evaluation?.score ?? null,
    afterScore: afterEvaluation?.score ?? null,
    isCritical: feedback.engineGrades[focus]?.label === 'Critical',
    prevUci: focus >= 1 ? (nodes[focus]?.uci || null) : null,
    prevBeforeFen: focus >= 1 ? (nodes[focus - 1]?.fen ?? null) : null,
  });
  const verdict = describeMove(facts);
  if (verdict) return <p className="move-verdict" role="status">{verdict}</p>;
  const tooLong = timeline.moves.length > 256;
  const hasError = !!feedback.error;
  const isUserMove = mover === state.play.settings.userColor;
  // Opponent moves, failed evaluations, and overlong lines never produce a
  // verdict, but the reserved line stays so the layout does not collapse
  // between the user's move and the AI reply.
  if (hasError || tooLong || !isUserMove) return <VerdictPlaceholder />;
  if (!evaluation || !afterEvaluation || quality?.label === 'Unreviewed') {
    return <SkeletonText label="Loading move verdict" />;
  }
  return <VerdictPlaceholder />;
}
