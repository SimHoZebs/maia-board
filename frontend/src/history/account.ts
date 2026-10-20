import type { StoredGame } from '../shared/domain';
import { isStringMap } from '../shared/guards';

// Account client: session shapes (Chi JSON, not Orval) plus the bulk-import
// path that appends external history into the caller's owned store.
export type Account = {
  id: string;
  created_at: string;
  display_name: string;
  lichess_username?: string;
  lichess_id?: string;
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class AccountError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    this.status = status;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AccountError(
      'unknown',
      'The account server returned unreadable data.',
      response.status,
    );
  }
}

function isAccount(value: unknown): value is Account {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.created_at === 'string' &&
    typeof record.display_name === 'string'
  );
}

export type MeResult = { kind: 'signed-in'; account: Account } | { kind: 'signed-out' };

export async function fetchMe(fetchImpl: FetchLike = fetch): Promise<MeResult> {
  let response: Response;
  try {
    response = await fetchImpl('/me', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      cache: 'no-store',
    });
  } catch {
    throw new AccountError('server_unreachable', 'The game server could not be reached.');
  }
  if (response.status === 401) return { kind: 'signed-out' };
  if (response.status === 503)
    throw new AccountError('unavailable', 'The game server is unavailable.', response.status);
  if (!response.ok) throw new AccountError('unknown', 'Account lookup failed.', response.status);
  const body = await readJson(response);
  if (!isAccount(body))
    throw new AccountError(
      'unknown',
      'The account server returned an incomplete account.',
      response.status,
    );
  return { kind: 'signed-in', account: body };
}

export async function loginLocal(
  displayName: string,
  fetchImpl: FetchLike = fetch,
): Promise<Account> {
  let response: Response;
  try {
    response = await fetchImpl('/auth/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ display_name: displayName }),
    });
  } catch {
    throw new AccountError('server_unreachable', 'The game server could not be reached.');
  }
  const body = await readJson(response);
  if (!response.ok) throw new AccountError('unknown', 'Login failed.', response.status);
  if (!isAccount(body))
    throw new AccountError(
      'unknown',
      'The account server returned an incomplete account.',
      response.status,
    );
  return body;
}

export async function logout(fetchImpl: FetchLike = fetch): Promise<void> {
  try {
    await fetchImpl('/auth/logout', { method: 'POST', credentials: 'include' });
  } catch {
    throw new AccountError('server_unreachable', 'The game server could not be reached.');
  }
}

export function lichessStartUrl(redirectUri: string): string {
  return `/auth/lichess/start?redirect_uri=${encodeURIComponent(redirectUri)}`;
}

// Full Lichess login leg: ask our server for its authorization URL, then
// leave to Lichess. Navigating to /auth/lichess/start directly only prints
// its JSON; this helper follows the URL it names.
export async function startLichessLogin(fetchImpl: FetchLike = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(lichessStartUrl(`${window.location.origin}/auth/lichess/callback`), {
      credentials: 'include',
    });
  } catch {
    throw new AccountError('server_unreachable', 'The game server could not be reached.');
  }
  const body = (await response.json().catch(() => null)) as { authorization_url?: unknown } | null;
  if (!response.ok || typeof body?.authorization_url !== 'string') {
    throw new AccountError(
      'unknown',
      response.status === 501
        ? 'Lichess login is not configured on this server.'
        : 'Lichess login failed to start.',
      response.status,
    );
  }
  let target: URL;
  try {
    target = new URL(body.authorization_url);
  } catch {
    throw new AccountError('unknown', 'Lichess login failed to start.', response.status);
  }
  if (target.origin !== 'https://lichess.org') {
    throw new AccountError('unknown', 'Lichess login failed to start.', response.status);
  }
  window.location.assign(body.authorization_url);
}

export type ImportPayload = {
  user_color: string;
  elo_maia: number;
  elo_user: number;
  model: string;
  moves: string[];
  created_at?: string;
  result?: string;
  source: string;
  opponent: string;
  rating_diff?: number;
  time_control?: string;
  speed?: string;
  clocks?: number[];
};

export type ImportRun = {
  id: string;
  user_id: string;
  provider: string;
  username: string;
  requested: number;
  saved: number;
  skipped: number;
  created_at: string;
};

export type ImportStatus = { last: ImportRun | null; total: number };

function isImportRun(value: unknown): value is ImportRun {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.user_id === 'string' &&
    typeof row.provider === 'string' &&
    typeof row.username === 'string' &&
    typeof row.requested === 'number' &&
    typeof row.saved === 'number' &&
    typeof row.skipped === 'number' &&
    typeof row.created_at === 'string'
  );
}

export async function importStatus(fetchImpl: FetchLike = fetch): Promise<ImportStatus> {
  let response: Response;
  try {
    response = await fetchImpl('/imports/status', { credentials: 'include' });
  } catch {
    throw new AccountError('server_unreachable', 'The game server could not be reached.');
  }
  const body = (await readJson(response)) as { last?: unknown; total?: unknown };
  if (!response.ok) throw new AccountError('unknown', 'Import status failed.', response.status);
  const last = body.last;
  if (last !== undefined && last !== null && !isImportRun(last))
    throw new AccountError(
      'unknown',
      'The account server returned an incomplete import status.',
      response.status,
    );
  if (typeof body.total !== 'number')
    throw new AccountError(
      'unknown',
      'The account server returned an incomplete import status.',
      response.status,
    );
  return { last: last === undefined || last === null ? null : last, total: body.total };
}

export async function bulkImport(
  games: ImportPayload[],
  opts?: { provider?: string; username?: string },
  fetchImpl: FetchLike = fetch,
): Promise<{
  saved: StoredGame[];
  errors: Record<string, string>;
  skipped: number;
  refreshed: number;
}> {
  const saved: StoredGame[] = [];
  const errors: Record<string, string> = {};
  let skipped = 0;
  let refreshed = 0;
  for (let at = 0; at < games.length; at += 100) {
    const chunk = games.slice(at, at + 100);
    let response: Response;
    // Provider imports require an explicit username — never silently default
    // a missing name to `''` and send it.
    if (opts?.provider !== undefined && (opts.username === undefined || opts.username === '')) {
      throw new AccountError('invalid_request', 'Import provider requires a username.');
    }
    try {
      response = await fetchImpl('/imports/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          games: chunk,
          ...(opts?.provider !== undefined
            ? { provider: opts.provider, username: opts.username as string }
            : {}),
        }),
      });
    } catch {
      throw new AccountError('server_unreachable', 'The game server could not be reached.');
    }
    const body = (await readJson(response)) as {
      saved?: unknown;
      errors?: unknown;
      skipped?: unknown;
      refreshed?: unknown;
    };
    if (!response.ok && response.status !== 400)
      throw new AccountError('unknown', 'Import failed.', response.status);
    const rows = Array.isArray(body.saved) ? (body.saved as StoredGame[]) : [];
    for (const row of rows) saved.push(row);
    if (typeof body.skipped === 'number') skipped += body.skipped;
    if (typeof body.refreshed === 'number') refreshed += body.refreshed;
    if (body.errors !== undefined && !isStringMap(body.errors))
      throw new AccountError('unknown', 'Import failed.', response.status);
    const errs = body.errors !== undefined ? body.errors : {};
    for (const [key, code] of Object.entries(errs)) errors[String(Number(key) + at)] = code;
    if (!response.ok && saved.length === 0)
      throw new AccountError('unknown', 'Import failed.', response.status);
  }
  return { saved, errors, skipped, refreshed };
}
