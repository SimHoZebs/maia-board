import { useSyncExternalStore } from 'react';
import { loadLine } from '../shared/domain';
import { isRecord } from '../shared/guards';
import { KEYS, readPreference, writeStorage } from './storage';
import { normalizeUserElo, saveUserEloAnchor } from './userElo';
import type { ImportPayload } from './account';

// Lichess rating sync: profile rating becomes the user-Elo anchor, and game
// history imports top it up. One cache entry covers both so Elo and games
// refresh together: first load when missing, hourly when stale, or on demand
// from the Settings sync button. The time-control basis defaults to the
// most-played pool but is manually configurable (auto/bullet/blitz/rapid/
// classical/correspondence); the cache records the basis it was fetched with
// so a basis change re-syncs.
export const LICHESS_SYNC_TTL_MS = 60 * 60 * 1000;
export const LICHESS_SYNC_KEY = KEYS.lichessSync;
export const LICHESS_BASIS_KEY = KEYS.lichessEloBasis;

// Standard rated pools considered for the baseline, in tie-break order.
// Puzzle/storm/streak and variant pools never win the baseline.
export const LICHESS_CANDIDATE_PERFS = [
  'blitz',
  'rapid',
  'classical',
  'bullet',
  'correspondence',
] as const;

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class LichessSyncError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'LichessSyncError';
    this.code = code;
    this.status = status;
  }
}

export type LichessEloCache = {
  username: string;
  rating: number;
  perf: string;
  games: number;
  basis: LichessEloBasis;
  fetchedAt: number;
};

export type PickedPerf = { key: string; rating: number; games: number };

// Manual time-control basis. 'auto' keeps the most-played heuristic below;
// any other value pins the baseline to that pool (falling back to auto when
// the pool is unrated on the profile).
export type LichessEloBasis =
  | 'auto'
  | 'bullet'
  | 'blitz'
  | 'rapid'
  | 'classical'
  | 'correspondence';
export const LICHESS_BASIS_OPTIONS: LichessEloBasis[] = [
  'auto',
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'correspondence',
];

export function normalizeLichessEloBasis(value: unknown): LichessEloBasis {
  return LICHESS_BASIS_OPTIONS.includes(value as LichessEloBasis)
    ? (value as LichessEloBasis)
    : 'auto';
}

export function loadLichessEloBasis(): LichessEloBasis {
  return normalizeLichessEloBasis(readPreference(LICHESS_BASIS_KEY));
}

export function saveLichessEloBasis(basis: LichessEloBasis): void {
  writeStorage(LICHESS_BASIS_KEY, basis);
  notifyLichessBasisChanged();
}

const lichessBasisListeners = new Set<() => void>();
export function subscribeLichessBasis(listener: () => void): () => void {
  lichessBasisListeners.add(listener);
  return () => {
    lichessBasisListeners.delete(listener);
  };
}
export function notifyLichessBasisChanged(): void {
  // Snapshot iteration: listeners unsubscribe during dispatch.
  // oxlint-disable-next-line no-useless-spread
  for (const listener of [...lichessBasisListeners]) {
    try {
      listener();
    } catch {
      /* subscriber-owned; never break sync */
    }
  }
}
export function useLichessEloBasis(): LichessEloBasis {
  useSyncExternalStore(subscribeLichessBasis, loadLichessEloBasis, loadLichessEloBasis);
  return loadLichessEloBasis();
}

