import { Chess } from 'chess.js';
import { START_FEN } from '../shared/domain';

// Sound identity for a committed move. Priority mirrors chess platforms:
// mate outranks everything, a drawn game ends the sound, check outranks a
// capture (Qxf7+ sounds like a check, not a capture), then captures, then
// quiet moves (castles and quiet promotions land here).
export type SoundKind = 'move' | 'capture' | 'check' | 'checkmate' | 'gameEnd';

// Classifies the tip of a displayed move prefix. Returns null for an empty
// prefix or anything unparseable so callers stay silent instead of guessing.
// Terminality replays the full line from its root, matching the history-aware
// timeline reads (FEN parses miss threefold repetition).
export function classifyTip(initialFen: string, displayedMoves: readonly string[]): SoundKind | null {
  if (!displayedMoves.length) return null;
  let game: Chess;
  try {
    game = new Chess(initialFen);
  } catch {
    return null;
  }
  let lastCaptured = false;
  try {
    for (const uci of displayedMoves) {
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
      const moved = game.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        ...(uci[4] ? { promotion: uci[4] } : {}),
      });
      lastCaptured = moved.captured !== undefined;
    }
  } catch {
    return null;
  }
  if (game.isCheckmate()) return 'checkmate';
  if (game.isDraw()) return 'gameEnd';
  if (game.inCheck()) return 'check';
  if (lastCaptured) return 'capture';
  return 'move';
}

export function classifyPlayTip(moves: readonly string[]): SoundKind | null {
  return classifyTip(START_FEN, moves);
}
