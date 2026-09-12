import { useEffect, useState, type ReactNode } from 'react';
import type { Key } from '@lichess-org/chessground/types';
import { RotateCw, Plus, Undo2, Flag } from 'lucide-react';
import { Chess } from 'chess.js';
import { ChessBoard } from './ChessBoard';
import { Button, IconButton } from './components';
import { AnalysisActions, AnalysisControls, PlayControls, type Props } from './Controls';
import { InsightPanel, MovesPanel, SavedGames, StockfishBar } from './ReadPanels';
import { PromotionDialog } from './PromotionDialog';
import { Dialog } from './Dialog';
import { analysisLength, analysisLine, gameResult, oppositeColor, replay, sideName, START_FEN, storedGameResult } from './domain';
import { toGroundColor } from './board-colors';
import { currentPosition } from './state';
import { usePlayFeedback } from './usePlayFeedback';
import { useReview } from './useReview';
import { reviewShapes } from './reviewArrows';
import { SettingsPage } from './SettingsPage';
import { ErrorBoundary, PanelError } from './ErrorBoundary';

export function App({ state, dispatch, children }: Props & { children: ReactNode }) {
  const { mode, settings, request, error } = state;
  const review = useReview(state);
  const moveFeedback = usePlayFeedback(state);
  const position = currentPosition(state);
  const game = new Chess(position.fen), live = replay(state.play.moves);
  const analysis = mode === 'analysis';
  const ready = analysis ? state.analysisLoaded : state.started;
  const base = analysis ? 'white' : settings.userColor;
  const orientation = state.flipped ? oppositeColor(base) : base;
  const historic = mode === 'play' && state.viewedPly !== null;
  const userTurn = toGroundColor(live.turn()) === settings.userColor;
  const resigned = !analysis && ready && state.play.result === 'resigned';
  const boardOver = !analysis && ready && live.isGameOver();
  const enabled = ready && !state.promotion && !resigned && !game.isGameOver() && (analysis || (mode === 'play' && !live.isGameOver() && !historic && !request && userTurn));
  const full = analysis ? analysisLine(state.analysis, analysisLength(state.analysis)) : { sanMoves: live.history() };
  const ply = analysis ? state.analysis.index : state.viewedPly ?? state.play.moves.length;
  const arrowMoves = { actual: review.nodes[ply + 1]?.moves[ply], maia: review.maia?.top_moves[0]?.move, stockfish: review.current?.best_move };
  const playedQuality = analysis && ready && ply > 0 ? review.qualities[ply - 1] : undefined;
  const playedUci = analysis && ready && ply > 0 ? review.nodes[ply]?.moves[ply - 1] : undefined;
  const badge = playedQuality && (playedQuality.label === 'Blunder' || playedQuality.label === 'Mistake') && playedUci
    ? { square: playedUci.slice(2, 4) as Key, glyph: (playedQuality.label === 'Blunder' ? '??' : '?') as '??' | '?' } : null;
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
    const active = !resigned && toGroundColor(shownGame.turn()) === color && !shownGame.isGameOver();
    return <div className={`player-strip${active && ready ? ' active' : ''}`}><span className={`side-dot ${color}`} /><strong>{analysis ? sideName(color) : color === settings.userColor ? 'You' : `Maia · ${settings.eloMaia}`}</strong><span className="player-side">{!analysis && sideName(color)}</span>{active && ready && <span className="turn-indicator" role="status">{historic ? 'At this position' : request && !analysis ? 'Thinking…' : 'To move'}</span>}</div>;
  };
  const over = boardOver || resigned;
  const winner = resigned ? oppositeColor(settings.userColor) : over && live.isCheckmate() ? oppositeColor(toGroundColor(live.turn())) : null;
  const resultText = resigned ? storedGameResult(state.play) : gameResult(live);
  const [confirmResign, setConfirmResign] = useState(false);
  useEffect(() => { if (over || analysis) setConfirmResign(false); }, [over, analysis]);
  return <div className="app-shell">
    <header className="site-header"><span className="brand">maia board</span>{children}{mode === 'play' && ready && <IconButton id="new-game" className="header-action" label="New game" onClick={() => dispatch({ type: 'setup' })}><Plus size={18} aria-hidden="true" /></IconButton>}</header>
    <main>
      {state.syncError && <div className="sync-banner" role="alert"><span>{state.syncError}</span><Button onClick={() => dispatch({ type: 'retry-sync' })}>Retry</Button></div>}
      {mode === 'settings' ? <SettingsPage state={state} dispatch={dispatch} /> : mode === 'history' ? <ErrorBoundary label="saved games" resetKey={savedResetKey} renderFallback={(error, retry) => <PanelError id="saved-games-error" title="Saved games failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><SavedGames state={state} dispatch={dispatch} /></ErrorBoundary> : <>
        {!ready && <div className="entry"><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /></div>}
        <div className={`workspace${analysis && ready ? ' analyzing' : ''}${!ready ? ' awaiting' : ''}${over ? ' game-over' : ''}`}>
          <section className={`board-stage${over ? ' game-over' : ''}`} aria-label="Chess workspace">
            {ready && <div className="board-actions board-toolbar" role="toolbar" aria-label="Board actions"><IconButton id="flip-board" label="Flip board" onClick={() => dispatch({ type: 'flip' })}><RotateCw size={16} aria-hidden="true" /></IconButton>{analysis && state.analysis.branchFromPly !== null && <IconButton id="return-original" label="Return to original" onClick={() => dispatch({ type: 'original' })}><Undo2 size={16} aria-hidden="true" /></IconButton>}{!analysis && <IconButton id="takeback" label="Takeback" disabled={!state.play.moves.length || !!resigned} onClick={() => dispatch({ type: 'takeback' })}><Undo2 size={16} aria-hidden="true" /></IconButton>}{!analysis && !over && <IconButton id="resign" label="Resign" onClick={() => setConfirmResign(true)}><Flag size={16} aria-hidden="true" /></IconButton>}</div>}
            {strip(oppositeColor(orientation))}
            <div className={`board-frame${analysis && ready ? ' with-evaluation' : ''}`}><ErrorBoundary label="board" resetKey={boardResetKey} renderFallback={(error, retry) => <PanelError id="board-error" title="Board failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><ChessBoard position={position} orientation={orientation} enabled={enabled} thinking={!!request} interactionVersion={state.revision} shapes={shapes} onMove={(from, to) => dispatch({ type: 'move', from, to })} />{analysis && ready && <StockfishBar evaluation={review.current} orientation={orientation} />}</ErrorBoundary></div>
            {strip(orientation)}
            {ready && <>
              <MovesPanel sans={full.sanMoves} ply={ply} initialFen={analysis ? state.analysis.initialFen : START_FEN} historical={historic} qualities={analysis ? review.qualities : moveFeedback.qualities} onView={ply => dispatch({ type: 'view', ply })} onOriginalView={ply => { dispatch({ type: 'original' }); dispatch({ type: 'view', ply }); }} analysis={analysis}
                original={analysis && state.analysis.branchFromPly !== null ? { sans: state.analysis.sanMoves, fromPly: state.analysis.branchFromPly } : undefined} />
              {over && <div className="game-result" role="status"><div className="result-copy"><span className="result-eyebrow">Game over</span><strong className="result-text">{winner && <span className={`side-dot ${winner}`} aria-hidden="true" />}{resultText}</strong></div><div className="result-actions"><Button variant="primary" onClick={() => dispatch({ type: 'review' })}>Review game</Button><Button id="new-game-again" onClick={() => dispatch({ type: 'setup' })}>New game</Button></div></div>}
            </>}
            <div id="error-banner" className="error-banner" role="alert" hidden={!error}>{error}{error && ready && !request && <Button id="retry-request" variant="quiet" onClick={() => dispatch({ type: 'retry' })}>Retry</Button>}</div>
          </section>
          {analysis && ready && <ErrorBoundary label="insight" resetKey={insightResetKey} renderFallback={(error, retry) => <PanelError id="insight-error" title="Analysis failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><InsightPanel key={insightResetKey} state={state} dispatch={dispatch} review={review}><AnalysisActions state={state} dispatch={dispatch} /></InsightPanel></ErrorBoundary>}
        </div>
        {ready && <><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /></>}
      </>}
    </main>
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
