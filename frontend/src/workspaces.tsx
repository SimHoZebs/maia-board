import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Key } from '@lichess-org/chessground/types';
import type { DrawShape } from '@lichess-org/chessground/draw';
import { Menu, RotateCw, Plus, Undo2, Flag } from 'lucide-react';
import { NavLink } from 'react-router';
import { Chess } from 'chess.js';
import { ChessBoard } from './ChessBoard';
import { Button, IconButton } from './components';
import { AnalysisActions, AnalysisControls, PlayControls, type Props } from './Controls';
import { InsightPanel, MoveNavBar, MovesPanel, StockfishBar } from './ReadPanels';
import { Dialog } from './Dialog';
import { analysisLength, gameResult, lineRecord, oppositeColor, replay, resultTextForTip, sideName, START_FEN, storedGameResult } from './domain';
import type { BoardPosition, BoardTransition } from './ChessBoard';
import { toGroundColor } from './board-colors';
import { currentPosition } from './state';
import { usePlayFeedback } from './usePlayFeedback';
import { useReview } from './useReview';
import { reviewShapes } from './reviewArrows';
import { ErrorBoundary, PanelError } from './ErrorBoundary';
import { destinations } from './BoardRouter';
import { RegionRecorder } from './perfCommits';
import { useLineOpenings } from './openings';

