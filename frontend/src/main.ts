import { Chess, type Square } from 'chess.js';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Color, Key } from '@lichess-org/chessground/types';
import '@lichess-org/chessground/assets/chessground.base.css';
import '@lichess-org/chessground/assets/chessground.brown.css';
import '@lichess-org/chessground/assets/chessground.cburnett.css';
import './styles.css';
import { toGroundColor, type ChessColor } from './board-colors';
import {
  MaiaApiError,
  type MaiaColor,
  type MaiaModel,
  type MoveResponse,
  readableApiError,
  requestMove,
} from './api';

const START_FEN = new Chess().fen();
const SETTINGS_KEY = 'maia-board.settings.v1';
const CURRENT_GAME_KEY = 'maia-board.current-game.v1';
const SAVED_GAMES_KEY = 'maia-board.saved-games.v1';
const ANALYSIS_KEY = 'maia-board.analysis.v1';

type Mode = 'play' | 'analysis';
type UserColor = MaiaColor;
type Settings = {
  userColor: UserColor;
  eloMaia: number;
  eloUser: number;
  model: MaiaModel;
};

type Position = {
  fen: string;
  moves: string[];
  sanMoves: string[];
  lastMove?: [string, string];
};

type AnalysisState = {
  initialFen: string;
  moves: string[];
  sanMoves: string[];
  timeline: Position[];
  index: number;
};

type Insight = {
  response: MoveResponse;
  fen: string;
  mode: Mode;
};

type StoredGame = {
  id: string;
  createdAt: string;
  moves: string[];
  settings: Settings;
};

const defaultSettings: Settings = {
  userColor: 'white',
  eloMaia: 1600,
  eloUser: 1400,
  model: '79m',
};

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const boardElement = byId<HTMLDivElement>('board');
const modePlayButton = byId<HTMLButtonElement>('mode-play');
const modeAnalysisButton = byId<HTMLButtonElement>('mode-analysis');
const playControls = byId<HTMLElement>('play-controls');
const analysisControls = byId<HTMLElement>('analysis-controls');
const stageEyebrow = byId<HTMLElement>('stage-eyebrow');
const stageTitle = byId<HTMLElement>('stage-title');
const turnChip = byId<HTMLElement>('turn-chip');
const boardStatus = byId<HTMLElement>('board-status');
const errorBanner = byId<HTMLElement>('error-banner');
const connectionState = byId<HTMLElement>('connection-state');
const connectionLabel = byId<HTMLElement>('connection-label');
const maiaColorLabel = byId<HTMLElement>('maia-color-label');
const eloMaiaInput = byId<HTMLSelectElement>('elo-maia');
const eloUserInput = byId<HTMLSelectElement>('elo-user');
const analysisFenInput = byId<HTMLInputElement>('analysis-fen');
const analysisPgnInput = byId<HTMLTextAreaElement>('analysis-pgn');
const loadAnalysisButton = byId<HTMLButtonElement>('load-analysis');
const analyzePositionButton = byId<HTMLButtonElement>('analyze-position');
const exportPgnButton = byId<HTMLButtonElement>('export-pgn');
const analysisPrevButton = byId<HTMLButtonElement>('analysis-prev');
const analysisNextButton = byId<HTMLButtonElement>('analysis-next');
const analysisIndexLabel = byId<HTMLElement>('analysis-index');
const insightEyebrow = byId<HTMLElement>('insight-eyebrow');
const insightTitle = byId<HTMLElement>('insight-title');
const insightContent = byId<HTMLElement>('insight-content');
const modelBadge = byId<HTMLElement>('model-badge');
const moveList = byId<HTMLElement>('move-list');
const moveCount = byId<HTMLElement>('move-count');
const savedGames = byId<HTMLElement>('saved-games');
const promotionDialog = byId<HTMLDialogElement>('promotion-dialog');

let mode: Mode = 'play';
let settings = loadSettings();
let playGame = new Chess();
let playGameId = newId();
let playMoves: string[] = [];
let analysis: AnalysisState = emptyAnalysis();
let insight: Insight | null = null;
let errorMessage = '';
let requestPending = false;
let requestSequence = 0;
let boardFlipped = false;
let pendingPromotion: { from: Square; to: Square } | null = null;

