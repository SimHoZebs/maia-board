import type { StoredGame } from '../shared/domain';

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

export async function fetchMe(fetchImpl: FetchLike = fetch): Promise<Account | null> {
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
  if (response.status === 401 || response.status === 503) return null;
  if (!response.ok) throw new AccountError('unknown', 'Account lookup failed.', response.status);
  const body = await readJson(response);
  if (!isAccount(body))
    throw new AccountError(
      'unknown',
      'The account server returned an incomplete account.',
      response.status,
    );
  return body;
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
  return {
    last: last && typeof last === 'object' ? (last as ImportRun) : null,
    total: typeof body.total === 'number' ? body.total : 0,
  };
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
    try {
      response = await fetchImpl('/imports/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          games: chunk,
          ...(opts?.provider ? { provider: opts.provider, username: opts?.username ?? '' } : {}),
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
    const errs = (body.errors ?? {}) as Record<string, string>;
    for (const [key, code] of Object.entries(errs)) errors[String(Number(key) + at)] = code;
    if (!response.ok && saved.length === 0)
      throw new AccountError('unknown', 'Import failed.', response.status);
  }
  return { saved, errors, skipped, refreshed };
}

export async function adoptLegacyGames(fetchImpl: FetchLike = fetch): Promise<number> {
  let response: Response;
  try {
    response = await fetchImpl('/imports/adopt', { method: 'POST', credentials: 'include' });
  } catch {
    throw new AccountError('server_unreachable', 'The game server could not be reached.');
  }
  const body = (await readJson(response)) as { adopted?: unknown };
  if (!response.ok) throw new AccountError('unknown', 'Adoption failed.', response.status);
  return typeof body.adopted === 'number' ? body.adopted : 0;
}

// How many pre-user rows await adoption. The claim section renders only
// when this is non-zero, so finished migrations disappear on their own.
export async function unownedGamesCount(fetchImpl: FetchLike = fetch): Promise<number> {
  let response: Response;
  try {
    response = await fetchImpl('/imports/adopt', { credentials: 'include' });
  } catch {
    throw new AccountError('server_unreachable', 'The game server could not be reached.');
  }
  const body = (await readJson(response)) as { unowned?: unknown };
  if (!response.ok) throw new AccountError('unknown', 'Adoption check failed.', response.status);
  return typeof body.unowned === 'number' ? body.unowned : 0;
}