// Bottom-bar page menu (mobile bottom navigation): a hamburger on the left
// end of the move-navigation bar that opens the same destinations as the
// header tabs, thumb-reachable. The rest of the bar stays move navigation.
export function MobileMenu({ state, dispatch }: Props) {
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

// Placement-only viewport switch (no measuring): the mobile bottom bar is
// a separate mount from the inline move navigation, with exactly one of
// them mounted at a time so IDs stay unique.
function useMediaQuery(query: string): boolean {
  const current = () =>
    typeof window !== 'undefined' && typeof window.matchMedia !== 'undefined' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(current);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const list = window.matchMedia(query);
    setMatches(list.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function useMobileBar(): boolean {
  return useMediaQuery('(max-width: 760px)');
}

// Screens without a move list (settings, history, pre-start setup) get a
// menu-only bar instead of move navigation.
export function isMenuOnly(state: { mode: string; analysisLoaded: boolean; started: boolean }): boolean {
  const ready = state.mode === 'analysis' ? state.analysisLoaded : state.mode === 'play' ? state.started : false;
  return (state.mode !== 'play' && state.mode !== 'analysis') || !ready;
}

// The mobile bottom bar lives outside the padded content flow (full-bleed,
// last in-flow child of the page) while inline navigation unmounts, so the
// bar can pin to the viewport without shifting content.
export function MobileBarPortal({ state, dispatch }: Props) {
  const mobileBar = useMobileBar();
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => { setHost(document.body); }, []);
  if (!mobileBar || !host) return null;
  const menu = <MobileMenu state={state} dispatch={dispatch} />;
  const nav = state.mode === 'analysis'
    ? <MoveNavBar ply={state.analysis.index} total={analysisLength(state.analysis)} onView={ply => dispatch({ type: 'view', ply })} menu={menu} />
    : <MoveNavBar ply={state.viewedPly ?? state.play.moves.length} total={state.play.moves.length} onView={ply => dispatch({ type: 'view', ply })} menu={menu} />;
  return createPortal(
    <div className="mobile-footer">{isMenuOnly(state) ? <div className="mobile-pagebar"><div className="menu-slot">{menu}</div></div> : nav}</div>,
    host,
  );
}
// Shared board-stage shell: the toolbar, strips, board frame, move-list slot,
// result overlay slot, and error banner are structurally identical in both
// modes. Only the computed inputs differ, so each workspace builds those and
// slots in its own panels. The review/play-feedback hooks live in the
// workspace that uses them, so an inactive mode has no coordinator at all.
function BoardShell({ state, dispatch, ready, toolbar, position, transition, orientation, enabled, over, withEvaluation, boardResetKey, shapes, evalBar, renderStrip, movesPanel, resultOverlay }: Props & {
  ready: boolean;
  toolbar: ReactNode;
  position: BoardPosition;
  transition: BoardTransition;
  orientation: 'white' | 'black';
  enabled: boolean;
  over: boolean;
  withEvaluation: boolean;
  boardResetKey: string;
  shapes: DrawShape[];
  evalBar: ReactNode;
  renderStrip: (color: 'white' | 'black') => ReactNode;
  movesPanel: ReactNode;
  resultOverlay: ReactNode;
}) {
  const { request, error, revision } = state;
  return <section className={`board-stage${over ? ' game-over' : ''}`} aria-label="Chess workspace">
    {toolbar}
    {renderStrip(oppositeColor(orientation))}
    <div className={`board-frame${withEvaluation ? ' with-evaluation' : ''}`}><ErrorBoundary label="board" resetKey={boardResetKey} renderFallback={(error, retry) => <PanelError id="board-error" title="Board failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><ChessBoard position={position} transition={transition} orientation={orientation} enabled={enabled} thinking={!!request} interactionVersion={revision} shapes={shapes} onMove={(from, to) => dispatch({ type: 'move', from, to })} />{evalBar}</ErrorBoundary></div>
    {renderStrip(orientation)}
    {movesPanel}
    {resultOverlay}
    <div id="error-banner" className="error-banner" role="alert" hidden={!error}>{error}{error && ready && !request && <Button id="retry-request" variant="quiet" onClick={() => dispatch({ type: 'retry' })}>Retry</Button>}</div>
  </section>;
}

export function PlayWorkspace({ state, dispatch }: Props) {
  const { request } = state;
  const settings = state.play.settings;
  // Play-only engine: the analysis coordinator does not exist on this page.
  const moveFeedback = usePlayFeedback(state);
  const ply = state.viewedPly ?? state.play.moves.length;
  const position = currentPosition(state);
  const game = new Chess(position.fen);
  // Memoized once-per-line derivation: fen/SAN/turn/history-aware terminality.
  const playLine = lineRecord(state.play.moves);
  // Position-only live game for turn display. Terminality always comes from
  // the history-aware memoized record (FEN parses miss repetition draws).
  const live = playLine ? new Chess(playLine.fen) : replay(state.play.moves);
  const ready = state.started;
  const orientation = state.flipped ? oppositeColor(settings.userColor) : settings.userColor;
  const historic = state.viewedPly !== null;
  const userTurn = toGroundColor(live.turn()) === settings.userColor;
  const resigned = ready && state.play.result === 'resigned';
  const boardOver = ready && (playLine ? playLine.terminal !== null : live.isGameOver());
  const tipOver = playLine ? playLine.terminal !== null : live.isGameOver();
  const viewedOver = (position.terminal ?? null) !== null;
  const enabled = ready && !state.promotion && !resigned && !viewedOver && !tipOver && !historic && !request && userTurn;
  const full = { sanMoves: playLine ? playLine.sanMoves : live.history() };
  const { opening: playOpening, bookFlags: playBookFlags } = useLineOpenings(state.play.moves, START_FEN, ply);
  // Narrow-boundary reset keys: new content deserves a fresh render attempt
  // instead of a stale panel fallback. Each workspace keys only its own
  // inputs — cross-mode navigation unmounts the other workspace, which
  // discards its error boundaries anyway.
  const boardResetKey = JSON.stringify(['play', state.play.id, state.play.moves.length, state.viewedPly, orientation]);
  const [confirmResign, setConfirmResign] = useState(false);
  const replyIdentity = state.insight?.mode === 'play' ? state.insight.response : undefined;
  const strip = (color: 'white' | 'black') => {
    const shownGame = historic ? game : live;
    const shownOver = (historic ? (position.terminal ?? null) : (playLine?.terminal ?? null)) !== null;
    const active = !resigned && toGroundColor(shownGame.turn()) === color && !shownOver;
    return <div className={`player-strip${active && ready ? ' active' : ''}`}><span className={`side-dot ${color}`} /><strong>{color === settings.userColor ? 'You' : `Maia · ${settings.eloMaia}`}</strong>{color !== settings.userColor && replyIdentity?.degraded && <span role="status">{replyIdentity.model_used} fallback · requested {settings.model}</span>}<span className="player-side">{sideName(color)}</span>{active && ready && <span className="turn-indicator" role="status">{historic ? 'At this position' : request ? 'Thinking…' : 'To move'}</span>}</div>;
  };
  const over = boardOver || resigned;
  useEffect(() => { if (over) setConfirmResign(false); }, [over]);
  const winner = resigned ? oppositeColor(settings.userColor) : over && live.isCheckmate() ? oppositeColor(toGroundColor(live.turn())) : null;
  const resultText = resigned ? storedGameResult(state.play) : playLine ? resultTextForTip(playLine.fen, playLine.terminal) : gameResult(live);
  const mobileBar = useMobileBar();
  const tools = <><IconButton id="flip-board" label="Flip board" onClick={() => dispatch({ type: 'flip' })}><RotateCw size={16} aria-hidden="true" /></IconButton><IconButton id="takeback" label="Takeback" disabled={!state.play.moves.length || !!resigned} onClick={() => dispatch({ type: 'takeback' })}><Undo2 size={16} aria-hidden="true" /></IconButton>{!over && <IconButton id="resign" label="Resign" onClick={() => setConfirmResign(true)}><Flag size={16} aria-hidden="true" /></IconButton>}{mobileBar && ready && <IconButton id="new-game" label="New game" onClick={() => dispatch({ type: 'setup' })}><Plus size={18} aria-hidden="true" /></IconButton>}</>;
  return <>
    <div className={`workspace${!ready ? ' awaiting' : ''}${over ? ' game-over' : ''}`}>
      <RegionRecorder id="board-stage">
        <BoardShell state={state} dispatch={dispatch} ready={ready} toolbar={ready && mobileBar ? <div className="board-actions board-toolbar" role="toolbar" aria-label="Board actions">{tools}</div> : null}
          position={position} transition={{ line: state.play.id, ply }} orientation={orientation} enabled={enabled} over={over} withEvaluation={false} boardResetKey={boardResetKey} shapes={[]} evalBar={null} renderStrip={strip}
          movesPanel={ready ? <MovesPanel sans={full.sanMoves} ply={ply} initialFen={START_FEN} qualities={moveFeedback.qualities} badgeLoading={state.badgeLoading} onView={ply => dispatch({ type: 'view', ply })} onOriginalView={ply => { dispatch({ type: 'original' }); dispatch({ type: 'view', ply }); }} analysis={false}
            original={undefined} hideNav={mobileBar}
            branchUp={mobileBar} tools={mobileBar ? undefined : tools} opening={playOpening} bookFlags={playBookFlags} /> : null}
          resultOverlay={over ? <div className="game-result" role="status"><div className="result-copy"><span className="result-eyebrow">Game over</span><strong className="result-text">{winner && <span className={`side-dot ${winner}`} aria-hidden="true" />}{resultText}</strong></div><div className="result-actions"><Button variant="primary" onClick={() => dispatch({ type: 'review' })}>Review game</Button><Button id="new-game-again" onClick={() => dispatch({ type: 'setup' })}>New game</Button></div></div> : null} />
      </RegionRecorder>
    </div>
    {ready && <RegionRecorder id="chrome"><><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /></></RegionRecorder>}
    {confirmResign && !over && <Dialog title="Resign game?" onCancel={() => setConfirmResign(false)}>
      <h2>Resign game?</h2>
      <p>Maia wins. This ends the game.</p>
      <div className="actions">
        <Button id="confirm-resign" onClick={() => { setConfirmResign(false); dispatch({ type: 'resign' }); }}>Resign</Button>
        <Button onClick={() => setConfirmResign(false)}>Cancel</Button>
      </div>
    </Dialog>}
  </>;
}

export function AnalysisWorkspace({ state, dispatch }: Props) {
  // Analysis-only engine: the play coordinator does not exist on this page.
  const review = useReview(state);
  const ply = state.analysis.index;
  // Displayed position is an O(1) lookup into the review timeline built once
  // per line in useReview. The fallback covers a transient out-of-range index
  // the way a clamped slice would.
  const position = review.nodes[ply] ?? review.nodes[review.nodes.length - 1];
  const game = new Chess(position.fen);
  const ready = state.analysisLoaded;
  const orientation = state.flipped ? oppositeColor('white') : 'white';
  const viewedOver = position.outcome !== null;
  const enabled = ready && !state.promotion && !viewedOver;
  // The full SAN list comes from the tip of the same timeline: identical to
  // replaying the whole line, but free after the once-per-line build.
  const full = { sanMoves: review.timeline.rows.slice(1).map(row => row.san) };
  const { opening: analysisOpening, bookFlags: analysisBookFlags } = useLineOpenings(review.timeline.moves, state.analysis.initialFen, ply);
  // Forward estimates for the next move: the board shows the position after
  // x, so the arrows project y. White draws the played continuation (the
  // board's tile highlight only covers x); red/blue are Maia/Stockfish top
  // choices from here.
  const arrowMoves = { actual: review.nodes[ply + 1]?.uci ?? undefined, maia: review.maiaCurrent?.top_moves[0]?.move, stockfish: review.current?.best_move };
  const playedQuality = ready && ply > 0 ? review.qualities[ply - 1] : undefined;
  const playedUci = ready && ply > 0 ? review.nodes[ply]?.uci : undefined;
  const badge = playedQuality && (playedQuality.label === 'Skull' || playedQuality.label === 'Blunder' || playedQuality.label === 'Mistake') && playedUci
    ? { square: playedUci.slice(2, 4) as Key, glyph: (playedQuality.label === 'Skull' ? '💀' : playedQuality.label === 'Blunder' ? '??' : '?') as '💀' | '??' | '?' } : null;
  const shapes = ready ? reviewShapes(arrowMoves, { actual: true, maia: true, stockfish: true }, state.preview, badge) : [];
  const boardResetKey = JSON.stringify(['analysis', state.play.id, state.play.moves.length, state.analysis.index, state.analysisSourceId, orientation]);
  const insightResetKey = JSON.stringify([state.analysis.initialFen, state.analysis.moves, state.analysisSourceId]);
  const strip = (color: 'white' | 'black') => {
    const shownOver = viewedOver;
    const active = toGroundColor(game.turn()) === color && !shownOver;
    return <div className={`player-strip${active && ready ? ' active' : ''}`}><span className={`side-dot ${color}`} /><strong>{sideName(color)}</strong><span className="player-side"></span>{active && ready && <span className="turn-indicator" role="status">To move</span>}</div>;
  };
  const mobileBar = useMobileBar();
  const tools = <><IconButton id="flip-board" label="Flip board" onClick={() => dispatch({ type: 'flip' })}><RotateCw size={16} aria-hidden="true" /></IconButton>{state.analysis.branchFromPly !== null && <IconButton id="return-original" label="Return to original" onClick={() => dispatch({ type: 'original' })}><Undo2 size={16} aria-hidden="true" /></IconButton>}</>;
  return <>
    <div className={`workspace${ready ? ' analyzing' : ''}${!ready ? ' awaiting' : ''}`}>
      <RegionRecorder id="board-stage">
        <BoardShell state={state} dispatch={dispatch} ready={ready} toolbar={ready && mobileBar ? <div className="board-actions board-toolbar" role="toolbar" aria-label="Board actions">{tools}</div> : null}
          position={position} transition={{ line: insightResetKey, ply }} orientation={orientation} enabled={enabled} over={false} withEvaluation={ready} boardResetKey={boardResetKey} shapes={shapes}
          evalBar={ready ? <StockfishBar key={`${insightResetKey}|${review.tooLong ? 1 : 0}`} evaluation={review.current} orientation={orientation} failed={!!review.currentError} /> : null}
          renderStrip={strip}
          movesPanel={ready ? <MovesPanel sans={full.sanMoves} ply={ply} initialFen={state.analysis.initialFen} qualities={review.qualities} badgeLoading={state.badgeLoading} onView={ply => dispatch({ type: 'view', ply })} onOriginalView={ply => { dispatch({ type: 'original' }); dispatch({ type: 'view', ply }); }} analysis={true}
            original={state.analysis.branchFromPly !== null ? { sans: state.analysis.sanMoves, fromPly: state.analysis.branchFromPly } : undefined}
            branchUp={mobileBar} tools={mobileBar ? undefined : tools} hideNav={mobileBar} opening={analysisOpening} bookFlags={analysisBookFlags} /> : null}
          resultOverlay={null} />
      </RegionRecorder>
      {ready && <ErrorBoundary label="insight" resetKey={insightResetKey} renderFallback={(error, retry) => <PanelError id="insight-error" title="Analysis failed to render" message={error.message || 'Unknown rendering error.'} onRetry={retry} />}><RegionRecorder id="insight-panel"><InsightPanel key={insightResetKey} state={state} dispatch={dispatch} review={review}><AnalysisActions state={state} dispatch={dispatch} /></InsightPanel></RegionRecorder></ErrorBoundary>}
    </div>
    {ready && <RegionRecorder id="chrome"><><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /></></RegionRecorder>}
  </>;
}
