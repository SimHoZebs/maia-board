import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Key } from '@lichess-org/chessground/types';
import { Menu, RotateCw, Plus, Undo2, Flag } from 'lucide-react';
import { NavLink } from 'react-router';
import { Chess } from 'chess.js';
import { ChessBoard } from './ChessBoard';
import { Button, IconButton } from './components';
import { AnalysisActions, AnalysisControls, PlayControls, type Props } from './Controls';
import { InsightPanel, MovesPanel, SavedGames, StockfishBar } from './ReadPanels';
import { PromotionDialog } from './PromotionDialog';
import { Dialog } from './Dialog';
import { gameResult, lineRecord, oppositeColor, replay, resultTextForTip, sideName, START_FEN, storedGameResult } from './domain';
import { toGroundColor } from './board-colors';
import { currentPosition } from './state';
import { usePlayFeedback } from './usePlayFeedback';
import { useReview } from './useReview';
import { reviewShapes } from './reviewArrows';
import { SettingsPage } from './SettingsPage';
import { destinations } from './BoardRouter';
import { ErrorBoundary, PanelError } from './ErrorBoundary';
import { RegionRecorder } from './perfCommits';

// Bottom-bar page menu (mobile bottom navigation): a hamburger on the left
// end of the move-navigation bar that opens the same destinations as the
// header tabs, thumb-reachable. The rest of the bar stays move navigation.
function MobileMenu({ state, dispatch }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('#mobile-menu')?.focus(); }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);
  return <div className="menu-root" ref={root}>
    <IconButton id="mobile-menu" label="Menu" aria-haspopup="true" aria-expanded={open} aria-controls="mobile-menu-sheet" onClick={() => setOpen(value => !value)}><Menu size={18} aria-hidden="true" /></IconButton>
    {open && <nav className="mobile-menu-sheet" id="mobile-menu-sheet" aria-label="Pages">
      {destinations.map(({ mode: destMode, path, label }) => (
        <NavLink
          id={`mobile-mode-${destMode}`}
          key={destMode}
          to={path}
          end
          onClick={(event) => {
            setOpen(false);
            if (destMode === 'analysis' && state.analysisLoaded) {
              event.preventDefault();
              dispatch({ type: 'unload' });
            }
          }}
        >
          {label}
        </NavLink>
      ))}
    </nav>}
  </div>;
}