const ground: Api = Chessground(boardElement, {
  coordinates: true,
  animation: { enabled: true, duration: 220 },
  movable: { free: false },
  events: {
    move: (from, to) => handleBoardMove(from as Square, to as Square),
  },
});

function loadSettings(): Settings {
  return normalizeSettings(readStorage<Partial<Settings>>(SETTINGS_KEY));
}

function normalizeSettings(stored: Partial<Settings> | undefined): Settings {
  return {
    userColor: stored?.userColor === 'black' ? 'black' : defaultSettings.userColor,
    eloMaia: validElo(stored?.eloMaia) ? stored.eloMaia! : defaultSettings.eloMaia,
    eloUser: validElo(stored?.eloUser) ? stored.eloUser! : defaultSettings.eloUser,
    model: stored?.model === '5m' ? '5m' : defaultSettings.model,
  };
}

function validElo(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5000;
}

function readStorage<T>(key: string): T | undefined {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing and full storage should not block the board.
  }
}

function newId(): string {
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function emptyAnalysis(): AnalysisState {
  return {
    initialFen: START_FEN,
    moves: [],
    sanMoves: [],
    timeline: [{ fen: START_FEN, moves: [], sanMoves: [] }],
    index: 0,
  };
}

function oppositeColor(color: UserColor): UserColor {
  return color === 'white' ? 'black' : 'white';
}

function toChessColor(color: MaiaColor): ChessColor {
  return color === 'white' ? 'w' : 'b';
}

function toMaiaColor(color: ChessColor): MaiaColor {
  return color === 'w' ? 'white' : 'black';
}

function sideName(color: ChessColor): string {
  return color === 'w' ? 'White' : 'Black';
}

function uciFromMove(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

function applyUci(game: Chess, uci: string) {
  const from = uci.slice(0, 2) as Square;
  const to = uci.slice(2, 4) as Square;
  const promotion = uci.slice(4, 5);
  return game.move({ from, to, ...(promotion ? { promotion } : {}) });
}

function historyUci(game: Chess): string[] {
  return game.history({ verbose: true }).map(uciFromMove);
}

function isMaiaTurn(game: Chess): boolean {
  return toMaiaColor(game.turn()) === oppositeColor(settings.userColor);
}

function currentContext(): Position {
  if (mode === 'play') {
    const history = playGame.history({ verbose: true });
    const last = history.at(-1);
    return {
      fen: playGame.fen(),
      moves: playMoves,
      sanMoves: playGame.history(),
      lastMove: last ? [last.from, last.to] : undefined,
    };
  }
  return analysis.timeline[analysis.index];
}

function saveSettings(): void {
  writeStorage(SETTINGS_KEY, settings);
}

function saveCurrentGame(): void {
  if (playMoves.length === 0) {
    writeStorage(CURRENT_GAME_KEY, null);
    return;
  }
  const game: StoredGame = {
    id: playGameId,
    createdAt: new Date().toISOString(),
    moves: playMoves,
    settings: { ...settings },
  };
  writeStorage(CURRENT_GAME_KEY, game);
  const games = readStorage<StoredGame[]>(SAVED_GAMES_KEY) ?? [];
  const next = [game, ...games.filter((item) => item.id !== game.id)].slice(0, 8);
  writeStorage(SAVED_GAMES_KEY, next);
}

function saveAnalysisInputs(): void {
  writeStorage(ANALYSIS_KEY, { fen: analysisFenInput.value, pgn: analysisPgnInput.value });
}

function restoreLocalState(): void {
  const current = readStorage<StoredGame>(CURRENT_GAME_KEY);
  if (current?.moves) {
    try {
      const restored = new Chess();
      current.moves.forEach((move) => applyUci(restored, move));
      settings = normalizeSettings(current.settings);
      saveSettings();
      playGame = restored;
      playMoves = historyUci(restored);
      playGameId = current.id;
    } catch {
      writeStorage(CURRENT_GAME_KEY, null);
    }
  }

  const storedAnalysis = readStorage<{ fen?: string; pgn?: string }>(ANALYSIS_KEY);
  if (storedAnalysis) {
    analysisFenInput.value = storedAnalysis.fen ?? '';
    analysisPgnInput.value = storedAnalysis.pgn ?? '';
    if (analysisFenInput.value.trim() || analysisPgnInput.value.trim()) loadAnalysis(false);
  }
}

function syncSettingsControls(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="user-color"]').forEach((input) => {
    input.checked = input.value === settings.userColor;
  });
  document.querySelectorAll<HTMLInputElement>('input[name="model"]').forEach((input) => {
    input.checked = input.value === settings.model;
  });
  eloMaiaInput.value = String(settings.eloMaia);
  eloUserInput.value = String(settings.eloUser);
  maiaColorLabel.textContent = sideName(toChessColor(oppositeColor(settings.userColor)));
}