export function normalizeLichessUsername(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function perfGames(value: unknown): number {
  if (!isRecord(value)) return 0;
  const games = (value as Record<string, unknown>).games;
  return typeof games === 'number' && Number.isFinite(games) && games > 0 ? Math.floor(games) : 0;
}

function perfRating(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const rating = (value as Record<string, unknown>).rating;
  return typeof rating === 'number' && Number.isFinite(rating) ? Math.round(rating) : undefined;
}

// Most-played standard pool wins; ties break toward longer controls
// (candidate order). Falls back to any rated pool when none of the standard
// ones has games, and to undefined when nothing is rated.
export function pickMostPlayedPerf(perfs: unknown): PickedPerf | undefined {
  if (!isRecord(perfs)) return undefined;
  let best: PickedPerf | undefined;
  for (const key of LICHESS_CANDIDATE_PERFS) {
    const rating = perfRating(perfs[key]);
    if (rating === undefined) continue;
    const games = perfGames(perfs[key]);
    if (games <= 0) continue;
    if (!best || games > best.games) best = { key, rating, games };
  }
  if (best) return best;
  for (const [key, value] of Object.entries(perfs)) {
    const rating = perfRating(value);
    if (rating === undefined) continue;
    const games = perfGames(value);
    if (games <= 0) continue;
    if (!best || games > best.games) best = { key, rating, games };
  }
  return best;
}

export type ResolvedEloBasis = PickedPerf & { fellBack: boolean };

// Resolve the configured basis against a profile's perfs. A pinned pool with
// games wins outright; a pinned but unrated pool falls back to most-played
// (fellBack) so an explicit pick never hard-fails a sync. 'auto' is pure
// most-played and never falls back.
export function resolveEloBasis(
  perfs: unknown,
  basis: LichessEloBasis,
): ResolvedEloBasis | undefined {
  if (basis !== 'auto' && isRecord(perfs)) {
    const rating = perfRating(perfs[basis]);
    if (rating !== undefined && perfGames(perfs[basis]) > 0) {
      return { key: basis, rating, games: perfGames(perfs[basis]), fellBack: false };
    }
    const auto = pickMostPlayedPerf(perfs);
    if (auto) return { ...auto, fellBack: true };
    return undefined;
  }
  const auto = pickMostPlayedPerf(perfs);
  if (!auto) return undefined;
  return { ...auto, fellBack: false };
}

function isCacheRecord(value: unknown): value is LichessEloCache {
  if (!isRecord(value)) return false;
  return (
    typeof value.username === 'string' &&
    typeof value.rating === 'number' &&
    typeof value.perf === 'string' &&
    typeof value.games === 'number' &&
    typeof value.fetchedAt === 'number' &&
    (value.basis === undefined || typeof value.basis === 'string')
  );
}

export function loadLichessEloCache(): LichessEloCache | null {
  const raw = readPreference(LICHESS_SYNC_KEY);
  if (!isCacheRecord(raw)) return null;
  const username = normalizeLichessUsername(raw.username);
  if (!username) return null;
  if (!Number.isFinite(raw.fetchedAt) || raw.fetchedAt <= 0) return null;
  const rating = normalizeUserElo(raw.rating, NaN);
  if (!Number.isFinite(rating)) return null;
  const games = Number.isFinite(raw.games) && raw.games >= 0 ? Math.floor(raw.games) : 0;
  if (!raw.perf) return null;
  // Pre-basis caches predate the selector; they read as most-played.
  return {
    username,
    rating,
    perf: raw.perf,
    games,
    basis: normalizeLichessEloBasis(raw.basis),
    fetchedAt: raw.fetchedAt,
  };
}

export function saveLichessEloCache(cache: LichessEloCache): void {
  writeStorage(LICHESS_SYNC_KEY, cache);
  notifyLichessEloChanged();
}

// Stale when missing, for another user, fetched with another basis, or older
// than the hourly TTL. A slightly future fetchedAt (clock skew) counts fresh.
export function isLichessCacheStale(
  cache: LichessEloCache | null,
  username: string,
  now = Date.now(),
  basis: LichessEloBasis = 'auto',
): boolean {
  const wanted = normalizeLichessUsername(username).toLowerCase();
  if (!wanted) return true;
  if (!cache || cache.username.toLowerCase() !== wanted) return true;
  if (normalizeLichessEloBasis(cache.basis) !== normalizeLichessEloBasis(basis)) return true;
  if (!Number.isFinite(cache.fetchedAt)) return true;
  return now - cache.fetchedAt >= LICHESS_SYNC_TTL_MS;
}

export function lichessProfileUrl(username: string): string {
  return `https://lichess.org/api/user/${encodeURIComponent(username.trim())}`;
}

export async function fetchLichessProfile(
  username: string,
  fetchImpl: FetchLike = fetch,
  basis: LichessEloBasis = 'auto',
): Promise<ResolvedEloBasis> {
  const trimmed = normalizeLichessUsername(username);
  if (!trimmed) throw new LichessSyncError('invalid_request', 'Enter a Lichess username first.');
  let response: Response;
  try {
    response = await fetchImpl(lichessProfileUrl(trimmed), {
      headers: { Accept: 'application/json' },
    });
  } catch {
    throw new LichessSyncError('server_unreachable', 'Lichess could not be reached.');
  }
  if (response.status === 404)
    throw new LichessSyncError('not_found', `Lichess has no user "${trimmed}".`, 404);
  if (!response.ok)
    throw new LichessSyncError('unknown', `Lichess answered ${response.status}.`, response.status);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LichessSyncError('unknown', 'Lichess returned unreadable data.', response.status);
  }
  const picked = isRecord(body)
    ? resolveEloBasis(body.perfs, normalizeLichessEloBasis(basis))
    : undefined;
  if (!picked)
    throw new LichessSyncError(
      'no_rated_games',
      `@${trimmed} has no rated games yet.`,
      response.status,
    );
  return picked;
}

