import { Chess } from 'chess.js';
import { ChessBoard } from './ChessBoard';
import { AnalysisControls, PlayControls } from './Controls';
import { InsightPanel, MovesPanel, SavedGames } from './ReadPanels';
import { PromotionDialog } from './PromotionDialog';
import { oppositeColor, replay, sideName } from './domain';
import { toGroundColor } from './board-colors';
import { currentPosition } from './state';
import { useMaiaBoard } from './useMaiaBoard';

export function App() {
  const { state, dispatch } = useMaiaBoard();
  const { mode, settings, request, error } = state;
  const position = currentPosition(state);
  const game = mode === 'play' ? replay(state.play.moves) : new Chess(position.fen);
  const userTurn = mode === 'play' && toGroundColor(game.turn()) === settings.userColor;
  const baseOrientation = mode === 'play' ? settings.userColor : 'white';
  const title = mode === 'analysis' ? 'Read the position.' : request ? 'Maia is choosing.' : game.isGameOver() ? 'Game over.' : userTurn ? 'Your move.' : 'The line continues.';
  const status = error || (request ? 'Maia is reading the position...' : mode === 'play' && game.isGameOver() ? 'This game is over.' : userTurn ? 'Your move. Maia will answer on its turn.' : mode === 'analysis' ? 'Step through the line, then ask Maia for its read.' : 'Maia is ready for the next position.');
  return <>
    <div className="app-shell">
      <header className="site-header"><a className="brand" href="/" aria-label="Maia Board home"><span className="brand-mark" aria-hidden="true">M3</span><span><span className="brand-name">maia board</span><span className="brand-kicker">human moves, modeled</span></span></a>
        <nav className="mode-switch" aria-label="Board mode">{(['play', 'analysis'] as const).map(value => <button className={`mode-tab${mode === value ? ' is-active' : ''}`} id={`mode-${value}`} key={value} type="button" aria-pressed={mode === value} onClick={() => dispatch({ type: 'mode', mode: value })}>{value === 'play' ? 'Play' : 'Analysis'}</button>)}</nav>
        <div className={`connection-state${request ? ' is-thinking' : ''}${error ? ' is-error' : ''}`} id="connection-state"><span className="connection-dot" aria-hidden="true" /><span id="connection-label">{request ? 'Thinking' : error ? 'Check server' : 'Ready'}</span></div>
      </header>
      <main className="workspace"><section className="board-stage" aria-label="Chess board"><div className="stage-heading"><div><p className="eyebrow" id="stage-eyebrow">{mode === 'play' ? 'Live game / Maia3' : 'Position lab / Maia3'}</p><h1 id="stage-title">{title}</h1></div><div className="turn-chip" id="turn-chip">{sideName(toGroundColor(game.turn()))} to move</div></div>
        <div className="board-frame"><ChessBoard position={position} orientation={state.flipped ? oppositeColor(baseOrientation) : baseOrientation} enabled={userTurn && !request && !state.promotion && !game.isGameOver()} thinking={!!request} interactionVersion={state.revision} onMove={(from, to) => dispatch({ type: 'move', from, to })} /><div className="board-corner board-corner-tl" aria-hidden="true">M3</div><div className="board-corner board-corner-br" aria-hidden="true">01</div></div>
        <div className="board-footer"><div className="board-status" id="board-status" role="status" aria-live="polite">{status}</div><button className="text-button" id="flip-board" type="button" onClick={() => dispatch({ type: 'flip' })}>Flip board</button></div><div className="error-banner" id="error-banner" role="alert" hidden={!error}>{error}</div>
      </section><aside className="control-rail"><PlayControls state={state} dispatch={dispatch} /><AnalysisControls state={state} dispatch={dispatch} /><InsightPanel state={state} /><MovesPanel sans={mode === 'play' ? position.sanMoves : state.analysis.sanMoves} activeIndex={mode === 'analysis' ? state.analysis.index - 1 : -1} /><SavedGames state={state} dispatch={dispatch} /></aside></main>
      <footer className="site-footer"><span>Maia3 inference stays on your server.</span><span>CPU-ready / LAN-first</span></footer>
    </div>
    <PromotionDialog open={!!state.promotion} onChoose={piece => dispatch({ type: 'promote', piece })} />
  </>;
}
