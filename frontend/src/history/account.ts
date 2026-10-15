import type { StoredGame } from '../shared/domain';

// Account client: session shapes (Chi JSON, not Orval) plus the bulk-import
// path that appends external history into the caller's owned store.
export type Account = {
  id: string; created_at: string; display_name: string;
  lichess_username?: string; lichess_id?: string;
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
  try { return await response.json(); }
  catch { throw new AccountError('unknown', 'The account server returned unreadable data.', response.status); }
}

function isAccount(value: unknown): value is Account {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.created_at === 'string' && typeof record.display_name === 'string';
}

export async function fetchMe(fetchImpl: FetchLike = fetch): Promise<Account | null> {
  let response: Response;
  try {
    response = await fetchImpl('/me', { headers: { 'Accept': 'application/json' }, credentials: 'include', cache: 'no-store' });
  } catch {
    throw new AccountError('server_unreachable', 'The game server could not be reached.');
  }
  if (response.status === 401 || response.status === 503) return null;
  if (!response.ok) throw new AccountError('unknown', 'Account lookup failed.', response.status);
  const body = await readJson(response);
  if (!isAccount(body)) throw new AccountError('unknown', 'The account server returned an incomplete account.', response.status);
  return body;
}

export async function loginLocal(displayName: string, fetchImpl: FetchLike = fetch): Promise<Account> {
  let response: Response;
  try {
    response = await fetchImpl('/auth/local', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ display_name: displayName }),
    });
  } catch {
    throw new AccountError('server_unreachable', 'The game server could not be reached.');
  }
  const body = await readJson(response);
  if (!response.ok) throw new AccountError('unknown', 'Login failed.', response.status);
  if (!isAccount(body)) throw new AccountError('unknown', 'The account server returned an incomplete account.', response.status);
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

export type ImportPayload = {
  user_color: string; elo_maia: number; elo_user: number; model: string;
  moves: string[]; created_at?: string; result?: string;
};

export async function bulkImport(games: ImportPayload[], fetchImpl: FetchLike = fetch): Promise<{ saved: StoredGame[]; errors: Record<string, string> }> {
  const saved: StoredGame[] = [];
  const errors: Record<string, string> = {};
  for (let at = 0; at < games.length; at += 50) {
    const chunk = games.slice(at, at + 50);
    let response: Response;
    try {
      response = await fetchImpl('/imports/games', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ games: chunk }),
      });
    } catch {
      throw new AccountError('server_unreachable', 'The game server could not be reached.');
    }
    const body = await readJson(response) as { saved?: unknown; errors?: unknown };
    if (!response.ok && response.status !== 400) throw new AccountError('unknown', 'Import failed.', response.status);
    const rows = Array.isArray(body.saved) ? body.saved as StoredGame[] : [];
    for (const row of rows) saved.push(row);
    const errs = (body.errors ?? {}) as Record<string, string>;
    for (const [key, code] of Object.entries(errs)) errors[String(Number(key) + at)] = code;
    if (!response.ok && saved.length === 0) throw new AccountError('unknown', 'Import failed.', response.status);
  }
  return { saved, errors };
}

export async function adoptLegacyGames(fetchImpl: FetchLike = fetch): Promise<number> {
  let response: Response;
  try {
    response = await fetchImpl('/imports/adopt', { method: 'POST', credentials: 'include' });
  } catch {
    throw new AccountError('server_unreachable', 'The game server could not be reached.');
  }
  const body = await readJson(response) as { adopted?: unknown };
  if (!response.ok) throw new AccountError('unknown', 'Adoption failed.', response.status);
  return typeof body.adopted === 'number' ? body.adopted : 0;
}