// Fetch + anchor + cache in one step. The profile rating becomes the Elo
// anchor stamped now, so local bot games after this point adjust from the
// Lichess baseline with the standard K=32 replay.
export async function syncLichessElo(
  username: string,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
  basis?: LichessEloBasis,
): Promise<LichessEloCache> {
  const trimmed = normalizeLichessUsername(username);
  const effective = basis ?? loadLichessEloBasis();
  const picked = await fetchLichessProfile(trimmed, fetchImpl, effective);
  const rating = normalizeUserElo(picked.rating);
  const cache: LichessEloCache = {
    username: trimmed,
    rating,
    perf: picked.key,
    games: picked.games,
    basis: effective,
    fetchedAt: now,
  };
  saveUserEloAnchor({ value: rating, updatedAt: new Date(now).toISOString() });
  saveLichessEloCache(cache);
  return cache;
}

// Reactive cache reads: components subscribe so a background sync re-renders
// PlayControls/Settings without threading the value through the reducer.
let lichessEloRevision = 0;
const lichessEloListeners = new Set<() => void>();
export function subscribeLichessElo(listener: () => void): () => void {
  lichessEloListeners.add(listener);
  return () => {
    lichessEloListeners.delete(listener);
  };
}
export function notifyLichessEloChanged(): void {
  lichessEloRevision++;
  // Snapshot iteration: listeners unsubscribe during dispatch.
  // oxlint-disable-next-line no-useless-spread
  for (const listener of [...lichessEloListeners]) {
    try {
      listener();
    } catch {
      /* subscriber-owned; never break sync */
    }
  }
}
function lichessEloRevisionSnapshot(): number {
  return lichessEloRevision;
}
export function useLichessEloCache(): LichessEloCache | null {
  // Revision-based snapshot: loadLichessEloCache() parses a fresh object on
  // every call, which must never serve as the store snapshot (a new identity
  // per read looks like perpetual change and loops rendering). The revision
  // only moves on notify, so subscribers re-render exactly on syncs and read
  // the fresh cache after.
  useSyncExternalStore(subscribeLichessElo, lichessEloRevisionSnapshot, lichessEloRevisionSnapshot);
  return loadLichessEloCache();
}
export function lichessEloRevisionForTests(): number {
  return lichessEloRevision;
}

// Cache entry applies only to the linked identity that fetched it.
export function matchingLichessCache(
  cache: LichessEloCache | null,
  username: string | undefined | null,
): LichessEloCache | null {
  if (!cache || !username) return null;
  return cache.username.toLowerCase() === username.trim().toLowerCase() ? cache : null;
}

