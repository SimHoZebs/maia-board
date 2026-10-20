import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DrawBrushes, DrawShape } from '@lichess-org/chessground/draw';
import { ChartLine, Menu, RotateCw, Plus, Undo2, Flag } from 'lucide-react';
import { NavLink } from 'react-router';
import { ChessBoard } from '../board/ChessBoard';
import { Button, IconButton } from '../components';
import { AnalysisActions, AnalysisControls, PlayControls, type Props } from './Controls';
import { InsightPanel, MoveNavBar, MovesPanel, ObjectiveBar } from './ReadPanels';
import { Dialog } from './Dialog';
import {
  analysisLength,
  buildTimeline,
  formatClock,
  LOW_TIME_CENTISECONDS,
  materialAt,
  oppositeColor,
  parseKey,
  remainingAt,
  resolveBoardOrientation,
  resultTextForOutcome,
  rowAt,
  sideName,
  START_FEN,
  storedGameResult,
  tipRow,
  type LinePlayer,
} from '../shared/domain';
import type { BoardPosition, BoardTransition } from '../board/ChessBoard';
import { usePlayFeedback } from '../play/usePlayFeedback';
import { plyOrNull } from '../shared/explicit';
import { accountDisplayName, useAccountName } from '../history/session';
import { useReview } from '../review/useReview';
import {
  losingKingBadge,
  losingKingShapes,
  reviewBrushes,
  reviewShapes,
  type ArrowSource,
  type SquareBadge,
} from '../review/reviewArrows';
import { buildReviewBrushes } from '../settings/arrowSettings';
import { ErrorBoundary, PanelError } from './ErrorBoundary';
import { destinations } from './BoardRouter';
import { RegionRecorder } from './perfCommits';
import { useLineOpenings } from '../theory/openings';
import {
  capturedGlyph,
  capturedLabel,
  buildCapturePrefix,
  captureAt,
  materialLeadFor,
  type CapturedPiece,
} from '../theory/material';
import { PlayVerdict } from '../play/PlayVerdict';

function MaterialSummary({
  by,
  captures,
  lead,
}: {
  by: 'white' | 'black';
  captures: CapturedPiece[];
  lead: number;
}) {
  if (!captures.length && lead <= 0) return null;
  return (
    <span className="material-summary" role="img" aria-label={capturedLabel(by, captures, lead)}>
      {captures.length > 0 && (
        <span aria-hidden="true" className="captured-pieces">
          {captures.map((piece, index) => (
            <span key={index} className={`captured captured-${by === 'white' ? 'black' : 'white'}`}>
              {capturedGlyph(by, piece)}
            </span>
          ))}
        </span>
      )}
      {lead > 0 && (
        <span aria-hidden="true" className="material-lead">
          +{lead}
        </span>
      )}
    </span>
  );
}

