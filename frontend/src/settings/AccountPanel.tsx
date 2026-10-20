import { useEffect, useState } from 'react';
import { Button } from '../components';
import { startLichessLogin } from '../history/account';
import { useSessionSnapshot, useSessionStore } from '../history/session';

export function AccountPanel() {
  const sessionStore = useSessionStore();
  const session = useSessionSnapshot(sessionStore);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === 'ok') {
      window.history.replaceState(null, '', window.location.pathname);
      void sessionStore.refresh();
    }
  }, [sessionStore]);

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

  if (session.status === 'checking')
    return (
      <section aria-label="Account">
        <h2>Account</h2>
        <p>Checking login…</p>
      </section>
    );

  if (session.status === 'signed-out')
    return (
      <section aria-label="Account" className="settings-control">
        <h2>Account</h2>
        {error && <p role="alert">{error}</p>}
        {session.message && <p role="alert">{session.message}</p>}
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

  const account = session.account;
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
      {!account.lichess_username && (
        <div className="account-actions">
          <Button variant="primary" onClick={doConnect} disabled={busy}>
            Connect Lichess
          </Button>
        </div>
      )}
    </section>
  );
}
