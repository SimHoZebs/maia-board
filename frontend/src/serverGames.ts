import type { StoredGame } from './domain';
import { readStorage, restoreGame } from './storage';

export type ServerGame = {
  id: string; created_at: string; updated_at: string; user_color: string;
  elo_maia: number; elo_user: number; model: string; moves: string[]; temperature?: number; result?: string;
};

export type GamesList = { games: ServerGame[]; current_id: string | null; total: number; current_game?: ServerGame | null; next_offset?: number | null };

export class ServerGamesError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ServerGamesError';
    this.code = code;
    this.status = status;
  }
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isServerGame(value: unknown): value is ServerGame {
  if (!value || typeof value !== 'object') return false;
  const game = value as Record<string, unknown>;
  return typeof game.id === 'string' && typeof game.created_at === 'string' && typeof game.updated_at === 'string'
    && typeof game.user_color === 'string' && typeof game.elo_maia === 'number' && typeof game.elo_user === 'number'
    && typeof game.model === 'string' && Array.isArray(game.moves) && game.moves.every(move => typeof move === 'string');
}

export function toStoredGame(row: ServerGame): StoredGame | undefined {
  const base = restoreGame({
    id: row.id, createdAt: row.created_at, moves: row.moves,
    settings: { userColor: row.user_color, eloMaia: row.elo_maia, eloUser: row.elo_user, model: row.model, temperature: row.temperature },
    ...(row.result === 'resigned' ? { result: 'resigned' } : {}),
  });
  return base;
}

function toPayload(game: StoredGame, current: boolean) {
  return {
    id: game.id, created_at: game.createdAt, user_color: game.settings.userColor,
    elo_maia: game.settings.eloMaia, elo_user: game.settings.eloUser,
    model: game.settings.model, moves: game.moves, current, temperature: game.settings.temperature ?? 0,
    ...(game.result === 'resigned' ? { result: 'resigned' } : {}),
  };
}

async function readBody(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new ServerGamesError('unknown', 'The game server returned unreadable data.', response.status); }
}

function throwServerError(body: unknown, status: number): never {
  const record = body as Record<string, unknown>;
  const code = typeof record?.code === 'string' ? record.code : 'unknown';
  const message = typeof record?.message === 'string' ? record.message : 'Game history is unavailable.';
  throw new ServerGamesError(code, message, status);
}

export async function fetchGames(fetchImpl: FetchLike = fetch, offset = 0, signal?: AbortSignal): Promise<GamesList> {
  let response: Response;
  try {
    response = await fetchImpl(`/games?limit=100&offset=${offset}`, { headers: { 'Accept': 'application/json' }, cache: 'no-store', signal });
  } catch {
    throw new ServerGamesError('server_unreachable', 'The game server could not be reached.');
  }
  const body = await readBody(response);
  if (!response.ok) throwServerError(body, response.status);
  const list = body as Partial<GamesList>;
  if (!Array.isArray(list.games) || !list.games.every(isServerGame)
    || !(list.current_id === null || typeof list.current_id === 'string') || typeof list.total !== 'number' || !Number.isSafeInteger(list.total) || list.total < 0) {
    throw new ServerGamesError('unknown', 'The game server returned an incomplete list.', response.status);
  }
  if (list.current_game != null && (!isServerGame(list.current_game) || list.current_game.id !== list.current_id)) throw new ServerGamesError('unknown', 'The current game is invalid.');
  if (list.next_offset != null && (!Number.isInteger(list.next_offset) || list.next_offset <= offset)) throw new ServerGamesError('unknown', 'The next history page is invalid.');
  return { games: list.games, current_id: list.current_id, total: list.total,
    ...(list.current_game !== undefined ? { current_game: list.current_game } : {}),
    ...(list.next_offset !== undefined ? { next_offset: list.next_offset } : {}) };
}

export async function saveRemote(game: StoredGame, current: boolean, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<ServerGame> {
  let response: Response;
  try {
    response = await fetchImpl('/games', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toPayload(game, current)), signal,
    });
  } catch {
    throw new ServerGamesError('server_unreachable', 'The game server could not be reached.');
  }
  const body = await readBody(response);
  if (!response.ok) throwServerError(body, response.status);
  if (!isServerGame(body)) throw new ServerGamesError('unknown', 'The game server returned an incomplete game.', response.status);
  return body;
}

export async function deleteRemote(id: string, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`/games/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
  } catch {
    throw new ServerGamesError('server_unreachable', 'The game server could not be reached.');
  }
  if (response.status === 404) return;
  if (!response.ok) throwServerError(await readBody(response), response.status);
}

// Write-ahead outbox: every mutation applies locally first, then flushes here
// in order. Entries survive reloads until the server acknowledges them.
export type OutboxOp =
  | { op: 'save'; game: StoredGame; current: boolean }
  | { op: 'delete'; id: string };

export const OUTBOX_KEY = 'maia-board.outbox.v1';
export const MIGRATED_KEY = 'maia-board.migrated-games.v1';

export function restoreOutboxOp(value: unknown): OutboxOp | undefined {
  if (!value || typeof value !== 'object') return;
  const op = value as Record<string, unknown>;
  if (op.op === 'delete' && typeof op.id === 'string') return { op: 'delete', id: op.id };
  if (op.op === 'save' && typeof op.current === 'boolean') {
    const game = restoreGame(op.game);
    if (game) return { op: 'save', game, current: op.current };
  }
}

// Merges server rows with pending local ops. Pending ops always win; the last
// save carrying the current marker decides the current game.
export function mergeSync(serverSaved: StoredGame[], serverCurrentId: string | null, pending: OutboxOp[]): { saved: StoredGame[]; currentId: string | null } {
  const games = new Map(serverSaved.map(game => [game.id, game]));
  let currentId = serverCurrentId;
  const touched: string[] = [];
  for (const op of pending) {
    if (op.op === 'delete') {
      games.delete(op.id);
      if (currentId === op.id) currentId = null;
    } else {
      games.delete(op.game.id);
      games.set(op.game.id, op.game);
      touched.push(op.game.id);
      if (op.current) currentId = op.game.id;
    }
  }
  const ordered = [...new Set(touched.reverse()), ...[...games.keys()].filter(id => !touched.includes(id))]
    .map(id => games.get(id)!).filter(Boolean);
  if (currentId !== null && !games.has(currentId)) currentId = null;
  return { saved: ordered, currentId };
}

// One-time migration of pre-database localStorage games. Oldest first so the
// server's updated_at order preserves recency; the live game goes last with
// the current marker. Idempotent by preserved ids.
export function migrationOps(saved: StoredGame[], current: StoredGame | null): OutboxOp[] {
  const seen = new Set<string>();
  const ops: OutboxOp[] = [];
  for (const game of [...saved].reverse()) {
    if (current && game.id === current.id) continue;
    if (seen.has(game.id)) continue;
    seen.add(game.id);
    ops.push({ op: 'save', game, current: false });
  }
  if (current && !seen.has(current.id)) ops.push({ op: 'save', game: current, current: true });
  return ops;
}

export function isMigrated(): boolean {
  return readStorage<unknown>(MIGRATED_KEY) === true;
}