function setMode(nextMode: Mode): void {
  if (mode === nextMode) return;
  mode = nextMode;
  requestSequence += 1;
  requestPending = false;
  pendingPromotion = null;
  errorMessage = '';
  if (promotionDialog.open) promotionDialog.close();
  render();
}

function startNewGame(requestEngine = true): void {
  requestSequence += 1;
  requestPending = false;
  pendingPromotion = null;
  if (promotionDialog.open) promotionDialog.close();
  playGame = new Chess();
  playMoves = [];
  playGameId = newId();
  insight = null;
  errorMessage = '';
  writeStorage(CURRENT_GAME_KEY, null);
  render();
  if (requestEngine && mode === 'play' && isMaiaTurn(playGame)) void requestPlayAnalysis();
}

function takeback(): void {
  if (mode !== 'play' || playMoves.length === 0) return;
  requestSequence += 1;
  requestPending = false;
  pendingPromotion = null;
  if (promotionDialog.open) promotionDialog.close();

  const undoCount = playGame.turn() === toChessColor(settings.userColor) ? 2 : 1;
  for (let index = 0; index < undoCount; index += 1) playGame.undo();
  playMoves = historyUci(playGame);
  insight = null;
  errorMessage = '';
  saveCurrentGame();
  render();
  if (isMaiaTurn(playGame)) void requestPlayAnalysis();
}

function handleBoardMove(from: Square, to: Square): void {
  if (mode !== 'play' || requestPending || playGame.turn() !== toChessColor(settings.userColor)) {
    renderBoard();
    return;
  }
  const piece = playGame.get(from);
  const promotionRank = to[1] === '1' || to[1] === '8';
  if (piece?.type === 'p' && promotionRank) {
    pendingPromotion = { from, to };
    renderBoard();
    promotionDialog.showModal();
    return;
  }
  commitUserMove(from, to);
}

function commitUserMove(from: Square, to: Square, promotion?: string): void {
  try {
    playGame.move({ from, to, ...(promotion ? { promotion } : {}) });
  } catch {
    errorMessage = 'That move is not legal in this position.';
    render();
    return;
  }
  pendingPromotion = null;
  if (promotionDialog.open) promotionDialog.close();
  playMoves = historyUci(playGame);
  insight = null;
  errorMessage = '';
  saveCurrentGame();
  render();
  if (!playGame.isGameOver() && isMaiaTurn(playGame)) void requestPlayAnalysis();
}

function makeRequestPayload(fen: string, moves: string[], maiaColor: MaiaColor, initialFen?: string) {
  return {
    fen,
    moves,
    elo_maia: settings.eloMaia,
    elo_user: settings.eloUser,
    model: settings.model,
    maia_color: maiaColor,
    ...(initialFen && initialFen !== START_FEN ? { initial_fen: initialFen } : {}),
  } as const;
}

