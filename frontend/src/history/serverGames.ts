import type { StoredGame } from '../shared/domain';
import { normalizeClocks, normalizeSpeed, normalizeTimeControl } from '../shared/domain';
// Canonical term per spec/GLOSSARY.md: this module is the gameClient
// (durable game requests), never the engine transport (evaluationTransport).
import { isRecord } from '../shared/guards';
import { parseStoredGame } from './storage';
import {
  GamesCreateResponse as GameRowSchema,
  GamesListResponse as GamesListSchema,
} from '../api/generated/maia.zod';

export type ServerGame = {
  id: string;
  created_at: string;
  updated_at: string;
  user_color: string;
  elo_maia: number;
  elo_user: number;
  model: string;
  moves: string[];
  temperature?: number;
  result?: string;
  source?: string;
  opponent?: string;
  rating_diff?: number;
  time_control?: string;
  speed?: string;
  clocks?: number[];
};

export type GamesList = {
  games: ServerGame[];
  current_id: string | null;
  total: number;
  current_game?: ServerGame | null;
  next_offset?: number | null;
};

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
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string' &&
    typeof value.user_color === 'string' &&
    typeof value.elo_maia === 'number' &&
    typeof value.elo_user === 'number' &&
    typeof value.model === 'string' &&
    Array.isArray(value.moves) &&
    value.moves.every(move => typeof move === 'string') &&
    (value.source === undefined || typeof value.source === 'string') &&
    (value.opponent === undefined || typeof value.opponent === 'string') &&
    (value.rating_diff === undefined || typeof value.rating_diff === 'number') &&
    (value.time_control === undefined || typeof value.time_control === 'string') &&
    (value.speed === undefined || typeof value.speed === 'string') &&
    (value.clocks === undefined ||
      (Array.isArray(value.clocks) && value.clocks.every(entry => typeof entry === 'number')))
  );
}

function isServerGameArray(value: unknown): value is ServerGame[] {
  return Array.isArray(value) && value.every(isServerGame);
}

export function toStoredGame(row: ServerGame): StoredGame | undefined {
  const diff = row.rating_diff;
  const clock = normalizeTimeControl(row.time_control);
  const pool = normalizeSpeed(row.speed);
  const readings = normalizeClocks(row.clocks);
  // Strict rows always carry source/opponent; pre-strict caches may not, so
  // default to the local sentinel rather than dropping the fields.
  const source = typeof row.source === 'string' && row.source.length > 0 ? row.source : 'local';
  const opponent =
    typeof row.opponent === 'string' && row.opponent.length > 0
      ? row.opponent
      : `Maia ${row.elo_maia}`;
  const base = parseStoredGame({
    id: row.id,
    createdAt: row.created_at,
    moves: row.moves,
    settings: {
      userColor: row.user_color,
      botElo: row.elo_maia,
      userElo: row.elo_user,
      model: row.model,
      temperature: row.temperature,
    },
    ...(row.result === 'resigned' ? { result: 'resigned' } : {}),
    source,
    opponent,
    ...(typeof diff === 'number' && Number.isInteger(diff) && diff >= -1000 && diff <= 1000
      ? { ratingDiff: diff }
      : {}),
    ...(clock !== undefined ? { timeControl: clock } : {}),
    ...(pool !== undefined ? { speed: pool } : {}),
    ...(readings !== undefined ? { clocks: readings } : {}),
  });
  return base;
}

function toPayload(game: StoredGame, current: boolean) {
  return {
    id: game.id,
    created_at: game.createdAt,
    user_color: game.settings.userColor,
    elo_maia: game.settings.botElo,
    elo_user: game.settings.userElo,
    model: game.settings.model,
    moves: game.moves,
    current,
    temperature: game.settings.temperature ?? 0,
    ...(game.result === 'resigned' ? { result: 'resigned' } : {}),
  };
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ServerGamesError(
      'unknown',
      'The game server returned unreadable data.',
      response.status,
    );
  }
}

function throwServerError(body: unknown, status: number): never {
  // Huma envelope: the code rides in errors[0].message (free string here,
  // not the gated ApiErrorCode vocabulary), human text in detail.
  const errs = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
  const first = errs.find(entry => isRecord(entry) && typeof entry.message === 'string');
  const code =
    first && isRecord(first) && typeof first.message === 'string' ? first.message : 'unknown';
  const message =
    isRecord(body) && typeof body.detail === 'string'
      ? body.detail
      : 'Game history is unavailable.';
  throw new ServerGamesError(code, message, status);
}

