import { Chess } from 'chess.js';
import { clampBotElo } from '../board/BoardTools';
import type { StoredGame } from '../shared/domain';
import { replay } from '../shared/domain';
import { isRecord } from '../shared/guards';
import { KEYS, readStorage, writeStorage } from './storage';

// Adaptive user rating: a dated anchor plus standard Elo replay.
// The user sets a baseline (default 400) in Settings; every finished game
// played since the anchor date moves the rating with K=32 against the
// effective bot strength. Maia accepts any integer 0-5000, so granular
// values like 1675 pass through untouched — only engine inference clamps
// into the trained 800-2400 band, never the stored rating.
export const DEFAULT_USER_ELO = 400;
export const USER_ELO_K = 32;
export const USER_ELO_MIN = 0;
export const USER_ELO_MAX = 5000;

export type UserEloAnchor = { value: number; updatedAt: string };
export type UserEloScore = 1 | 0.5 | 0;
export type UserEloSummary = {
  rating: number; counted: number; wins: number; draws: number; losses: number;
  anchor: UserEloAnchor;
};

export function normalizeUserElo(value: unknown, fallback = DEFAULT_USER_ELO): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(USER_ELO_MAX, Math.max(USER_ELO_MIN, Math.round(value)));
}

function normalizeAnchorDate(value: unknown): string {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  return new Date(0).toISOString();
}

export function normalizeAnchor(value: unknown): UserEloAnchor {
  if (!isRecord(value)) return { value: DEFAULT_USER_ELO, updatedAt: new Date(0).toISOString() };
  return {
    value: normalizeUserElo(value.value ?? value.elo ?? DEFAULT_USER_ELO),
    updatedAt: normalizeAnchorDate(value.updatedAt ?? value.date),
  };
}

export function loadUserEloAnchor(): UserEloAnchor {
  return normalizeAnchor(readStorage<unknown>(KEYS.userEloAnchor));
}

export function saveUserEloAnchor(anchor: UserEloAnchor): Error | undefined {
  return writeStorage(KEYS.userEloAnchor, anchor);
}

export function expectedScore(user: number, opp: number): number {
  return 1 / (1 + Math.pow(10, (opp - user) / 400));
}

export function updateUserElo(user: number, opp: number, score: UserEloScore): number {
  return normalizeUserElo(user + USER_ELO_K * (score - expectedScore(user, opp)));
}

// Finished games only: checkmate and resignation decide, any other
// game-over from the board (stalemate, repetition, 50-move, insufficient
// material) is a draw. Unfinished lines return null and never move Elo.
// Resignation always means the user resigned (the app has no bot-resign),
// so it scores 0 for the user.
export function scoreForGame(game: Pick<StoredGame, 'moves' | 'settings' | 'result'>): UserEloScore | null {
  if (game.result === 'resigned') return 0;
  let board: Chess;
  try {
    board = replay(game.moves);
  } catch {
    return null;
  }
  if (board.isCheckmate()) {
    const winner = board.turn() === 'w' ? 'black' : 'white';
    return winner === game.settings.userColor ? 1 : 0;
  }
  if (board.isGameOver()) return 0.5;
  return null;
}

export function opponentElo(game: Pick<StoredGame, 'settings'>): number {
  return clampBotElo(game.settings.botElo);
}

export function computeUserElo(anchor: UserEloAnchor, games: Pick<StoredGame, 'id' | 'createdAt' | 'moves' | 'settings' | 'result'>[]): UserEloSummary {
  const since = Date.parse(anchor.updatedAt);
  const ordered = [...games].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
  let rating = normalizeUserElo(anchor.value);
  let counted = 0;
  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (const game of ordered) {
    if (Number.isNaN(Date.parse(game.createdAt))) continue;
    if (Date.parse(game.createdAt) < since) continue;
    const score = scoreForGame(game);
    if (score === null) continue;
    rating = updateUserElo(rating, opponentElo(game), score);
    counted++;
    if (score === 1) wins++;
    else if (score === 0.5) draws++;
    else losses++;
  }
  return { rating, counted, wins, draws, losses, anchor };
}

export function currentUserElo(games: Pick<StoredGame, 'id' | 'createdAt' | 'moves' | 'settings' | 'result'>[], anchor?: UserEloAnchor): number {
  return computeUserElo(anchor ?? loadUserEloAnchor(), games).rating;
}
