import { useState } from 'react';
import { Button } from '../components';
import { startLichessLogin } from '../history/account';
import type { SessionSnapshot } from '../history/session';

// First-run gate: the backend requires login for every interaction, so a
// logged-out visitor gets this screen instead of a board full of failing
// requests. Lichess is the verified login; a display name mints a lightweight
// local account on the same session primitive.
export function LoginGate({
  session,
  onLogin,
}: {
  session: SessionSnapshot;
  onLogin: (displayName: string) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startLichess = async () => {
    setBusy(true);
    setError(null);
    try {
      await startLichessLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lichess login failed to start.');
      setBusy(false);
    }
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onLogin(name.trim() || 'Player');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-gate" aria-label="Log in">
      <h1>maia board</h1>
      <p>
        Play, analyze, and keep your games on your own server. Log in first — your history belongs
        to your account.
      </p>
      {session.status === 'signed-out' && session.message && <p role="alert">{session.message}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="account-actions">
        <Button variant="primary" onClick={startLichess} disabled={busy}>
          {busy ? 'Contacting Lichess…' : 'Log in with Lichess'}
        </Button>
      </div>
      <div className="login-local">
        <label className="field">
          Display name
          <input
            value={name}
            maxLength={40}
            onChange={event => setName(event.target.value)}
            placeholder="Player"
          />
        </label>
        <Button onClick={submit} disabled={busy}>
          {busy ? 'Logging in…' : 'Continue with a local name'}
        </Button>
      </div>
    </main>
  );
}