export async function fetchGames(
  fetchImpl: FetchLike = fetch,
  offset = 0,
  signal?: AbortSignal,
): Promise<GamesList> {
  let response: Response;
  try {
    response = await fetchImpl(`/games?limit=100&offset=${offset}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
      signal,
    });
  } catch {
    throw new ServerGamesError('server_unreachable', 'The game server could not be reached.');
  }
  const body = await readBody(response);
  if (!response.ok) throwServerError(body, response.status);
  // Shape gate is spec-driven (Orval zod from Huma). Row semantics
  // (current-game identity, monotonic paging) stay below.
  if (!GamesListSchema.safeParse(body).success)
    throw new ServerGamesError(
      'unknown',
      'The game server returned an incomplete list.',
      response.status,
    );
  if (!isRecord(body))
    throw new ServerGamesError(
      'unknown',
      'The game server returned an incomplete list.',
      response.status,
    );
  const { games, current_id, total, current_game, next_offset } = body;
  if (
    !isServerGameArray(games) ||
    !(current_id === null || typeof current_id === 'string') ||
    typeof total !== 'number' ||
    !Number.isSafeInteger(total) ||
    total < 0
  ) {
    throw new ServerGamesError(
      'unknown',
      'The game server returned an incomplete list.',
      response.status,
    );
  }
  let validatedCurrentGame: ServerGame | null | undefined;
  if (current_game === undefined) validatedCurrentGame = undefined;
  else if (current_game === null) validatedCurrentGame = null;
  else {
    if (!isServerGame(current_game) || current_game.id !== current_id)
      throw new ServerGamesError('unknown', 'The current game is invalid.');
    validatedCurrentGame = current_game;
  }
  let validatedNextOffset: number | null | undefined;
  if (next_offset === undefined) validatedNextOffset = undefined;
  else if (next_offset === null) validatedNextOffset = null;
  else {
    if (typeof next_offset !== 'number' || !Number.isInteger(next_offset) || next_offset <= offset)
      throw new ServerGamesError('unknown', 'The next history page is invalid.');
    validatedNextOffset = next_offset;
  }
  return {
    games,
    current_id,
    total,
    ...(validatedCurrentGame !== undefined ? { current_game: validatedCurrentGame } : {}),
    ...(validatedNextOffset !== undefined ? { next_offset: validatedNextOffset } : {}),
  };
}

export async function saveRemote(
  game: StoredGame,
  current: boolean,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<ServerGame> {
  let response: Response;
  try {
    response = await fetchImpl('/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(toPayload(game, current)),
      signal,
    });
  } catch {
    throw new ServerGamesError('server_unreachable', 'The game server could not be reached.');
  }
  const body = await readBody(response);
  if (!response.ok) throwServerError(body, response.status);
  // Shape gate is spec-driven (Orval zod from Huma); row semantics stay below.
  if (!GameRowSchema.safeParse(body).success)
    throw new ServerGamesError(
      'unknown',
      'The game server returned an incomplete game.',
      response.status,
    );
  if (!isServerGame(body))
    throw new ServerGamesError(
      'unknown',
      'The game server returned an incomplete game.',
      response.status,
    );
  return body;
}

export async function deleteRemote(
  id: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`/games/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'include',
      signal,
    });
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

// Decodes one pending outbox op from the v2 document.
export function decodeOutboxOp(value: unknown): OutboxOp | undefined {
  if (!isRecord(value)) return;
  const op = value;
  if (op.op === 'delete' && typeof op.id === 'string') return { op: 'delete', id: op.id };
  if (op.op === 'save' && typeof op.current === 'boolean') {
    const game = parseStoredGame(op.game);
    if (game) return { op: 'save', game, current: op.current };
  }
}

// Merges server rows with pending local ops. Pending ops always win; the last
// save carrying the current marker decides the current game.
export function mergeSync(
  serverSaved: StoredGame[],
  serverCurrentId: string | null,
  pending: OutboxOp[],
): { saved: StoredGame[]; currentId: string | null } {
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
  const ordered = [
    ...new Set(touched.toReversed()),
    ...[...games.keys()].filter(id => !touched.includes(id)),
  ]
    .map(id => games.get(id)!)
    .filter(Boolean);
  if (currentId !== null && !games.has(currentId)) currentId = null;
  return { saved: ordered, currentId };
}
