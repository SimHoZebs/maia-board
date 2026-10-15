import { useEffect, useState } from 'react';
import { Button } from '../components';
import { adoptLegacyGames, bulkImport, importStatus, startLichessLogin, unownedGamesCount, type ImportPayload, type ImportStatus } from '../history/account';
import { useSessionSnapshot, useSessionStore } from '../history/session';
import { loadLine } from '../shared/domain';

type LichessGame = {
  id?: string; pgn?: string; createdAt?: number; winner?: string; status?: string;
  players?: { white?: { rating?: number; user?: { id?: string } }; black?: { rating?: number; user?: { id?: string } } };
};

function toImportPayload(game: LichessGame, username: string): ImportPayload | undefined {
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
  const ownRating = userColor === 'white' ? game.players?.white?.rating : game.players?.black?.rating;
  const foeRating = userColor === 'white' ? game.players?.black?.rating : game.players?.white?.rating;
  const clamp = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5000 ? value : fallback;
  const winner = game.winner === 'white' ? 'white' : game.winner === 'black' ? 'black' : undefined;
  const resigned = winner !== undefined && winner !== userColor && game.status === 'resign';
  return {
    user_color: userColor,
    elo_maia: clamp(foeRating, 1500),
    elo_user: clamp(ownRating, 1300),
    model: '79m',
    moves,
    ...(typeof game.createdAt === 'number' ? { created_at: new Date(game.createdAt).toISOString() } : {}),
    ...(resigned ? { result: 'resigned' } : {}),
    ...(typeof game.id === 'string' && /^[A-Za-z0-9]{4,16}$/.test(game.id) ? { source: `lichess:${game.id}` } : {}),
  };
}

function formatRunDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function AccountPanel() {
  const sessionStore = useSessionStore();
  const session = useSessionSnapshot(sessionStore);
  const account = session.account;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importState, setImportState] = useState<string | null>(null);
  const [adoptState, setAdoptState] = useState<string | null>(null);
  const [unowned, setUnowned] = useState<number | null>(null);
  const [status, setStatus] = useState<ImportStatus | null>(null);

  const refreshStatus = async () => {
    try {
      setStatus(await importStatus());
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === 'ok') {
      window.history.replaceState(null, '', window.location.pathname);
      void sessionStore.refresh();
    }
  }, [sessionStore]);

  useEffect(() => {
    if (!account) return;
    let live = true;
    unownedGamesCount()
      .then(count => { if (live) setUnowned(count); })
      .catch(() => { if (live) setUnowned(null); });
    void refreshStatus();
    return () => { live = false; };
  }, [account]);

  const doLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      await sessionStore.login(name.trim() || 'Player');
      setName('');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  };

  const doLogout = async () => {
    setBusy(true);
    try {
      await sessionStore.logout();
      setImportState(null);
      setAdoptState(null);
      setUnowned(null);
      setStatus(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Logout failed.');
    } finally {
      setBusy(false);
    }
  };

  const doConnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await startLichessLogin();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Lichess login failed to start.');
      setBusy(false);
    }
  };

  const doAdopt = async () => {
    setBusy(true);
    setError(null);
    try {
      const adopted = await adoptLegacyGames();
      setUnowned(0);
      setAdoptState(adopted === 0 ? 'Nothing to claim: every saved game already belongs to an account.' : `Claimed ${adopted} existing game${adopted === 1 ? '' : 's'} into your account. See History.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Adoption failed.');
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (username: string, since?: string) => {
    const trimmed = username.trim();
    if (!trimmed) {
      setError('Enter a Lichess username first.');
      return;
    }
    setBusy(true);
    setError(null);
    setImportState('Downloading games from Lichess…');
    try {
      const params = new URLSearchParams({ max: '1000', pgnInJson: 'true' });
      const sinceMs = since ? Date.parse(since) : NaN;
      if (Number.isFinite(sinceMs)) params.set('since', String(sinceMs));
      const url = `https://lichess.org/api/games/user/${encodeURIComponent(trimmed)}?${params}`;
      const response = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });
      if (!response.ok || !response.body) throw new Error(`Lichess answered ${response.status}.`);
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
      if (!payloads.length) {
        setImportState(`No importable games found (${skipped} skipped).`);
        return;
      }
      setImportState(`Saving ${payloads.length} games…`);
      const result = await bulkImport(payloads, { provider: 'lichess', username: trimmed });
      const failed = Object.keys(result.errors).length;
      if (result.saved.length === 0 && failed === 0) {
        setImportState(`Already up to date: ${result.skipped} known, ${skipped} skipped.`);
      } else {
        setImportState(`Imported ${result.saved.length} new${failed ? `, ${failed} failed` : ''}${result.skipped ? `, ${result.skipped} already here` : ''}${skipped ? `, ${skipped} skipped` : ''}. See History.`);
      }
      await refreshStatus();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Import failed.');
      setImportState(null);
    } finally {
      setBusy(false);
    }
  };

  if (session.status === 'checking') return <section aria-label="Account"><h2>Account</h2><p>Checking login…</p></section>;

  if (account === null) return <section aria-label="Account" className="settings-control">
    <h2>Account</h2>
    {error && <p role="alert">{error}</p>}
    {session.error && <p role="alert">{session.error}</p>}
    <p>Log in to own your games. History, reviews, and engine calls scope to your account.</p>
    <div className="account-actions">
      <Button variant="primary" onClick={doConnect} disabled={busy}>Log in with Lichess</Button>
      <Button onClick={doLogin} disabled={busy}>{busy ? 'Logging in…' : 'Continue with a local name'}</Button>
    </div>
    <label className="field">Display name<input value={name} maxLength={40} onChange={event => setName(event.target.value)} placeholder="Player" /></label>
  </section>;

  const initial = (account.display_name.trim()[0] ?? '?').toUpperCase();
  const last = status?.last ?? null;
  return <section aria-label="Account" className="settings-control">
    <div className="account-identity">
      <span className="account-avatar" aria-hidden="true">{initial}</span>
      <div>
        <p className="account-name">{account.display_name}</p>
        <p className="account-sub">{account.lichess_username ? `Lichess @${account.lichess_username}` : 'Local account'}</p>
      </div>
    </div>
    {error && <p role="alert">{error}</p>}
    {session.error && <p role="alert">{session.error}</p>}
    {!account.lichess_username && <div className="account-actions">
      <Button variant="primary" onClick={doConnect} disabled={busy}>Connect Lichess</Button>
    </div>}
    {account.lichess_username && (last
      ? <>
        <p className="account-note">
          {last.saved > 0 ? `+${last.saved} new from @${last.username}` : `Up to date with @${last.username}`} · {formatRunDate(last.created_at)} · {status?.total ?? 0} games in your history.
        </p>
        <div className="account-actions">
          <Button onClick={() => runImport(account.lichess_username as string, last.created_at)} disabled={busy}>{busy ? 'Checking…' : 'Check for new games'}</Button>
        </div>
      </>
      : <div className="account-actions">
        <Button variant="primary" onClick={() => runImport(account.lichess_username as string)} disabled={busy}>{busy ? 'Importing…' : `Import @${account.lichess_username}'s games`}</Button>
      </div>)}
    {importState && <p className="account-note">{importState}</p>}
    {(unowned !== 0 || adoptState) && <>
      <h3 className="settings-subhead">Existing games</h3>
      <p className="account-note">Games saved before accounts existed belong to nobody. Claim them into your account.</p>
      {unowned !== 0 && <div className="account-actions">
        <Button onClick={doAdopt} disabled={busy}>Claim existing games</Button>
      </div>}
      {adoptState && <p className="account-note">{adoptState}</p>}
    </>}
    <div className="account-actions">
      <Button variant="quiet" onClick={doLogout} disabled={busy}>Log out</Button>
    </div>
  </section>;
}