async function requestPlayAnalysis(): Promise<void> {
  if (mode !== 'play' || requestPending || !isMaiaTurn(playGame) || playGame.isGameOver()) return;
  const sequence = ++requestSequence;
  const fen = playGame.fen();
  const moves = [...playMoves];
  const maiaColor = toMaiaColor(playGame.turn());
  requestPending = true;
  errorMessage = '';
  render();

  try {
    const response = await requestMove(makeRequestPayload(fen, moves, maiaColor));
    if (sequence !== requestSequence || mode !== 'play' || playGame.fen() !== fen) return;
    const candidate = new Chess(fen);
    const move = applyUci(candidate, response.move);
    if (!move) throw new MaiaApiError('unknown', 'Maia returned an illegal move.');
    applyUci(playGame, response.move);
    playMoves = historyUci(playGame);
    insight = { response, fen, mode: 'play' };
    requestPending = false;
    saveCurrentGame();
    render();
  } catch (error: unknown) {
    if (sequence !== requestSequence) return;
    requestPending = false;
    errorMessage = readableApiError(error);
    render();
  }
}

async function requestAnalysis(): Promise<void> {
  if (mode !== 'analysis' || requestPending) return;
  const position = currentContext();
  const sequence = ++requestSequence;
  const maiaColor = toMaiaColor(new Chess(position.fen).turn());
  requestPending = true;
  errorMessage = '';
  render();

  try {
    const response = await requestMove(makeRequestPayload(position.fen, position.moves, maiaColor, analysis.initialFen));
    if (sequence !== requestSequence || mode !== 'analysis' || analysis.timeline[analysis.index].fen !== position.fen) return;
    insight = { response, fen: position.fen, mode: 'analysis' };
    requestPending = false;
    render();
  } catch (error: unknown) {
    if (sequence !== requestSequence) return;
    requestPending = false;
    errorMessage = readableApiError(error);
    render();
  }
}

function parsePgnMoves(pgn: string, game: Chess): { moves: string[]; sanMoves: string[] } {
  let text = pgn.replace(/^\uFEFF/, '').replace(/\[[^\]]*\]/g, '');
  text = text.replace(/\{[^}]*\}/g, '').replace(/;[^\n]*/g, '');
  while (/\([^()]*\)/.test(text)) text = text.replace(/\([^()]*\)/g, '');

  const moves: string[] = [];
  const sanMoves: string[] = [];
  for (const rawToken of text.split(/\s+/)) {
    if (!rawToken) continue;
    const token = rawToken.replace(/^\d+\.(\.\.)?/, '');
    if (!token || /^\d+\.{1,3}$/.test(token) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(token)) continue;
    try {
      const move = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token) ? applyUci(game, token) : game.move(token);
      if (!move) throw new Error('illegal move');
      moves.push(uciFromMove(move));
      sanMoves.push(move.san);
    } catch {
      throw new Error(`Could not read PGN move "${token}".`);
    }
  }
  return { moves, sanMoves };
}

function buildTimeline(initialFen: string, moves: string[]): Position[] {
  const game = new Chess(initialFen);
  const timeline: Position[] = [{ fen: game.fen(), moves: [], sanMoves: [] }];
  const sanMoves: string[] = [];
  for (const uci of moves) {
    const move = applyUci(game, uci);
    if (!move) throw new Error('The move history does not match the position.');
    sanMoves.push(move.san);
    timeline.push({
      fen: game.fen(),
      moves: moves.slice(0, timeline.length),
      sanMoves: [...sanMoves],
      lastMove: [move.from, move.to],
    });
  }
  return timeline;
}

function loadAnalysis(showErrors = true): void {
  requestSequence += 1;
  requestPending = false;
  insight = null;
  const rawFen = analysisFenInput.value.trim() || START_FEN;
  try {
    const base = new Chess(rawFen);
    const parsedGame = new Chess(base.fen());
    const parsed = parsePgnMoves(analysisPgnInput.value.trim(), parsedGame);
    analysis = {
      initialFen: base.fen(),
      moves: parsed.moves,
      sanMoves: parsed.sanMoves,
      timeline: buildTimeline(base.fen(), parsed.moves),
      index: parsed.moves.length,
    };
    errorMessage = '';
    saveAnalysisInputs();
  } catch (error: unknown) {
    if (showErrors) errorMessage = error instanceof Error ? error.message : 'Could not load this position.';
  }
  render();
}