export function App({ state, dispatch, children }: Props & { children: ReactNode }) {
  const { mode, settings, request, error } = state;
  const review = useReview(state);
  const moveFeedback = usePlayFeedback(state);
  const analysis = mode === 'analysis';
  const ply = analysis ? state.analysis.index : state.viewedPly ?? state.play.moves.length;
  // Analysis mode reads the displayed position from the review timeline
  // (built once per line in useReview) instead of replaying the line on
  // every render, so cursor steps are O(1) lookups. The fallback covers a
  // transient out-of-range index the way a clamped slice would. Play mode
  // keeps its memoized line record below.
  const position: ReturnType<typeof currentPosition> = analysis
    ? { fen: (review.nodes[ply] ?? review.nodes[review.nodes.length - 1]).fen } as ReturnType<typeof currentPosition>
    : currentPosition(state);
  const game = new Chess(position.fen);
  // Play tip derivation is memoized (one shared replay per line at most):
  // side-to-move is position-only, terminality is history-aware via the record.
  const playLine = mode === 'play' ? lineRecord(state.play.moves) : null;
  // The live play game is play-only: analysis renders must not replay it.
  // new Chess() keeps the type without the replay cost. It is never read in
  // analysis mode: every consumer below is mode-guarded or short-circuits.
  const live = playLine ? new Chess(playLine.fen) : analysis ? new Chess() : replay(state.play.moves);
  const ready = analysis ? state.analysisLoaded : state.started;
  const base = analysis ? 'white' : settings.userColor;
  const orientation = state.flipped ? oppositeColor(base) : base;
  const historic = mode === 'play' && state.viewedPly !== null;
  const userTurn = !analysis && toGroundColor(live.turn()) === settings.userColor;
  const resigned = !analysis && ready && state.play.result === 'resigned';
  const boardOver = !analysis && ready && (playLine ? playLine.terminal !== null : live.isGameOver());
  // Viewed-position terminality is history-aware in play mode (the sliced line
  // record, which preserves prefix history for repetition); analysis keeps its
  // existing single-parse check unchanged.
  const tipOver = !analysis && (playLine ? playLine.terminal !== null : live.isGameOver());
  const viewedOver = analysis ? game.isGameOver() : (position.terminal ?? null) !== null;
  const enabled = ready && !state.promotion && !resigned && !viewedOver && (analysis || (mode === 'play' && !tipOver && !historic && !request && userTurn));
  // The full SAN list comes from the tip of the same timeline: identical to
  // replaying the whole line, but free after the once-per-line build.
  const full = analysis ? { sanMoves: review.nodes[review.nodes.length - 1].sanMoves } : { sanMoves: playLine ? playLine.sanMoves : live.history() };
  // Forward estimates for the next move: the board shows the position after
  // x, so the arrows project y. White draws the played continuation (the
  // board's tile highlight only covers x); red/blue are Maia/Stockfish top
  // choices from here.
  const arrowMoves = { actual: review.nodes[ply + 1]?.moves[ply], maia: review.maiaCurrent?.top_moves[0]?.move, stockfish: review.current?.best_move };
  const playedQuality = analysis && ready && ply > 0 ? review.qualities[ply - 1] : undefined;
  const playedUci = analysis && ready && ply > 0 ? review.nodes[ply]?.moves[ply - 1] : undefined;
  const badge = playedQuality && (playedQuality.label === 'Skull' || playedQuality.label === 'Blunder' || playedQuality.label === 'Mistake') && playedUci
    ? { square: playedUci.slice(2, 4) as Key, glyph: (playedQuality.label === 'Skull' ? '💀' : playedQuality.label === 'Blunder' ? '??' : '?') as '💀' | '??' | '?' } : null;
  const shapes = analysis && ready ? reviewShapes(arrowMoves, { actual: true, maia: true, stockfish: true }, state.preview, badge) : [];
  // Narrow-boundary reset keys: new content deserves a fresh render attempt
  // instead of a stale panel fallback. Board navigation, game loads, and
  // history changes each clear only their own panel.
  const boardResetKey = JSON.stringify([mode, state.play.id, state.play.moves.length, state.viewedPly, state.analysis.index, state.analysisSourceId, orientation]);
  const insightResetKey = JSON.stringify([state.analysis.initialFen, state.analysis.moves, state.analysisSourceId]);
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
  const strip = (color: 'white' | 'black') => {
    const shownGame = analysis || historic ? game : live;
    // Analysis keeps its existing check; play reads the memoized terminal so a
    // repetition draw at the viewed (or tip) position is honored.
    const shownOver = analysis ? shownGame.isGameOver()
      : (historic ? (position.terminal ?? null) : (playLine?.terminal ?? null)) !== null;
    const active = !resigned && toGroundColor(shownGame.turn()) === color && !shownOver;
    return <div className={`player-strip${active && ready ? ' active' : ''}`}><span className={`side-dot ${color}`} /><strong>{analysis ? sideName(color) : color === settings.userColor ? 'You' : `Maia · ${settings.eloMaia}`}</strong><span className="player-side">{!analysis && sideName(color)}</span>{active && ready && <span className="turn-indicator" role="status">{historic ? 'At this position' : request && !analysis ? 'Thinking…' : 'To move'}</span>}</div>;
  };
  const over = boardOver || resigned;
  const winner = resigned ? oppositeColor(settings.userColor) : over && live.isCheckmate() ? oppositeColor(toGroundColor(live.turn())) : null;
  const resultText = resigned ? storedGameResult(state.play) : mode === 'play' && playLine ? resultTextForTip(playLine.fen, playLine.terminal) : !analysis ? gameResult(live) : '';
  const [confirmResign, setConfirmResign] = useState(false);
  useEffect(() => { if (over || analysis) setConfirmResign(false); }, [over, analysis]);
  const bottomNav = state.bottomNav;
  // Screens without a move list (settings, history, pre-start setup) still
  // need page navigation once the header tabs step aside: a menu-only bar.
  const menuOnly = bottomNav && ((mode !== 'play' && mode !== 'analysis') || !ready);
  const tools = <><IconButton id="flip-board" label="Flip board" onClick={() => dispatch({ type: 'flip' })}><RotateCw size={16} aria-hidden="true" /></IconButton>{analysis && state.analysis.branchFromPly !== null && <IconButton id="return-original" label="Return to original" onClick={() => dispatch({ type: 'original' })}><Undo2 size={16} aria-hidden="true" /></IconButton>}{!analysis && <IconButton id="takeback" label="Takeback" disabled={!state.play.moves.length || !!resigned} onClick={() => dispatch({ type: 'takeback' })}><Undo2 size={16} aria-hidden="true" /></IconButton>}{!analysis && !over && <IconButton id="resign" label="Resign" onClick={() => setConfirmResign(true)}><Flag size={16} aria-hidden="true" /></IconButton>}{bottomNav && mode === 'play' && ready && <IconButton id="new-game" label="New game" onClick={() => dispatch({ type: 'setup' })}><Plus size={18} aria-hidden="true" /></IconButton>}</>;
  return <div className={`app-shell${bottomNav ? ' bottom-ui' : ''}`}>
    <RegionRecorder id="chrome"><header className="site-header"><span className="brand">maia board</span>{children}{mode === 'play' && ready && !bottomNav && <IconButton id="new-game" className="header-action" label="New game" onClick={() => dispatch({ type: 'setup' })}><Plus size={18} aria-hidden="true" /></IconButton>}</header></RegionRecorder>
    <main>
      {state.syncError && <div className="sync-banner" role="alert"><span>{state.syncError}</span><Button onClick={() => dispatch({ type: 'retry-sync' })}>Retry</Button></div>}
      {mode === 'settings' ? <SettingsPage state={state} dispatch={dispatch} /> : mode === 'history' ? <ErrorBoundary label="saved games" resetKey={savedResetKey} renderFallback={(error, retry) => <PanelError id="saved-games-error" title="Saved games failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><SavedGames state={state} dispatch={dispatch} /></ErrorBoundary> : <>
        {!ready && <div className="entry"><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /></div>}
        <div className={`workspace${analysis && ready ? ' analyzing' : ''}${!ready ? ' awaiting' : ''}${over ? ' game-over' : ''}`}>
          <RegionRecorder id="board-stage"><section className={`board-stage${over ? ' game-over' : ''}`} aria-label="Chess workspace">
            {ready && bottomNav && <div className="board-actions board-toolbar" role="toolbar" aria-label="Board actions">{tools}</div>}
            {strip(oppositeColor(orientation))}
            <div className={`board-frame${analysis && ready ? ' with-evaluation' : ''}`}><ErrorBoundary label="board" resetKey={boardResetKey} renderFallback={(error, retry) => <PanelError id="board-error" title="Board failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><ChessBoard position={position} orientation={orientation} enabled={enabled} thinking={!!request} interactionVersion={state.revision} shapes={shapes} onMove={(from, to) => dispatch({ type: 'move', from, to })} />{analysis && ready && <StockfishBar key={`${insightResetKey}|${review.tooLong ? 1 : 0}`} evaluation={review.current} orientation={orientation} failed={!!review.currentError} />}</ErrorBoundary></div>
            {strip(orientation)}
            {ready && <>
              <MovesPanel sans={full.sanMoves} ply={ply} initialFen={analysis ? state.analysis.initialFen : START_FEN} qualities={analysis ? review.qualities : moveFeedback.qualities} badgeLoading={state.badgeLoading} onView={ply => dispatch({ type: 'view', ply })} onOriginalView={ply => { dispatch({ type: 'original' }); dispatch({ type: 'view', ply }); }} analysis={analysis}
                original={analysis && state.analysis.branchFromPly !== null ? { sans: state.analysis.sanMoves, fromPly: state.analysis.branchFromPly } : undefined}
                branchUp={bottomNav} tools={bottomNav ? undefined : tools} menu={bottomNav ? <MobileMenu state={state} dispatch={dispatch} /> : undefined} />
              {over && <div className="game-result" role="status"><div className="result-copy"><span className="result-eyebrow">Game over</span><strong className="result-text">{winner && <span className={`side-dot ${winner}`} aria-hidden="true" />}{resultText}</strong></div><div className="result-actions"><Button variant="primary" onClick={() => dispatch({ type: 'review' })}>Review game</Button><Button id="new-game-again" onClick={() => dispatch({ type: 'setup' })}>New game</Button></div></div>}
            </>}
            <div id="error-banner" className="error-banner" role="alert" hidden={!error}>{error}{error && ready && !request && <Button id="retry-request" variant="quiet" onClick={() => dispatch({ type: 'retry' })}>Retry</Button>}</div>
          </section></RegionRecorder>
          {analysis && ready && <ErrorBoundary label="insight" resetKey={insightResetKey} renderFallback={(error, retry) => <PanelError id="insight-error" title="Analysis failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><RegionRecorder id="insight-panel"><InsightPanel key={insightResetKey} state={state} dispatch={dispatch} review={review}><AnalysisActions state={state} dispatch={dispatch} /></InsightPanel></RegionRecorder></ErrorBoundary>}
        </div>
        {ready && <RegionRecorder id="chrome"><><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /></></RegionRecorder>}
      </>}
    </main>
    {menuOnly && <div className="mobile-pagebar"><div className="menu-slot"><MobileMenu state={state} dispatch={dispatch} /></div></div>}
    <PromotionDialog open={!!state.promotion} onChoose={piece => dispatch({ type: 'promote', piece })} />
    {confirmResign && !analysis && !over && <Dialog title="Resign game?" onCancel={() => setConfirmResign(false)}>
      <h2>Resign game?</h2>
      <p>Maia wins. This ends the game.</p>
      <div className="actions">
        <Button id="confirm-resign" onClick={() => { setConfirmResign(false); dispatch({ type: 'resign' }); }}>Resign</Button>
        <Button onClick={() => setConfirmResign(false)}>Cancel</Button>
      </div>
    </Dialog>}
  </div>;
}
