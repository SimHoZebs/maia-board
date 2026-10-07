import type { ReviewNode } from './reviewCoordinator';
import type { Quality } from './reviewMetrics';

export const issueLabels = ['Inaccuracy', 'Mistake', 'Blunder', 'Allowed mate'] as const;
type IssueLabel = typeof issueLabels[number];
// Compact chip row order: praise first, then neutral, then errors.
export const countLabels = ['Alien', 'Excellent', 'Great', 'Best', 'Good', 'Forced', 'Inaccuracy', 'Mistake', 'Blunder', 'Allowed mate'] as const;
export type CountLabel = typeof countLabels[number];
export type ReviewSide = 'white' | 'black';
export type SideSummary = {
  color: ReviewSide;
  total: number;
  reviewed: number;
  accuracy: number | null;
  issues: Record<IssueLabel, number>;
  counts: Record<CountLabel, number>;
};
export type ReviewIssue = {
  beforePly: number;
  color: ReviewSide;
  moveNumber: number;
  san: string;
  label: IssueLabel;
  accuracy: number;
};

export function summarizeReview(nodes: readonly Pick<ReviewNode, 'turn' | 'ply' | 'san' | 'uci' | 'fen'>[], qualities: readonly (Quality | undefined)[], onlySide?: ReviewSide) {
  const sides: SideSummary[] = (['white', 'black'] as const).map(color => ({
    color, total: 0, reviewed: 0, accuracy: null,
    issues: { Inaccuracy: 0, Mistake: 0, Blunder: 0, 'Allowed mate': 0 },
    counts: { Alien: 0, Excellent: 0, Great: 0, Best: 0, Good: 0, Forced: 0, Inaccuracy: 0, Mistake: 0, Blunder: 0, 'Allowed mate': 0 },
  }));
  const scores = { white: 0, black: 0 };
  const issues: ReviewIssue[] = [];
  // Move numbers derive from the root's fullmove + ply, not per-row FEN
  // splits. Color comes from the typed turn; accuracy is the shared
  // reviewMetrics mean over settled qualities.
  const rootFen = nodes[0]?.fen.split(' ') ?? [];
  const rootMove = Number(rootFen[5]) || 1;
  const rootOffset = rootFen[1] === 'b' ? 1 : 0;
  for (let index = 0; index < nodes.length - 1; index++) {
    const row = nodes[index];
    const color = row.turn;
    if (onlySide && color !== onlySide) continue;
    const side = sides[color === 'white' ? 0 : 1];
    side.total++;
    const quality = qualities[index];
    if (!quality || quality.accuracy === null || quality.label === 'Unreviewed') continue;
    side.reviewed++;
    scores[side.color] += quality.accuracy;
    const countLabel = countLabels.find(label => label === quality.label);
    if (countLabel) side.counts[countLabel]++;
    const label = issueLabels.find(label => label === quality.label);
    if (label) {
      side.issues[label]++;
      const moveNumber = rootMove + Math.floor((rootOffset + row.ply) / 2);
      issues.push({ beforePly: row.ply, color: side.color, moveNumber,
        san: nodes[index + 1].san ?? nodes[index + 1].uci ?? '', label, accuracy: quality.accuracy });
    }
  }
  for (const side of sides) side.accuracy = side.reviewed ? scores[side.color] / side.reviewed : null;
  const visible = onlySide ? sides.filter(side => side.color === onlySide) : sides;
  return { sides: visible, issues, total: visible.reduce((total, side) => total + side.total, 0), reviewed: visible.reduce((total, side) => total + side.reviewed, 0) };
}