function stepAnalysis(delta: number): void {
  const nextIndex = Math.max(0, Math.min(analysis.timeline.length - 1, analysis.index + delta));
  if (nextIndex === analysis.index) return;
  requestSequence += 1;
  requestPending = false;
  analysis.index = nextIndex;
  insight = null;
  errorMessage = '';
  render();
}

function exportPgn(): void {
  try {
    const game = new Chess(analysis.initialFen);
    game.header('Event', 'Maia Board');
    if (analysis.initialFen !== START_FEN) {
      game.header('SetUp', '1');
      game.header('FEN', analysis.initialFen);
    }
    analysis.moves.forEach((move) => applyUci(game, move));
    const blob = new Blob([game.pgn()], { type: 'application/x-chess-pgn' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'maia-analysis.pgn';
    link.click();
    URL.revokeObjectURL(url);
  } catch {
    errorMessage = 'This line could not be exported as PGN.';
    render();
  }
}

function flipBoard(): void {
  boardFlipped = !boardFlipped;
  renderBoard();
}

function boardOrientation(): Color {
  const defaultColor = mode === 'play' ? settings.userColor : 'white';
  return (boardFlipped ? oppositeColor(defaultColor) : defaultColor) as Color;
}

function legalDests(game: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  game.moves({ verbose: true }).forEach((move) => {
    const from = move.from as Key;
    const to = move.to as Key;
    const options = dests.get(from) ?? [];
    options.push(to);
    dests.set(from, options);
  });
  return dests;
}

function renderBoard(): void {
  const position = currentContext();
  const game = new Chess(position.fen);
  const userTurn = mode === 'play' && game.turn() === toChessColor(settings.userColor) && !requestPending && !pendingPromotion;
  ground.set({
    fen: position.fen,
    orientation: boardOrientation(),
    turnColor: toGroundColor(game.turn()),
    lastMove: position.lastMove as [Key, Key] | undefined,
    viewOnly: mode === 'analysis',
    movable: {
      free: false,
      color: userTurn ? toGroundColor(game.turn()) : undefined,
      dests: userTurn ? legalDests(game) : new Map(),
      showDests: true,
    },
  });
  boardElement.classList.toggle('is-thinking', requestPending);
}

function renderHeader(): void {
  const position = currentContext();
  const game = new Chess(position.fen);
  const side = sideName(game.turn());
  const userTurn = mode === 'play' && game.turn() === toChessColor(settings.userColor);
  stageEyebrow.textContent = mode === 'play' ? 'Live game / Maia3' : 'Position lab / Maia3';
  stageTitle.textContent = mode === 'play'
    ? requestPending ? 'Maia is choosing.' : userTurn ? 'Your move.' : game.isGameOver() ? 'Game over.' : 'The line continues.'
    : 'Read the position.';
  turnChip.textContent = `${side} to move`;
  if (errorMessage) {
    boardStatus.textContent = errorMessage;
  } else if (requestPending) {
    boardStatus.textContent = 'Maia is reading the position...';
  } else if (mode === 'play' && game.isGameOver()) {
    boardStatus.textContent = 'No legal moves remain in this game.';
  } else if (mode === 'play' && userTurn) {
    boardStatus.textContent = 'Your move. Maia will answer on its turn.';
  } else if (mode === 'analysis') {
    boardStatus.textContent = 'Step through the line, then ask Maia for its read.';
  } else {
    boardStatus.textContent = 'Maia is ready for the next position.';
  }
  errorBanner.hidden = !errorMessage;
  errorBanner.textContent = errorMessage;
  connectionState.classList.toggle('is-thinking', requestPending);
  connectionState.classList.toggle('is-error', Boolean(errorMessage));
  connectionLabel.textContent = requestPending ? 'Thinking' : errorMessage ? 'Check server' : 'Ready';
  modePlayButton.classList.toggle('is-active', mode === 'play');
  modeAnalysisButton.classList.toggle('is-active', mode === 'analysis');
  modePlayButton.setAttribute('aria-pressed', String(mode === 'play'));
  modeAnalysisButton.setAttribute('aria-pressed', String(mode === 'analysis'));
  playControls.hidden = mode !== 'play';
  analysisControls.hidden = mode !== 'analysis';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character);
}

function candidateSan(fen: string, uci: string): string {
  try {
    const game = new Chess(fen);
    return applyUci(game, uci)?.san ?? uci;
  } catch {
    return uci;
  }
}

function renderInsight(): void {
  if (!insight) {
    insightEyebrow.textContent = mode === 'play' ? "Maia's read" : "Maia's read";
    insightTitle.textContent = requestPending ? 'Reading the position' : 'Waiting for a position';
    modelBadge.textContent = requestPending ? settings.model : '--';
    insightContent.innerHTML = `<p class="empty-copy">${requestPending ? "The response will include Maia's top five and its win/draw/loss read." : "Make a move or load a position. Maia's top five and its win/draw/loss read will land here."}</p>`;
    return;
  }
  const { response, fen } = insight;
  insightTitle.textContent = insight.mode === 'play' ? `Played ${candidateSan(fen, response.move)}` : 'Top human moves';
  modelBadge.textContent = response.degraded ? `${response.model_used} / fallback` : response.model_used;
  const labels = ['loss', 'draw', 'win'];
  const wdl = response.wdl.map((value) => Math.max(0, Math.min(1, value)));
  const wdlMarkup = labels.map((label, index) => `<div class="wdl-row"><span>${label}</span><div class="wdl-track"><span class="wdl-fill wdl-${label}" style="width:${Math.round(wdl[index] * 100)}%"></span></div><strong>${Math.round(wdl[index] * 100)}%</strong></div>`).join('');
  const candidates = response.top_moves.slice(0, 5).map((candidate, index) => `<li><span class="rank">${String(index + 1).padStart(2, '0')}</span><span class="candidate-move">${escapeHtml(candidateSan(fen, candidate.move))}<small>${escapeHtml(candidate.move)}</small></span><span class="candidate-prob">${Math.round(candidate.prob * 100)}%</span></li>`).join('');
  insightContent.innerHTML = `<div class="read-label">Policy candidates</div><ol class="candidate-list">${candidates || '<li class="empty-copy">No alternatives returned.</li>'}</ol><div class="read-divider"></div><div class="read-label">After Maia's first choice <span>W / D / L</span></div><div class="wdl-list">${wdlMarkup}</div>${response.degraded ? '<p class="degraded-note">79M was unavailable. This answer came from the 5M fallback.</p>' : ''}`;
}

function renderMoves(): void {
  const sans = mode === 'play' ? playGame.history() : analysis.sanMoves;
  const activeIndex = mode === 'analysis' ? analysis.index - 1 : -1;
  moveCount.textContent = `${sans.length} ${sans.length === 1 ? 'ply' : 'plies'}`;
  if (!sans.length) {
    moveList.innerHTML = '<p class="empty-copy">The line is empty.</p>';
    return;
  }
  const rows: string[] = [];
  for (let index = 0; index < sans.length; index += 2) {
    const white = `<span class="move-cell ${activeIndex === index ? 'is-current' : ''}">${escapeHtml(sans[index])}</span>`;
    const black = sans[index + 1] ? `<span class="move-cell ${activeIndex === index + 1 ? 'is-current' : ''}">${escapeHtml(sans[index + 1])}</span>` : '<span class="move-cell empty-cell">-</span>';
    rows.push(`<div class="move-row"><span class="move-number">${index / 2 + 1}.</span>${white}${black}</div>`);
  }
  moveList.innerHTML = rows.join('');
}

function renderSavedGames(): void {
  const games = readStorage<StoredGame[]>(SAVED_GAMES_KEY) ?? [];
  if (!games.length) {
    savedGames.innerHTML = '<p class="empty-copy">Finished or in-progress games appear here.</p>';
    return;
  }
  savedGames.innerHTML = games.map((game) => {
    const date = new Date(game.createdAt);
    const label = `${sideName(toChessColor(game.settings.userColor))} - ${game.settings.model}`;
    return `<button class="saved-game" type="button" data-game-id="${escapeHtml(game.id)}"><span><strong>${escapeHtml(label)}</strong><small>${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} - ${game.moves.length} plies</small></span><span aria-hidden="true">&gt;</span></button>`;
  }).join('');
}

function render(): void {
  syncSettingsControls();
  renderHeader();
  renderBoard();
  renderInsight();
  renderMoves();
  renderSavedGames();
  analysisIndexLabel.textContent = `Position ${analysis.index + 1} / ${analysis.timeline.length}`;
  analysisPrevButton.disabled = analysis.index === 0 || requestPending;
  analysisNextButton.disabled = analysis.index === analysis.timeline.length - 1 || requestPending;
  exportPgnButton.disabled = analysis.moves.length === 0;
  analyzePositionButton.disabled = requestPending;
  byId<HTMLButtonElement>('takeback').disabled = mode !== 'play' || playMoves.length === 0 || requestPending;
}

function loadSavedGame(id: string): void {
  const gameRecord = (readStorage<StoredGame[]>(SAVED_GAMES_KEY) ?? []).find((game) => game.id === id);
  if (!gameRecord) return;
  try {
    const game = new Chess();
    gameRecord.moves.forEach((move) => applyUci(game, move));
    settings = normalizeSettings(gameRecord.settings);
    playGame = game;
    playMoves = historyUci(game);
    playGameId = gameRecord.id;
    mode = 'play';
    insight = null;
    errorMessage = '';
    saveSettings();
    render();
    if (isMaiaTurn(playGame) && !playGame.isGameOver()) void requestPlayAnalysis();
  } catch {
    errorMessage = 'This saved game could not be restored.';
    render();
  }
}

document.querySelectorAll<HTMLButtonElement>('.mode-tab').forEach((button) => {
  button.addEventListener('click', () => setMode(button.id === 'mode-play' ? 'play' : 'analysis'));
});

document.querySelectorAll<HTMLInputElement>('input[name="user-color"]').forEach((input) => {
  input.addEventListener('change', () => {
    settings.userColor = input.value as UserColor;
    saveSettings();
    startNewGame();
  });
});

document.querySelectorAll<HTMLInputElement>('input[name="model"]').forEach((input) => {
  input.addEventListener('change', () => {
    settings.model = input.value as MaiaModel;
    saveSettings();
    render();
  });
});

eloMaiaInput.addEventListener('change', () => {
  settings.eloMaia = Number(eloMaiaInput.value);
  saveSettings();
});

eloUserInput.addEventListener('change', () => {
  settings.eloUser = Number(eloUserInput.value);
  saveSettings();
});

byId<HTMLButtonElement>('new-game').addEventListener('click', () => startNewGame());
byId<HTMLButtonElement>('takeback').addEventListener('click', takeback);
byId<HTMLButtonElement>('flip-board').addEventListener('click', flipBoard);
loadAnalysisButton.addEventListener('click', () => loadAnalysis());
analysisPrevButton.addEventListener('click', () => stepAnalysis(-1));
analysisNextButton.addEventListener('click', () => stepAnalysis(1));
analyzePositionButton.addEventListener('click', () => void requestAnalysis());
exportPgnButton.addEventListener('click', exportPgn);
document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const savedGame = target.closest<HTMLButtonElement>('[data-game-id]');
  if (savedGame?.dataset.gameId) loadSavedGame(savedGame.dataset.gameId);
});

analysisFenInput.addEventListener('input', saveAnalysisInputs);
analysisPgnInput.addEventListener('input', saveAnalysisInputs);

document.querySelectorAll<HTMLButtonElement>('[data-promotion]').forEach((button) => {
  button.addEventListener('click', () => {
    if (!pendingPromotion) return;
    commitUserMove(pendingPromotion.from, pendingPromotion.to, button.dataset.promotion);
  });
});

promotionDialog.addEventListener('cancel', () => {
  pendingPromotion = null;
  render();
});

restoreLocalState();
render();
if (mode === 'play' && isMaiaTurn(playGame) && !playGame.isGameOver()) void requestPlayAnalysis();
