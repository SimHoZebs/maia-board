import { useEffect, useState, type ReactNode } from 'react';
import { FlipVertical2, Plus, Undo2 } from 'lucide-react';
import { Chess } from 'chess.js';
import { ChessBoard } from './ChessBoard';
import { AnalysisActions, AnalysisControls, PlayControls, type Props } from './Controls';
import { InsightPanel, MovesPanel, SavedGames } from './ReadPanels';
import { PromotionDialog } from './PromotionDialog';
import { analysisLength, analysisLine, gameResult, oppositeColor, replay, sideName, START_FEN } from './domain';
import { toGroundColor } from './board-colors';
import { currentPosition } from './state';
import { useReview } from './useReview';
import { reviewShapes, type ArrowToggles } from './reviewArrows';
import { ArrowLegend } from './ArrowLegend';

export function App({ state, dispatch, children }: Props & { children: ReactNode }) {
  const { mode, settings, request, error } = state;
  const review = useReview(state);
  const [arrows, setArrows] = useState<ArrowToggles>({ actual: true, maia: true, stockfish: true });
  const position = currentPosition(state);
  const game = new Chess(position.fen), live = replay(state.play.moves);
  const analysis = mode === 'analysis';
  const ready = analysis ? state.analysisLoaded : state.started;
  const base = analysis ? 'white' : settings.userColor;
  const orientation = state.flipped ? oppositeColor(base) : base;
  const historic = mode === 'play' && state.viewedPly !== null;
  const userTurn = toGroundColor(live.turn()) === settings.userColor;
  const enabled = ready && !state.promotion && !game.isGameOver() && (analysis || (mode === 'play' && !live.isGameOver() && !historic && !request && userTurn));
  const full = analysis ? analysisLine(state.analysis, analysisLength(state.analysis)) : { sanMoves: live.history() };
  const ply = analysis ? state.analysis.index : state.viewedPly ?? state.play.moves.length;
  const arrowMoves = { actual: review.nodes[ply + 1]?.moves[ply], maia: review.maia?.top_moves[0]?.move, stockfish: review.current?.best_move };
  const shapes = analysis && ready ? reviewShapes(arrowMoves, arrows, state.preview) : [];
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!ready || mode === 'history' || event.altKey || event.ctrlKey || event.metaKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], dialog')) return;
      const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : null;
      if (delta !== null) { event.preventDefault(); dispatch({ type: 'step', delta }); }
      else if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); dispatch({ type: 'view', ply: event.key === 'Home' ? 0 : null }); }
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [ready, mode, dispatch]);
  const strip = (color: 'white' | 'black') => {
    const shownGame = analysis || historic ? game : live;
    const active = toGroundColor(shownGame.turn()) === color && !shownGame.isGameOver();
    return <div className={`player-strip${active && ready ? ' active' : ''}`}><span className={`side-dot ${color}`} /><strong>{analysis ? sideName(color) : color === settings.userColor ? 'You' : `Maia · ${settings.eloMaia}`}</strong><span className="player-side">{!analysis && sideName(color)}</span>{active && ready && <span className="turn-indicator" role="status">{historic ? 'At this position' : request && !analysis ? 'Thinking…' : 'To move'}</span>}</div>;
  };
  return <div className="app-shell">
    <header className="site-header"><span className="brand">maia board</span>{children}</header>
    <main>
      {mode === 'history' ? <SavedGames state={state} dispatch={dispatch} /> : <>
        {!ready && <div className="entry"><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /></div>}
        <div className={`workspace${analysis && ready ? ' analyzing' : ''}${historic ? ' historical' : ''}${!analysis && live.isGameOver() ? ' finished' : ''}${!ready ? ' awaiting' : ''}`}>
          <section className="board-stage" aria-label="Chess workspace">
            {strip(oppositeColor(orientation))}
            <div className="board-frame"><ChessBoard position={position} orientation={orientation} enabled={enabled} thinking={!!request} interactionVersion={state.revision} shapes={shapes} onMove={(from, to) => dispatch({ type: 'move', from, to })} /></div>
            {strip(orientation)}
            {ready && <>
              <MovesPanel sans={full.sanMoves} ply={ply} initialFen={analysis ? state.analysis.initialFen : START_FEN} historical={historic} qualities={analysis ? review.qualities : undefined} onView={ply => dispatch({ type: 'view', ply })} />
              <div className="board-actions"><button id="flip-board" onClick={() => dispatch({ type: 'flip' })}><FlipVertical2 size={16} aria-hidden="true" />Flip board</button>{!analysis && <><button id="takeback" disabled={!state.play.moves.length} onClick={() => dispatch({ type: 'takeback' })}><Undo2 size={16} aria-hidden="true" />Takeback</button><button id="new-game" onClick={() => dispatch({ type: 'setup' })}><Plus size={16} aria-hidden="true" />New game</button></>}</div>
              {analysis && state.analysis.branchFromPly !== null && <p className="branch-label">Exploring a temporary line · original game preserved</p>}
              {analysis && <AnalysisActions state={state} dispatch={dispatch} />}
              {!analysis && live.isGameOver() && <div className="game-result"><strong>{gameResult(live)}</strong><button className="primary" onClick={() => dispatch({ type: 'review' })}>Review game</button></div>}
            </>}
            <div id="error-banner" className="error-banner" role="alert" hidden={!error}>{error}</div>
          </section>
          {analysis && ready && <InsightPanel state={state} dispatch={dispatch} review={review} legend={<ArrowLegend fen={position.fen} moves={arrowMoves} toggles={arrows} onToggle={source => setArrows(current => ({ ...current, [source]: !current[source] }))} />} />}
        </div>
        {ready && <><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /></>}
      </>}
    </main>
    <PromotionDialog open={!!state.promotion} onChoose={piece => dispatch({ type: 'promote', piece })} />
  </div>;
}
