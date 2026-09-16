import { useState } from 'react';
import { Button } from './components';
import { Dialog } from './Dialog';
import { useSyncSnapshot, useSyncStore } from './syncStore';

export function HistoryRecovery() {
  const sync = useSyncStore();
  useSyncSnapshot(sync);
  const [discard, setDiscard] = useState<string | null>(null);
  const recoverable = sync.recoveryItems.length > 0;
  // Transient outbox work (every play move saves + flushes) must not flash
  // this banner: it shows only when work is stuck or needs a decision.
  // The pending count stays as context inside the stuck banner (e.g. offline
  // with an error), never as the sole reason to mount.
  const stuck = sync.failedVersion !== null || sync.conflict;
  if (!sync.error && !recoverable && !stuck) return null;
  const exportWork = () => {
    const url = URL.createObjectURL(new Blob([sync.exportPending()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'maia-board-recovery.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="sync-banner">
    {sync.error && <span role="alert">{sync.error}</span>}
    {recoverable && <span role="status">Some saved data needs recovery. Export it before discarding.</span>}
    {sync.pending > 0 && <span role="status">{sync.pending} pending history {sync.pending === 1 ? 'change' : 'changes'}.</span>}
    {sync.error && <Button onClick={() => void sync.retry()}>Retry</Button>}
    <Button onClick={exportWork}>Export recovery data</Button>
    {sync.failedVersion && <Button onClick={() => setDiscard(sync.failedVersion)}>Discard failed change…</Button>}
    {sync.recoveryItems.map((item, index) => <Button key={item.version} onClick={() => setDiscard(item.version)}>Discard recovery item {index + 1}…</Button>)}
    {discard && <Dialog title="Discard pending data?" onCancel={() => setDiscard(null)}>
      <h2>Discard pending data?</h2>
      <p>This removes this item from pending recovery. Export recovery data first if you need a copy. Existing local games remain available.</p>
      <div className="actions"><Button onClick={() => { sync.discardPending(discard); setDiscard(null); }}>Discard item</Button><Button onClick={() => setDiscard(null)}>Cancel</Button></div>
    </Dialog>}
  </div>;
}
