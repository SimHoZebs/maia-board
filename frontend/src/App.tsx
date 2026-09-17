import { useEffect, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { IconButton } from './components';
import { AnalysisControls, PlayControls, type Props } from './Controls';
import { SavedGames } from './ReadPanels';
import { PromotionDialog } from './PromotionDialog';
import { SettingsPage } from './SettingsPage';
import { ErrorBoundary, PanelError } from './ErrorBoundary';
import { RegionRecorder } from './perfCommits';
import { HistoryRecovery } from './HistoryRecovery';
import { AnalysisWorkspace, MobileBarPortal, PlayWorkspace, useMobileBar } from './workspaces';

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
      if (!ready || (mode !== 'play' && mode !== 'analysis') || event.altKey || event.ctrlKey || event.metaKey || (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"], dialog'))) return;
      const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null;
      if (delta !== null) { event.preventDefault(); if (delta === 1 && mode === 'analysis') dispatch({ type: 'advance' }); else dispatch({ type: 'step', delta }); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); dispatch({ type: 'view', ply: event.key === 'Home' ? 0 : null }); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [ready, mode, dispatch]);
  const mobileBar = useMobileBar();
  return <div className={`app-shell${mobileBar ? ' bottom-ui' : ''}`}>
    <RegionRecorder id="chrome"><header className="site-header"><span className="brand">maia board</span>{children}{mode === 'play' && ready && !mobileBar && <IconButton id="new-game" className="header-action" label="New game" onClick={() => dispatch({ type: 'setup' })}><Plus size={18} aria-hidden="true" /></IconButton>}</header></RegionRecorder>
    <main>
      <HistoryRecovery />
      {mode === 'settings' ? <SettingsPage state={state} dispatch={dispatch} /> : mode === 'history' ? <ErrorBoundary label="saved games" resetKey={savedResetKey} renderFallback={(error, retry) => <PanelError id="saved-games-error" title="Saved games failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><SavedGames state={state} dispatch={dispatch} /></ErrorBoundary> : <>
        {!ready && <div className="entry"><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /></div>}
        {analysis ? <AnalysisWorkspace state={state} dispatch={dispatch} /> : <PlayWorkspace state={state} dispatch={dispatch} />}
      </>}
    </main>
    <MobileBarPortal state={state} dispatch={dispatch} />
    <PromotionDialog open={!!state.promotion} onChoose={piece => dispatch({ type: 'promote', piece })} />
  </div>;
}
