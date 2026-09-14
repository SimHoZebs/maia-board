import { useEffect, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Button, IconButton } from './components';
import { AnalysisControls, PlayControls, type Props } from './Controls';
import { SavedGames } from './ReadPanels';
import { PromotionDialog } from './PromotionDialog';
import { SettingsPage } from './SettingsPage';
import { ErrorBoundary, PanelError } from './ErrorBoundary';
import { RegionRecorder } from './perfCommits';
import { useSyncSnapshot, useSyncStore } from './syncStore';
import { AnalysisWorkspace, MobileMenu, PlayWorkspace } from './workspaces';

// Sync banner subscribed narrowly to the history-sync store: pending/error
// updates re-render only this banner, never the board mid-animation.
function SyncBanner({ dispatch }: { dispatch: Props['dispatch'] }) {
  const sync = useSyncStore();
  useSyncSnapshot(sync);
  if (!sync.error) return null;
  return <div className="sync-banner" role="alert"><span>{sync.error}</span><Button onClick={() => { sync.clearError(); dispatch({ type: 'retry-sync' }); }}>Retry</Button></div>;
}

// Route shell: header, sync banner, settings/history branches, and the
// pre-start entry. The play and analysis engines mount in their own
// workspaces below, so an inactive mode has no coordinator, no subscription,
// and no derivations at all.
export function App({ state, dispatch, children }: Props & { children: ReactNode }) {
  const { mode } = state;
  const analysis = mode === 'analysis';
  const ready = analysis ? state.analysisLoaded : mode === 'play' ? state.started : false;
  // Narrow-boundary reset keys: new content deserves a fresh render attempt
  // instead of a stale panel fallback. History changes clear only their panel.
  const savedResetKey = JSON.stringify([state.saved.map(game => game.id), state.saved.length]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!ready || (mode !== 'play' && mode !== 'analysis') || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], dialog')) return;
      const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null;
      if (delta !== null) { event.preventDefault(); dispatch({ type: 'step', delta }); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); dispatch({ type: 'view', ply: event.key === 'Home' ? 0 : null }); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [ready, mode, dispatch]);
  const bottomNav = state.bottomNav;
  // Screens without a move list (settings, history, pre-start setup) still
  // need page navigation once the header tabs step aside: a menu-only bar.
  const menuOnly = bottomNav && ((mode !== 'play' && mode !== 'analysis') || !ready);
  return <div className={`app-shell${bottomNav ? ' bottom-ui' : ''}`}>
    <RegionRecorder id="chrome"><header className="site-header"><span className="brand">maia board</span>{children}{mode === 'play' && ready && !bottomNav && <IconButton id="new-game" className="header-action" label="New game" onClick={() => dispatch({ type: 'setup' })}><Plus size={18} aria-hidden="true" /></IconButton>}</header></RegionRecorder>
    <main>
      <SyncBanner dispatch={dispatch} />
      {mode === 'settings' ? <SettingsPage state={state} dispatch={dispatch} /> : mode === 'history' ? <ErrorBoundary label="saved games" resetKey={savedResetKey} renderFallback={(error, retry) => <PanelError id="saved-games-error" title="Saved games failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><SavedGames state={state} dispatch={dispatch} /></ErrorBoundary> : <>
        {!ready && <div className="entry"><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /></div>}
        {analysis ? <AnalysisWorkspace state={state} dispatch={dispatch} /> : <PlayWorkspace state={state} dispatch={dispatch} />}
      </>}
    </main>
    {menuOnly && <div className="mobile-pagebar"><div className="menu-slot"><MobileMenu state={state} dispatch={dispatch} /></div></div>}
    <PromotionDialog open={!!state.promotion} onChoose={piece => dispatch({ type: 'promote', piece })} />
  </div>;
}