export function formatSyncAge(fetchedAt: number, now = Date.now()): string {
  const age = now - fetchedAt;
  if (!Number.isFinite(age) || age < 0) return 'just now';
  const minutes = Math.floor(age / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(fetchedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export type LichessGame = {
  id?: string;
  pgn?: string;
  createdAt?: number;
  winner?: string;
  status?: string;
  speed?: string;
  perf?: string | { key?: string; name?: string };
  clock?: { initial?: number; increment?: number };
  // Per-ply remaining time in centiseconds for the side that just moved
  // (Lichess `clocks` field, requested with clocks=true). Absent for
  // correspondence/untimed games and older exports.
  clocks?: unknown;
  daysPerTurn?: number;
  timeControl?: string;
  players?: {
    white?: { rating?: number; ratingDiff?: number; user?: { id?: string } };
    black?: { rating?: number; ratingDiff?: number; user?: { id?: string } };
  };
};

// Canonical clock from a Lichess game row. Prefers the structured clock
// (`clock.initial`/`clock.increment` seconds), falls back to the PGN
// TimeControl header, then to correspondence days. Returns undefined for
// untimed rows (local display reads that as unlimited).
function clockOf(game: LichessGame): string | undefined {
  const initial = game.clock?.initial;
  const increment = game.clock?.increment;
  if (
    typeof initial === 'number' &&
    Number.isInteger(initial) &&
    initial >= 0 &&
    initial <= 1209600 &&
    typeof increment === 'number' &&
    Number.isInteger(increment) &&
    increment >= 0 &&
    increment <= 3600
  ) {
    return `${initial}+${increment}`;
  }
  const header = game.pgn?.match(/\[TimeControl\s+"([^"]+)"\]/i)?.[1]?.trim();
  if (header && header !== '?' && header !== '-') {
    if (/^\d+\+\d+$/.test(header)) return header;
    // Correspondence PGNs encode days-per-move as moves/seconds variants
    // (e.g. `1/86400`); the day count below covers the common shape.
    const daysMatch = header.match(/^1\/(\d+)$/);
    if (daysMatch) {
      const days = Math.round(Number(daysMatch[1]) / 86400);
      if (days >= 1 && days <= 14) return `${days}d`;
    }
    return undefined;
  }
  if (header === '-') return '-';
  if (
    typeof game.daysPerTurn === 'number' &&
    Number.isInteger(game.daysPerTurn) &&
    game.daysPerTurn >= 1 &&
    game.daysPerTurn <= 14
  ) {
    return `${game.daysPerTurn}d`;
  }
  return undefined;
}

// Per-ply remaining centiseconds, one entry per move for the side that
// just moved. Prefers the structured `clocks` array, falls back to PGN
// [%clk h:mm:ss] comments. Returns undefined unless the readings line up
// exactly with the move list (a partial array is worse than none: the
// review strips index by ply).
function clocksOf(game: LichessGame, moveCount: number): number[] | undefined {
  if (moveCount <= 0) return undefined;
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 14 * 86400 * 100;
  if (Array.isArray(game.clocks)) {
    if (game.clocks.length === moveCount && game.clocks.every(valid)) {
      return [...game.clocks];
    }
  }
  const matches = [...(game.pgn ?? '').matchAll(/\{\s*\[%clk\s+([0-9:.]+)\s*\]\s*\}/g)];
  if (matches.length !== moveCount) return undefined;
  const parsed: number[] = [];
  for (const match of matches) {
    const parts = match[1].split(':').map(Number);
    if (parts.some(part => !Number.isFinite(part) || part < 0)) return undefined;
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + part;
    const centiseconds = Math.round(seconds * 100);
    if (!valid(centiseconds)) return undefined;
    parsed.push(centiseconds);
  }
  return parsed;
}

function speedOf(game: LichessGame): string | undefined {
  const candidates = [
    game.speed,
    typeof game.perf === 'string' ? game.perf : (game.perf?.key ?? game.perf?.name),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    const lowered = candidate.trim().toLowerCase();
    if (
      lowered === 'ultrabullet' ||
      lowered === 'bullet' ||
      lowered === 'blitz' ||
      lowered === 'rapid' ||
      lowered === 'classical' ||
      lowered === 'correspondence'
    ) {
      return lowered;
    }
  }
  return undefined;
}

export function toImportPayload(game: LichessGame, username: string): ImportPayload | undefined {
  if (!game.pgn) return undefined;
  let moves: string[];
  try {
    moves = loadLine('', game.pgn).moves;
  } catch {
    return undefined;
  }
  if (!moves.length) return undefined;
  const lowered = username.trim().toLowerCase();
  const whiteId = game.players?.white?.user?.id?.toLowerCase();
  const blackId = game.players?.black?.user?.id?.toLowerCase();
  const userColor = whiteId === lowered ? 'white' : blackId === lowered ? 'black' : undefined;
  if (!userColor) return undefined;
  const ownRating =
    userColor === 'white' ? game.players?.white?.rating : game.players?.black?.rating;
  const foeRating =
    userColor === 'white' ? game.players?.black?.rating : game.players?.white?.rating;
  const ownDiff =
    userColor === 'white' ? game.players?.white?.ratingDiff : game.players?.black?.ratingDiff;
  const clamp = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5000
      ? value
      : fallback;
  const clampDiff = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= -1000 && value <= 1000
      ? value
      : undefined;
  const winner = game.winner === 'white' ? 'white' : game.winner === 'black' ? 'black' : undefined;
  const resigned = winner !== undefined && winner !== userColor && game.status === 'resign';
  // Opponent identity comes from the game itself (PGN headers carry display
  // case, ids are the fallback) — never the platform name.
  const headerName = (tag: 'White' | 'Black'): string | undefined => {
    const name = game.pgn?.match(new RegExp(`\\[${tag}\\s+"([^"]+)"\\]`))?.[1]?.trim();
    return name ? name.slice(0, 64) : undefined;
  };
  const foeName =
    userColor === 'white'
      ? (headerName('Black') ?? game.players?.black?.user?.id)
      : (headerName('White') ?? game.players?.white?.user?.id);
  // Strict imports: source and opponent are always stamped. A Lichess row
  // without an id or a foe name is skipped (counted, never sent as '') so
  // the server's required-field rejection never fires on our own payloads.
  const gameId =
    typeof game.id === 'string' && /^[A-Za-z0-9]{4,16}$/.test(game.id)
      ? `lichess:${game.id}`
      : undefined;
  if (!gameId || !foeName) return undefined;
  const diff = clampDiff(ownDiff);
  const clock = clockOf(game);
  const pool = speedOf(game);
  const readings = clocksOf(game, moves.length);
  return {
    user_color: userColor,
    elo_maia: clamp(foeRating, 1500),
    elo_user: clamp(ownRating, 1300),
    model: '79m',
    moves,
    ...(typeof game.createdAt === 'number'
      ? { created_at: new Date(game.createdAt).toISOString() }
      : {}),
    ...(resigned ? { result: 'resigned' } : {}),
    source: gameId,
    opponent: foeName,
    ...(diff !== undefined ? { rating_diff: diff } : {}),
    ...(clock !== undefined ? { time_control: clock } : {}),
    ...(pool !== undefined ? { speed: pool } : {}),
    ...(readings !== undefined ? { clocks: readings } : {}),
  };
}

export function lichessGamesUrl(username: string, since?: string): string {
  const params = new URLSearchParams({ max: '1000', pgnInJson: 'true', clocks: 'true' });
  const sinceMs = since ? Date.parse(since) : NaN;
  if (Number.isFinite(sinceMs)) params.set('since', String(sinceMs));
  return `https://lichess.org/api/games/user/${encodeURIComponent(username.trim())}?${params}`;
}

// Download + parse only (no server writes): callers bulkImport the payloads
// so Elo sync can proceed even when the games download fails.
export async function downloadLichessGames(
  username: string,
  since: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<{ payloads: ImportPayload[]; skipped: number }> {
  const trimmed = normalizeLichessUsername(username);
  if (!trimmed) throw new LichessSyncError('invalid_request', 'Enter a Lichess username first.');
  let response: Response;
  try {
    response = await fetchImpl(lichessGamesUrl(trimmed, since), {
      headers: { Accept: 'application/x-ndjson' },
    });
  } catch {
    throw new LichessSyncError('server_unreachable', 'Lichess could not be reached.');
  }
  if (response.status === 404)
    throw new LichessSyncError('not_found', `Lichess has no user "${trimmed}".`, 404);
  if (!response.ok || !response.body)
    throw new LichessSyncError('unknown', `Lichess answered ${response.status}.`, response.status);
  const text = await response.text();
  const payloads: ImportPayload[] = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    const row = line.trim();
    if (!row) continue;
    try {
      const parsed = toImportPayload(JSON.parse(row) as LichessGame, trimmed);
      if (parsed) payloads.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { payloads, skipped };
}
