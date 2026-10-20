import { useEffect, useRef, useState, useContext } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../components';
import { bulkImport, importStatus, type ImportStatus } from '../history/account';
import { SyncContext } from '../history/syncStore';
import {
  LICHESS_BASIS_OPTIONS,
  downloadLichessGames,
  isLichessCacheStale,
  loadLichessEloCache,
  matchingLichessCache,
  saveLichessEloBasis,
  syncLichessElo,
  useLichessEloBasis,
  useLichessEloCache,
  LichessSyncError,
  type LichessEloBasis,
} from '../history/lichessSync';

function syncErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof LichessSyncError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

// The single rating home for linked accounts: effective rating, basis
// selector, and sync action in one block. Rating + games sync together;
// rating failures never block the games import.
export function LichessSyncControl({ username, rating }: { username: string; rating: number }) {
  const basis = useLichessEloBasis();
  const matchedElo = matchingLichessCache(useLichessEloCache(), username);
  const sync = useContext(SyncContext);
  const [busy, setBusy] = useState(false);
  const [syncState, setSyncState] = useState<string | null>(null);
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const syncingRef = useRef(false);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  const refreshStatus = async () => {
    try {
      setStatus(await importStatus());
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  // Reports only what the persistent lines cannot: failures, and how many
  // games arrived or gained missing details. A clean sync with nothing new
  // reports nothing.
  const syncAll = async (since?: string): Promise<string | null> => {
    const problems: string[] = [];
    let added = 0;
    let refreshed = 0;
    try {
      await syncLichessElo(username);
    } catch (error) {
      problems.push(syncErrorMessage(error, 'Rating sync failed.'));
    }
    try {
      const { payloads } = await downloadLichessGames(username, since);
      if (payloads.length) {
        const result = await bulkImport(payloads, { provider: 'lichess', username });
        const failed = Object.keys(result.errors).length;
        added = result.saved.length;
        refreshed = result.refreshed;
        if (failed) problems.push(`${failed} game${failed === 1 ? '' : 's'} failed to save.`);
      } else if (!since) {
        return 'No importable games found.';
      }
    } catch (error) {
      problems.push(syncErrorMessage(error, 'Games import failed.'));
    }
    await refreshStatus();
    // Bulk import writes straight to the server, bypassing the game
    // repository. Refresh it so history shows the new games without a
    // page reload; failures stay silent here since the import itself
    // already succeeded and reported its counts.
    if (added || refreshed) {
      try {
        await syncRef.current?.retry();
      } catch {
        /* import counts above already reported; history refreshes next load */
      }
    }
    if (problems.length) return problems.join(' ');
    const parts: string[] = [];
    if (added) parts.push(`+${added} new game${added === 1 ? '' : 's'}.`);
    if (refreshed)
      parts.push(`filled missing details on ${refreshed} game${refreshed === 1 ? '' : 's'}.`);
    return parts.length ? parts.join(' ') : null;
  };

  const doSync = async (since?: string) => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setBusy(true);
    setSyncState('Syncing…');
    try {
      setSyncState(await syncAll(since));
    } finally {
      syncingRef.current = false;
      setBusy(false);
    }
  };

  // First load + hourly: sync when the cache is missing or stale. A 5-minute
  // ticker covers long-open tabs; staleness itself is hourly. A basis change
  // also re-syncs, since the cache records the basis it was fetched with.
  const usernameRef = useRef(username);
  usernameRef.current = username;
  const basisRef = useRef(basis);
  basisRef.current = basis;
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    let live = true;
    const maybeSync = async () => {
      if (!live || syncingRef.current) return;
      if (
        !isLichessCacheStale(
          loadLichessEloCache(),
          usernameRef.current,
          Date.now(),
          basisRef.current,
        )
      )
        return;
      syncingRef.current = true;
      setBusy(true);
      try {
        if (live) setSyncState(await syncAll(statusRef.current?.last?.created_at));
      } catch {
        // syncAll already degrades per leg; nothing left to report.
      } finally {
        syncingRef.current = false;
        if (live) setBusy(false);
      }
    };
    void maybeSync();
    const timer = setInterval(
      () => {
        void maybeSync();
      },
      5 * 60 * 1000,
    );
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, basis]);

  const doBasisChange = (next: LichessEloBasis) => {
    if (next === basis || busy) return;
    saveLichessEloBasis(next);
    // The effect above re-runs on the basis change and syncs; an explicit
    // pass here covers the case where it is already mid-flight and skips.
    if (!syncingRef.current) void doSync(status?.last?.created_at);
  };

  const last = status?.last ?? null;
  const fellBack = matchedElo !== null && basis !== 'auto' && basis !== matchedElo.perf;
  return (
    <div className="settings-control">
      <div className="account-row account-row--sync">
        <span className="rating-value">{rating}</span>
        <select
          value={basis}
          disabled={busy}
          onChange={event => doBasisChange(event.target.value as LichessEloBasis)}
          aria-label="Rating basis"
        >
          {LICHESS_BASIS_OPTIONS.map(option => (
            <option key={option} value={option}>
              {option === 'auto' ? 'Auto (most played)' : option[0].toUpperCase() + option.slice(1)}
            </option>
          ))}
        </select>
        {last ? (
          <>
            <Button
              variant="primary"
              className="sync-button"
              onClick={() => doSync(last.created_at)}
              disabled={busy}
              aria-label="Sync now"
              title="Sync now"
            >
              <RefreshCw size={16} aria-hidden="true" />
            </Button>
            <Button
              variant="quiet"
              onClick={() => doSync()}
              disabled={busy}
              aria-label="Backfill details"
              title="Re-download your full Lichess history to fill missing details (opponent, rating change, time control, clock readings) on already-imported games"
            >
              Backfill details
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={() => doSync()} disabled={busy}>
            {busy ? 'Importing…' : 'Import games + rating'}
          </Button>
        )}
      </div>
      <p>
        {matchedElo
          ? `Managed by Lichess sync${fellBack ? ` (${basis} unrated, using ${matchedElo.perf})` : ''}.`
          : 'Syncs your Lichess rating as the baseline.'}
      </p>
      {syncState && <p role="status">{syncState}</p>}
    </div>
  );
}