// Bottom-bar page menu (mobile bottom navigation): a hamburger on the left
// end of the move-navigation bar that opens the same destinations as the
// header tabs, thumb-reachable. The rest of the bar stays move navigation.
export function MobileMenu({ state, dispatch }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !(event.target instanceof Node && root.current.contains(event.target)))
        setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>('#mobile-menu')?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-root" ref={root}>
      <IconButton
        id="mobile-menu"
        label="Menu"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls="mobile-menu-sheet"
        onClick={() => setOpen(value => !value)}
      >
        <Menu size={18} aria-hidden="true" />
      </IconButton>
      {open && (
        <nav className="mobile-menu-sheet" id="mobile-menu-sheet" aria-label="Pages">
          {destinations.map(({ mode: destMode, path, label, Icon }) => (
            <NavLink
              id={`mobile-mode-${destMode}`}
              key={destMode}
              to={path}
              end
              onClick={event => {
                setOpen(false);
                dispatch({ type: 'mode', mode: destMode });
                if (destMode === 'analysis' && state.analysisLoaded) {
                  event.preventDefault();
                  dispatch({ type: 'unload' });
                }
              }}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  );
}

// Placement-only viewport switch (no measuring): the mobile bottom bar is
// a separate mount from the inline move navigation, with exactly one of
// them mounted at a time so IDs stay unique. An external store, not an
// effect: the initial matchMedia read returns the current match, so there is no
// mount effect plus corrective second commit.
function useMediaQuery(query: string): boolean {
  // Stable across renders so the store subscribes once per query: new
  // closures every render would detach and reattach the listener for free.
  const subscribe = useMemo(
    () => (notify: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined')
        return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', notify);
      return () => list.removeEventListener('change', notify);
    },
    [query],
  );
  const getSnapshot = useMemo(
    () => () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia !== 'undefined' &&
      window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function useMobileBar(): boolean {
  return useMediaQuery('(max-width: 760px)');
}

// Screens without a move list (settings, history, pre-start setup) get a
// menu-only bar instead of move navigation.
export function isMenuOnly(state: {
  mode: string;
  analysisLoaded: boolean;
  started: boolean;
}): boolean {
  const ready =
    state.mode === 'analysis'
      ? state.analysisLoaded
      : state.mode === 'play'
        ? state.started
        : false;
  return (state.mode !== 'play' && state.mode !== 'analysis') || !ready;
}

// The mobile bottom bar lives outside the padded content flow (full-bleed,
// last in-flow child of the page) while inline navigation unmounts, so the
// bar can pin to the viewport without shifting content.
export function MobileBarPortal({ state, dispatch }: Props) {
  const mobileBar = useMobileBar();
  // Client-only static app (no SSR): document.body is available on first
  // render, so no mount effect + second commit is needed for the portal host.
  const [host] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' ? document.body : null,
  );
  if (!mobileBar || !host) return null;
  const menu = <MobileMenu state={state} dispatch={dispatch} />;
  const nav =
    state.mode === 'analysis' ? (
      <MoveNavBar
        ply={state.analysis.index}
        total={analysisLength(state.analysis)}
        onView={ply => dispatch({ type: 'view', ply })}
        onAdvance={() => dispatch({ type: 'advance' })}
        menu={menu}
      />
    ) : (
      <MoveNavBar
        ply={state.viewedPly ?? state.play.moves.length}
        total={state.play.moves.length}
        onView={ply => dispatch({ type: 'view', ply })}
        menu={menu}
      />
    );
  return createPortal(
    <div className="mobile-footer">
      {isMenuOnly(state) ? (
        <div className="mobile-pagebar">
          <div className="menu-slot">{menu}</div>
        </div>
      ) : (
        nav
      )}
    </div>,
    host,
  );
}
// Shared board-stage shell: the toolbar, strips, board frame, move-list slot,
// result overlay slot, and error banner are structurally identical in both
// modes. Only the computed inputs differ, so each workspace builds those and
// slots in its own panels. The review/play-feedback hooks live in the
// workspace that uses them, so an inactive mode has no coordinator at all.
function BoardShell({
  state,
  dispatch,
  ready,
  toolbar,
  position,
  transition,
  orientation,
  enabled,
  over,
  withEvaluation,
  boardResetKey,
  shapes,
  brushes,
  evalBar,
  renderStrip,
  movesPanel,
  resultOverlay,
}: Props & {
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
  brushes?: DrawBrushes;
  evalBar: ReactNode;
  renderStrip: (color: 'white' | 'black') => ReactNode;
  movesPanel: ReactNode;
  resultOverlay: ReactNode;
}) {
  const { request, error, revision } = state;
  // Arrowhead markers are append-only defs keyed by brush name: a brushes
  // change remounts the board for fresh heads (shafts alone would repaint via
  // the shapes hash). Settings live on their own page so the board is usually
  // remounted by navigation anyway; the key makes it exact.
  const brushesKey = brushes
    ? JSON.stringify([brushes.actual, brushes.bot, brushes.stockfish, brushes.candidate])
    : 'default';
  return (
    <section className={`board-stage${over ? ' game-over' : ''}`} aria-label="Chess workspace">
      {toolbar}
      {renderStrip(oppositeColor(orientation))}
      <div
        className={`board-frame${withEvaluation ? ' with-evaluation' : ''}${state.coordinatesOnSquares ? '' : ' coords-outside'}`}
      >
        <ErrorBoundary
          label="board"
          resetKey={boardResetKey}
          renderFallback={(error, retry) => (
            <PanelError
              id="board-error"
              title="Board failed to render"
              message={error.message || 'Unknown rendering error.'}
              onRetry={retry}
            />
          )}
        >
          <ChessBoard
            key={`${state.coordinatesOnSquares ? 'squares' : 'outside'}|${brushesKey}`}
            position={position}
            transition={transition}
            orientation={orientation}
            enabled={enabled}
            thinking={!!request}
            interactionVersion={revision}
            coordinatesOnSquares={state.coordinatesOnSquares}
            shapes={shapes}
            brushes={brushes ?? reviewBrushes}
            onMove={(from, to) => dispatch({ type: 'move', from, to })}
          />
          {evalBar}
        </ErrorBoundary>
      </div>
      {renderStrip(orientation)}
      {movesPanel}
      {resultOverlay}
      <div id="error-banner" className="error-banner" role="alert" hidden={!error}>
        {error}
        {error && ready && !request && (
          <Button id="retry-request" variant="quiet" onClick={() => dispatch({ type: 'retry' })}>
            Retry
          </Button>
        )}
      </div>
    </section>
  );
}

export function PlayWorkspace({ state, dispatch }: Props) {
  const { request } = state;
  const settings = state.play.settings;
  // Play-only engine: the analysis coordinator does not exist on this page.
  const moveFeedback = usePlayFeedback(state);
  // Identity for the player strips: the signed-in display name, falling back
  // to 'You' before login and in unit tests (no session provider there).
  const you = accountDisplayName(useAccountName());
  const ply = state.viewedPly ?? state.play.moves.length;
  // Once-per-line timeline: tip + viewed rows are O(1) cached reads, never
  // per-render replays. The viewed position addresses the full-line timeline
  // directly, so scrubbing never builds prefix timelines.
  const playTimeline = buildTimeline(START_FEN, state.play.moves);
  const playTip = tipRow(playTimeline);
  const viewedRow = rowAt(playTimeline, ply);
  const position = { fen: viewedRow.fen, lastMove: viewedRow.lastMove };
  const ready = state.started;
  const orientation = resolveBoardOrientation(
    state.boardOrientation,
    settings.userColor,
    state.flipped,
  );
  const historic = state.viewedPly !== null;
  const userTurn = playTip.turn === settings.userColor;
  const resigned = ready && state.play.result === 'resigned';
  const boardOver = ready && playTip.outcome !== null;
  const tipOver = playTip.outcome !== null;
  const viewedOver = viewedRow.outcome !== null;
  const enabled =
    ready &&
    !state.promotion &&
    !resigned &&
    !viewedOver &&
    !tipOver &&
    !historic &&
    !request &&
    userTurn;
  // SAN list is a cheap projection over the cached once-per-line timeline
  // (rows already materialize SAN; this only re-slices references), so no
  // memo is needed — the React Compiler owns caching here.
  const full = { sanMoves: playTimeline.rows.slice(1).map(row => row.san) };
  const { bookFlags: playBookFlags } = useLineOpenings(state.play.moves, START_FEN, ply);
  // Narrow-boundary reset keys: new content deserves a fresh render attempt
  // instead of a stale panel fallback. Each workspace keys only its own
  // inputs — cross-mode navigation unmounts the other workspace, which
  // discards its error boundaries anyway.
  const boardResetKey = JSON.stringify([
    'play',
    state.play.id,
    state.play.moves.length,
    state.viewedPly,
    orientation,
  ]);
  const [confirmResign, setConfirmResign] = useState(false);
  const replyIdentity =
    state.insight !== null && state.insight.mode === 'play' ? state.insight.response : null;
  const displayedPly = state.viewedPly ?? state.play.moves.length;
  // Prefix table rebuilt only when the move list identity changes: every
  // render (including viewed-ply browsing) is an O(1) lookup instead of an
  // O(ply) chess.js replay.
  const playCapturePrefix = useMemo(
    () => buildCapturePrefix(START_FEN, state.play.moves),
    [state.play.moves],
  );
  const playCaptures = captureAt(playCapturePrefix, displayedPly);
  const playDiff = materialAt(playTimeline, displayedPly).diff;
  const userLabel = `${you} (${settings.userElo})`;
  const botLabel = `Maia (${settings.botElo})`;
  const strip = (color: 'white' | 'black') => {
    const shownTurn = historic ? viewedRow.turn : playTip.turn;
    const shownOver = (historic ? viewedRow.outcome : playTip.outcome) !== null;
    const active = !resigned && shownTurn === color && !shownOver;
    const isActive = active && ready;
    const label = color === settings.userColor ? userLabel : botLabel;
    // Remaining time at the displayed ply for resumed imports (local games
    // carry no readings, so the span stays unmounted there).
    const left = remainingAt(state.play, displayedPly, color);
    // Turn is shown by a green pill behind the active name; while the bot
    // is thinking that pill slowly pulses instead of showing text.
    const thinking = !!request && isActive;
    return (
      <div
        className={`player-strip${isActive ? ' active' : ''}${thinking ? ' thinking' : ''}`}
        aria-label={`${sideName(color)}: ${label}${isActive ? ', to move' : ''}`}
      >
        <span className="player-identity">
          <span className={`side-dot ${color}`} aria-hidden="true" />
          <strong>{label}</strong>
        </span>
        <MaterialSummary
          by={color}
          captures={playCaptures[color]}
          lead={materialLeadFor(playDiff, color)}
        />
        {color !== settings.userColor && replyIdentity !== null && replyIdentity.degraded && (
          <span role="status">Fallback model reply</span>
        )}
        {thinking && (
          <span className="visually-hidden" role="status">
            Thinking…
          </span>
        )}
        {left !== undefined && (
          <span className={`clock-remaining${left < LOW_TIME_CENTISECONDS ? ' clock-low' : ''}`}>
            {formatClock(left)}
          </span>
        )}
      </div>
    );
  };
  const over = boardOver || resigned;
  // Render-phase dismissal (no effect): a finished game cannot keep the
  // resign confirmation. Resetting during render avoids one commit with the
  // dialog open over the result overlay, and avoids a stale `true` reopening
  // the dialog on the next game.
  if (over && confirmResign) setConfirmResign(false);
  const winner =
    resigned || !over
      ? resigned
        ? oppositeColor(settings.userColor)
        : null
      : playTip.outcome !== null && playTip.outcome.kind === 'checkmate'
        ? oppositeColor(playTip.turn)
        : null;
  const resultText = resigned
    ? storedGameResult(state.play)
    : resultTextForOutcome(playTip.outcome);
  // Flag on the losing king: resignation marks the player's own king at the
  // tip; checkmate marks the side to move in the displayed position. Historic
  // views show no flag so browsing earlier plies never flags a king that had
  // not yet lost.
  // Reactive derivation: the trigger (resigned/result, viewed position, and
  // checkmate state) is explicitly established with its output via useMemo,
  // so starting a new game (result cleared, fen reset to startpos) always
  // recomputes to no flag instead of holding a stale badge.
  const loser = useMemo<'white' | 'black' | null>(() => {
    if (resigned && !historic) return settings.userColor;
    if (!ready) return null;
    return viewedRow.outcome !== null && viewedRow.outcome.kind === 'checkmate'
      ? viewedRow.turn
      : null;
  }, [resigned, historic, settings.userColor, ready, viewedRow]);
  // Standalone play flag via the shared losing-king helper: identical badge
  // construction as the analysis mated-king flag, so resign and checkmate
  // clear through the same path on new game.
  const playShapes = useMemo(() => losingKingShapes(viewedRow.fen, loser), [viewedRow.fen, loser]);
  const mobileBar = useMobileBar();
  const tools = (
    <>
      <IconButton id="flip-board" label="Flip board" onClick={() => dispatch({ type: 'flip' })}>
        <RotateCw size={16} aria-hidden="true" />
      </IconButton>
      <IconButton
        id="takeback"
        label="Takeback"
        disabled={!state.play.moves.length || !!resigned}
        onClick={() => dispatch({ type: 'takeback' })}
      >
        <Undo2 size={16} aria-hidden="true" />
      </IconButton>
      {!over && (
        <IconButton id="resign" label="Resign" onClick={() => setConfirmResign(true)}>
          <Flag size={16} aria-hidden="true" />
        </IconButton>
      )}
      {mobileBar && ready && (
        <IconButton id="new-game" label="New game" onClick={() => dispatch({ type: 'setup' })}>
          <Plus size={18} aria-hidden="true" />
        </IconButton>
      )}
    </>
  );
  return (
    <>
      <div className={`workspace${!ready ? ' awaiting' : ''}${over ? ' game-over' : ''}`}>
        <RegionRecorder id="board-stage">
          <BoardShell
            state={state}
            dispatch={dispatch}
            ready={ready}
            toolbar={
              ready && mobileBar ? (
                <div
                  className="board-actions board-toolbar"
                  role="toolbar"
                  aria-label="Board actions"
                >
                  {tools}
                </div>
              ) : null
            }
            position={position}
            transition={{ line: state.play.id, ply }}
            orientation={orientation}
            enabled={enabled}
            over={over}
            withEvaluation={false}
            boardResetKey={boardResetKey}
            shapes={playShapes}
            evalBar={null}
            renderStrip={strip}
            movesPanel={
              ready ? (
                <>
                  <MovesPanel
                    sans={full.sanMoves}
                    ply={ply}
                    initialFen={START_FEN}
                    qualities={moveFeedback.qualities}
                    badgeLoading={state.badgeLoading}
                    onView={ply => dispatch({ type: 'view', ply })}
                    onOriginalView={ply => {
                      dispatch({ type: 'original' });
                      dispatch({ type: 'view', ply });
                    }}
                    analysis={false}
                    original={undefined}
                    hideNav={mobileBar}
                    branchUp={mobileBar}
                    tools={mobileBar ? undefined : tools}
                    bookFlags={playBookFlags}
                  />
                  <PlayVerdict state={state} feedback={moveFeedback} />
                </>
              ) : null
            }
            resultOverlay={
              over ? (
                <div className="game-result" role="status">
                  <div className="result-copy">
                    <span className="result-eyebrow">Game over</span>
                    <strong className="result-text">
                      {winner && <span className={`side-dot ${winner}`} aria-hidden="true" />}
                      {resultText}
                    </strong>
                  </div>
                  <div className="result-actions">
                    <Button variant="primary" onClick={() => dispatch({ type: 'review' })}>
                      <ChartLine size={16} aria-hidden="true" />
                      Review game
                    </Button>
                    <Button id="new-game-again" onClick={() => dispatch({ type: 'setup' })}>
                      <Plus size={16} aria-hidden="true" />
                      New game
                    </Button>
                  </div>
                </div>
              ) : null
            }
          />
        </RegionRecorder>
      </div>
      {ready && (
        <RegionRecorder id="chrome">
          <>
            <PlayControls state={state} dispatch={dispatch} />
            <AnalysisControls state={state} dispatch={dispatch} />
          </>
        </RegionRecorder>
      )}
      {confirmResign && !over && (
        <Dialog title="Resign game?" onCancel={() => setConfirmResign(false)}>
          <h2>Resign game?</h2>
          <p>Bot wins. This ends the game.</p>
          <div className="actions">
            <Button
              id="confirm-resign"
              onClick={() => {
                setConfirmResign(false);
                dispatch({ type: 'resign' });
              }}
            >
              Resign
            </Button>
            <Button onClick={() => setConfirmResign(false)}>Cancel</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function AnalysisWorkspace({ state, dispatch }: Props) {
  // Analysis-only engine: the play coordinator does not exist on this page.
  const review = useReview(state);
  const ply = state.analysis.index;
  // Displayed position is an O(1) lookup into the review timeline built once
  // per line in useReview. A transient out-of-range index falls back to the
  // tip by name — never a silent undefined. Plain indexing (not plyAt) keeps
  // the value compiler-visible for the memoized badge below; the explicit
  // bounds check is the failure guard, and node arrays are dense by
  // construction so in-range reads never miss.
  const position =
    ply >= 0 && ply < review.nodes.length
      ? review.nodes[ply]
      : review.nodes[review.nodes.length - 1];
  const ready = state.analysisLoaded;
  // Auto means the reviewed side faces the viewer: the player's own color
  // for reviewed games, otherwise the side to move in the starting position.
  const orientation = resolveBoardOrientation(
    state.boardOrientation,
    state.analysis.perspective,
    state.flipped,
  );
  const viewedOver = position.outcome !== null;
  const enabled = ready && !state.promotion && !viewedOver;
  // The full SAN list comes from the tip of the same timeline: identical to
  // replaying the whole line, but free after the once-per-line build.
  const full = { sanMoves: review.timeline.rows.slice(1).map(row => row.san) };
  const { bookFlags: analysisBookFlags } = useLineOpenings(
    review.timeline.moves,
    state.analysis.initialFen,
    ply,
  );
  // Book flags for the original-line continuation under a branch. Same-line
  // cache hit when unbranched (identical content key); the mainline entry is
  // already cached after analyzing the game, so branching adds no fetch.
  const { bookFlags: mainlineBookFlags } = useLineOpenings(
    state.analysis.moves,
    state.analysis.initialFen,
    ply,
  );
  // Arrow basis: 'next' projects forward from the viewed position (after x,
  // before y); 'past' shows the options for the move leading into it (from
  // the before-position of x). White draws the played move; red is the
  // display-Elo bot top choice; blue is the objective (bot 2400) top; yellow
  // is the Stockfish best move. The yellow next-best arrow always projects
  // forward from the viewed position (the best move to play next), in
  // either basis: same engine as Stockfish, same color, wider shaft.
  const pastArrows = state.arrowBasis === 'past';
  const before = ply - 1;
  // Eval-bar point for the viewed position. Null reads as empty bar, never
  // a silent undefined.
  const barPoint = plyOrNull(review.objective, ply, 'bar objective');
  // Arrow endpoints: null means no arrow (tip has no next, missing rows have
  // no candidate). Node reads are bounds-checked; row reads are lenient —
  // a missing row blanks its arrow instead of failing the board.
  const viewedArrowNode = plyOrNull(review.nodes, ply, 'arrow nodes');
  const nextArrowNode = plyOrNull(review.nodes, ply + 1, 'arrow nodes');
  const beforeArrowPoint =
    before >= 0 ? plyOrNull(review.objective, before, 'arrow objective') : null;
  const atPlyArrowPoint = plyOrNull(review.objective, ply, 'arrow objective');
  const firstTopMove = (row: { top_moves: { move: string }[] } | null): string | null => {
    if (row === null || row.top_moves.length === 0) return null;
    return row.top_moves[0].move;
  };
  const arrowMoves: Record<ArrowSource, string | null> = pastArrows
    ? {
        actual: ply > 0 && viewedArrowNode !== null ? viewedArrowNode.uci : null,
        bot: ply > 0 ? firstTopMove(review.bot) : null,
        objective: beforeArrowPoint === null ? null : beforeArrowPoint.top,
        stockfish: ply > 0 && review.focus !== null ? review.focus.best_move : null,
        next: review.current === null ? null : review.current.best_move,
      }
    : {
        actual: nextArrowNode === null ? null : nextArrowNode.uci,
        bot: firstTopMove(review.botCurrent),
        objective: atPlyArrowPoint === null ? null : atPlyArrowPoint.top,
        stockfish: review.current === null ? null : review.current.best_move,
        next: review.current === null ? null : review.current.best_move,
      };
  const playedQuality =
    ready && ply > 0 ? plyOrNull(review.qualities, ply - 1, 'badge qualities') : null;
  const playedUci = ready && ply > 0 && viewedArrowNode !== null ? viewedArrowNode.uci : null;
  const badgeSquare = playedUci === null ? null : parseKey(playedUci.slice(2, 4));
  const playedLabel = playedQuality === null ? null : playedQuality.label;
  const badgeGlyph: SquareBadge['glyph'] =
    playedLabel === 'Allowed mate' ? '💀' : playedLabel === 'Blunder' ? '??' : '?';
  const badge =
    playedQuality !== null &&
    (playedQuality.label === 'Allowed mate' ||
      playedQuality.label === 'Blunder' ||
      playedQuality.label === 'Mistake') &&
    playedUci !== null &&
    badgeSquare !== null
      ? { square: badgeSquare, glyph: badgeGlyph }
      : null;
  // Flag on the mated king when the displayed analysis position is checkmate.
  // Drawn-outcome positions and quiet middlegames show no flag. The flag leads
  // so it outranks a quality badge landing on the same square. Badge
  // construction is the shared losing-king helper, identical to the play
  // resign/checkmate flag.
  const matedLoser =
    position.outcome !== null && position.outcome.kind === 'checkmate'
      ? oppositeColor(position.outcome.winner)
      : null;
  const flagBadge: SquareBadge | null = useMemo(
    () => losingKingBadge(position.fen, matedLoser),
    [position.fen, matedLoser],
  );
  const badges = flagBadge && badge ? [flagBadge, badge] : (flagBadge ?? badge);
  const shapes = ready
    ? reviewShapes(
        arrowMoves,
        { actual: true, bot: true, objective: true, stockfish: true, next: true },
        badges,
        state.arrows,
      )
    : [];
  const brushes = useMemo(() => buildReviewBrushes(state.arrows), [state.arrows]);
  const boardResetKey = JSON.stringify([
    'analysis',
    state.play.id,
    state.play.moves.length,
    state.analysis.index,
    state.analysisSourceId,
    orientation,
  ]);
  const insightResetKey = JSON.stringify([
    state.analysis.initialFen,
    state.analysis.moves,
    state.analysisSourceId,
  ]);
  // Same prefix-table treatment as the play room: one O(line) build per
  // line, O(1) per scrub render instead of an O(ply) replay.
  const analysisCapturePrefix = useMemo(
    () => buildCapturePrefix(review.timeline.initialFen, review.timeline.moves),
    [review.timeline],
  );
  const analysisCaptures = captureAt(analysisCapturePrefix, ply);
  const analysisDiff = materialAt(review.timeline, ply).diff;
  // Identity for the player strips: the signed-in display name, falling
  // back to 'You' before login and in unit tests (same as the play room).
  const you = accountDisplayName(useAccountName());
  // Reviewed-game identity for the strips: your name + Elo on your color,
  // the opponent's name + Elo on the other. Imported PGNs carry their own
  // roster in the White/Black (/WhiteElo/BlackElo) headers. Ad-hoc lines
  // with neither (FEN/start, bare movetext) fall back to the color names.
  const sourceGame = state.analysis.ownGame
    ? state.analysisSourceId
      ? (state.saved.find(game => game.id === state.analysisSourceId) ??
        (state.play.id === state.analysisSourceId ? state.play : null))
      : null
    : null;
  const pgnName = (player: LinePlayer) =>
    player.elo === undefined ? player.name : `${player.name} (${player.elo})`;
  const pgnPlayers = state.analysis.players;
  const analysisNames: Record<'white' | 'black', string> | null = sourceGame
    ? (() => {
        const userLabel = `${you} (${sourceGame.settings.userElo})`;
        // Absent source means a local game (pre-strict rows omit it the
        // same way); either way the fallback name is derived, never blank.
        const gameSource = sourceGame.source === undefined ? null : sourceGame.source;
        const raw =
          sourceGame.opponent ||
          (gameSource !== null && gameSource.startsWith('lichess:') ? 'Lichess' : 'Maia');
        const oppLabel = raw.startsWith('Maia ') ? raw : `${raw} (${sourceGame.settings.botElo})`;
        return sourceGame.settings.userColor === 'white'
          ? { white: userLabel, black: oppLabel }
          : { white: oppLabel, black: userLabel };
      })()
    : pgnPlayers
      ? { white: pgnName(pgnPlayers.white), black: pgnName(pgnPlayers.black) }
      : null;
  const strip = (color: 'white' | 'black') => {
    const shownOver = viewedOver;
    const active = position.turn === color && !shownOver;
    const isActive = active && ready;
    const label = analysisNames === null ? sideName(color) : analysisNames[color];
    // Remaining time at the viewed ply for reviewed imports (ad-hoc lines
    // and local games carry no readings, so the span stays unmounted there).
    const left = remainingAt(sourceGame ?? state.play, ply, color);
    return (
      <div
        className={`player-strip${isActive ? ' active' : ''}`}
        aria-label={`${sideName(color)}: ${label}${isActive ? ', to move' : ''}`}
      >
        <span className="player-identity">
          <span className={`side-dot ${color}`} aria-hidden="true" />
          <strong>{label}</strong>
        </span>
        <MaterialSummary
          by={color}
          captures={analysisCaptures[color]}
          lead={materialLeadFor(analysisDiff, color)}
        />
        {left !== undefined && (
          <span className={`clock-remaining${left < LOW_TIME_CENTISECONDS ? ' clock-low' : ''}`}>
            {formatClock(left)}
          </span>
        )}
      </div>
    );
  };
  const mobileBar = useMobileBar();
  return (
    <>
      <div className={`workspace${ready ? ' analyzing' : ''}${!ready ? ' awaiting' : ''}`}>
        <RegionRecorder id="board-stage">
          <BoardShell
            state={state}
            dispatch={dispatch}
            ready={ready}
            toolbar={null}
            position={position}
            transition={{ line: insightResetKey, ply }}
            orientation={orientation}
            enabled={enabled}
            over={false}
            withEvaluation={ready}
            boardResetKey={boardResetKey}
            shapes={shapes}
            brushes={brushes}
            evalBar={
              ready ? (
                <>
                  <div className="eval-slot eval-slot-left">
                    <ObjectiveBar
                      key={`${insightResetKey}|wdl|${review.tooLong ? 1 : 0}`}
                      label="Bot evaluation"
                      turn={position.turn}
                      expected={barPoint === null ? null : barPoint.expected}
                      wdl={barPoint === null ? null : (barPoint.wdl ?? null)}
                      mate={
                        review.current !== null && review.current.score.type === 'mate'
                          ? review.current.score
                          : null
                      }
                      outcome={position.outcome}
                      orientation={orientation}
                      failed={review.objectiveError(position).state === 'failed'}
                    />
                  </div>
                  <div className="eval-slot eval-slot-right">
                    <ObjectiveBar
                      key={`${insightResetKey}|sf|${review.tooLong ? 1 : 0}`}
                      label="Stockfish evaluation"
                      turn={position.turn}
                      score={review.current === null ? null : review.current.score}
                      mate={
                        review.current !== null && review.current.score.type === 'mate'
                          ? review.current.score
                          : null
                      }
                      outcome={position.outcome}
                      orientation={orientation}
                      failed={review.currentError !== null}
                    />
                  </div>
                </>
              ) : null
            }
            renderStrip={strip}
            movesPanel={
              ready ? (
                <MovesPanel
                  sans={full.sanMoves}
                  ply={ply}
                  initialFen={state.analysis.initialFen}
                  qualities={review.qualities}
                  badgeLoading={state.badgeLoading}
                  onView={ply => dispatch({ type: 'view', ply })}
                  onOriginalView={ply => {
                    dispatch({ type: 'original' });
                    dispatch({ type: 'view', ply });
                  }}
                  onAdvance={() => dispatch({ type: 'advance' })}
                  analysis={true}
                  original={
                    state.analysis.branchFromPly !== null
                      ? {
                          sans: state.analysis.sanMoves,
                          fromPly: state.analysis.branchFromPly,
                          qualities: review.mainlineQualities,
                          bookFlags: mainlineBookFlags,
                        }
                      : undefined
                  }
                  branchUp={mobileBar}
                  hideNav={mobileBar}
                  bookFlags={analysisBookFlags}
                />
              ) : null
            }
            resultOverlay={null}
          />
        </RegionRecorder>
        {ready && (
          <ErrorBoundary
            label="insight"
            resetKey={insightResetKey}
            renderFallback={(error, retry) => (
              <PanelError
                id="insight-error"
                title="Analysis failed to render"
                message={error.message || 'Unknown rendering error.'}
                onRetry={retry}
              />
            )}
          >
            <RegionRecorder id="insight-panel">
              <InsightPanel key={insightResetKey} state={state} dispatch={dispatch} review={review}>
                <AnalysisActions state={state} dispatch={dispatch} />
              </InsightPanel>
            </RegionRecorder>
          </ErrorBoundary>
        )}
      </div>
      {ready && (
        <RegionRecorder id="chrome">
          <>
            <PlayControls state={state} dispatch={dispatch} />
            <AnalysisControls state={state} dispatch={dispatch} />
          </>
        </RegionRecorder>
      )}
    </>
  );
}
