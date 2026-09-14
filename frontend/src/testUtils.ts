import { Chess } from 'chess.js';
import { applyUci } from './domain';

// Test-only timeline helper. Lives here (not in domain.ts) so production
// bundles never ship fixture builders.
export function testNodes(initialFen: string, moves: string[]): { initialFen: string; moves: string[]; fen: string }[] {
  const game = new Chess(initialFen);
  const nodes = [{ initialFen, moves: [] as string[], fen: game.fen() }];
  moves.forEach((move, index) => {
    applyUci(game, move);
    nodes.push({ initialFen, moves: moves.slice(0, index + 1), fen: game.fen() });
  });
  return nodes;
}
