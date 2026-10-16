import { useEffect, useState } from 'react';
import { Button } from '../components';
import { adoptLegacyGames, startLichessLogin, unownedGamesCount } from '../history/account';
import { useSessionSnapshot, useSessionStore } from '../history/session';

export function AccountPanel() {
  const sessionStore = useSessionStore();
  const session = useSessionSnapshot(sessionStore);
  const account = session.account;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adoptState, setAdoptState] = useState<string | null>(null);
  const [unowned, setUnowned] = useState<number | null>(null);

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
      .then(count => {
        if (live) setUnowned(count);
      })
      .catch(() => {
        if (live) setUnowned(null);
      });
    return () => {
      live = false;
    };
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
      setAdoptState(null);
      setUnowned(null);
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
      setAdoptState(
        adopted === 0
          ? 'Nothing to claim: every saved game already belongs to an account.'
          : `Claimed ${adopted} existing game${adopted === 1 ? '' : 's'} into your account. See History.`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Adoption failed.');
    } finally {
      setBusy(false);
    }
  };

  if (session.status === 'checking')
    return (
      <section aria-label="Account">
        <h2>Account</h2>
        <p>Checking login…</p>
      </section>
    );

  if (account === null)
    return (
      <section aria-label="Account" className="settings-control">
        <h2>Account</h2>
        {error && <p role="alert">{error}</p>}
        {session.error && <p role="alert">{session.error}</p>}
        <p>Log in to own your games. History, reviews, and engine calls scope to your account.</p>
        <div className="account-actions">
          <Button variant="primary" onClick={doConnect} disabled={busy}>
            Log in with Lichess
          </Button>
          <Button onClick={doLogin} disabled={busy}>
            {busy ? 'Logging in…' : 'Continue with a local name'}
          </Button>
        </div>
        <label className="field">
          Display name
          <input
            value={name}
            maxLength={40}
            onChange={event => setName(event.target.value)}
            placeholder="Player"
          />
        </label>
      </section>
    );

  const initial = (account.display_name.trim()[0] ?? '?').toUpperCase();
  return (
    <section aria-label="Account" className="settings-control">
      <div className="account-row">
        <div className="account-identity">
          <span className="account-avatar" aria-hidden="true">
            {initial}
          </span>
          <div>
            <p className="account-name">{account.display_name}</p>
            <p className="account-sub">
              {account.lichess_username ? `Lichess @${account.lichess_username}` : 'Local account'}
            </p>
          </div>
        </div>
        <div className="account-actions">
          <Button variant="quiet" onClick={doLogout} disabled={busy}>
            Log out
          </Button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      {session.error && <p role="alert">{session.error}</p>}
      {!account.lichess_username && (
        <div className="account-actions">
          <Button variant="primary" onClick={doConnect} disabled={busy}>
            Connect Lichess
          </Button>
        </div>
      )}
      {(unowned !== 0 || adoptState) && (
        <div className="account-row">
          <p className="account-note">
            Games saved before accounts existed belong to nobody. Claim them into your account.
          </p>
          {unowned !== 0 && (
            <div className="account-actions">
              <Button onClick={doAdopt} disabled={busy}>
                Claim existing games
              </Button>
            </div>
          )}
        </div>
      )}
      {adoptState && <p className="account-note">{adoptState}</p>}
    </section>
  );
}
