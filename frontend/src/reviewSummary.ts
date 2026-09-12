import { candidateSan } from './domain';
import type { ReviewNode } from './reviewCoordinator';
import type { Quality } from './reviewMetrics';

export const issueLabels = ['Inaccuracy', 'Mistake', 'Blunder'] as const;
type IssueLabel = typeof issueLabels[number];
export type ReviewSide = 'white' | 'black';
export type SideSummary = {
  color: ReviewSide;
  total: number;
  reviewed: number;
  accuracy: number | null;
  issues: Record<IssueLabel, number>;
};
export type ReviewIssue = {
  beforePly: number;
  color: ReviewSide;
  moveNumber: number;
  san: string;
  label: IssueLabel;
  accuracy: number;
};

export function summarizeReview(nodes: readonly Pick<ReviewNode, 'fen' | 'moves'>[], qualities: readonly Quality[], onlySide?: ReviewSide) {
  const sides: SideSummary[] = (['white', 'black'] as const).map(color => ({
    color, total: 0, reviewed: 0, accuracy: null,
    issues: { Inaccuracy: 0, Mistake: 0, Blunder: 0 },
  }));
  const scores = { white: 0, black: 0 };
  const issues: ReviewIssue[] = [];
  for (let index = 0; index < nodes.length - 1; index++) {
    const fen = nodes[index].fen.split(' ');
    const color = (fen[1] === 'w' ? 'white' : 'black') as ReviewSide;
    if (onlySide && color !== onlySide) continue;
    const side = sides[color === 'white' ? 0 : 1];
    side.total++;
    const quality = qualities[index];
    if (!quality || quality.accuracy === null || quality.label === 'Unreviewed') continue;
    side.reviewed++;
    scores[side.color] += quality.accuracy;
    const label = issueLabels.find(label => label === quality.label);
    if (label) {
      side.issues[label]++;
      issues.push({ beforePly: index, color: side.color, moveNumber: Number(fen[5]),
        san: candidateSan(nodes[index].fen, nodes[index + 1].moves[index]), label, accuracy: quality.accuracy });
    }
  }
  for (const side of sides) side.accuracy = side.reviewed ? scores[side.color] / side.reviewed : null;
  const visible = onlySide ? sides.filter(side => side.color === onlySide) : sides;
  return { sides: visible, issues, total: visible.reduce((total, side) => total + side.total, 0), reviewed: visible.reduce((total, side) => total + side.reviewed, 0) };
}
