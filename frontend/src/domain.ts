import { Chess, type Square } from 'chess.js';
import type { Key } from '@lichess-org/chessground/types';
import type { MaiaColor, MaiaModel, MoveResponse } from './api';
import { terminalEvaluation, type Evaluation } from './reviewMetrics';

export const START_FEN = new Chess().fen();
export type Mode = 'play' | 'analysis' | 'history' | 'settings';
export type Settings = { userColor: MaiaColor; eloMaia: number; eloUser: number; model: MaiaModel; temperature?: number };
export type Position = { fen: string; moves: string[]; sanMoves: string[]; lastMove?: [Key, Key] };
export type Analysis = { initialFen: string; moves: string[]; sanMoves: string[]; index: number; branchFromPly: number | null; branchMoves: string[]; perspective: MaiaColor; ownGame: boolean };
export type Insight = { response: MoveResponse; fen: string; mode: Mode };
export type StoredGame = { id: string; createdAt: string; moves: string[]; settings: Settings; result?: 'resigned' };
export const defaultSettings: Settings = { userColor: 'white', eloMaia: 1600, eloUser: 1600, model: '79m', temperature: 1 };
export const oppositeColor = (color: MaiaColor): MaiaColor => color === 'white' ? 'black' : 'white';
export const sideName = (color: MaiaColor) => color === 'white' ? 'White' : 'Black';
export const newId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function normalizeSettings(stored?: Partial<Settings> | null): Settings {
  const elo = (value: unknown, fallback: number) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5000 ? value : fallback;
  return { userColor: stored?.userColor === 'black' ? 'black' : 'white', model: stored?.model === '5m' ? '5m' : '79m',
    eloMaia: elo(stored?.eloMaia, 1600), eloUser: elo(stored?.eloUser, elo(stored?.eloMaia, 1600)),
    temperature: typeof stored?.temperature === 'number' && Number.isFinite(stored.temperature) && stored.temperature >= 0 && stored.temperature <= 2 ? stored.temperature : 0 };
}

export function applyUci(game: Chess, uci: string) {
  return game.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, ...(uci[4] ? { promotion: uci[4] } : {}) });
}
export function uciFromMove(move: { from: string; to: string; promotion?: string }) {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}
export function replay(moves: string[], initialFen = START_FEN): Chess {
  const game = new Chess(initialFen);
  moves.forEach(move => applyUci(game, move));
  return game;
}
export function positionOf(game: Chess): Position {
  const history = game.history({ verbose: true });
  const last = history.at(-1);
  return { fen: game.fen(), moves: history.map(uciFromMove), sanMoves: game.history(), lastMove: last ? [last.from, last.to] : undefined };
}
export function legalDests(game: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>();
  for (const move of game.moves({ verbose: true })) {
    const options = dests.get(move.from) ?? [];
    if (!options.includes(move.to)) options.push(move.to);
    dests.set(move.from, options);
  }
  return dests;
}
export function parsePgnMoves(pgn: string, game: Chess): string[] {
  let text = pgn.replace(/^\uFEFF/, '').replace(/\[[^\]]*\]/g, '');
  text = text.replace(/\{[^}]*\}/g, '').replace(/;[^\n]*/g, '');
  while (/\([^()]*\)/.test(text)) text = text.replace(/\([^()]*\)/g, '');
  const moves: string[] = [];
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^\d+\.(\.\.)?/, '');
    if (!token || token === '...' || /^\d+\.{1,3}$/.test(token) || /^(1-0|0-1|1\/2-1\/2|\*)$/.test(token) || /^\$\d+$/.test(token)) continue;
    try { moves.push(uciFromMove(/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token) ? applyUci(game, token) : game.move(token))); }
    catch { throw new Error(`Could not read PGN move "${token}".`); }
  }
  return moves;
}
export function loadLine(fen = '', pgn = ''): Analysis {
  // Explicit FEN wins; otherwise honor the starting position in an exported PGN.
  const initialFen = new Chess(fen.trim() || pgn.match(/\[FEN\s+"([^"]+)"\]/i)?.[1] || START_FEN).fen();
  const moves = parsePgnMoves(pgn, new Chess(initialFen));
  const game = new Chess(initialFen);
  moves.forEach(move => applyUci(game, move));
  return { initialFen, moves, sanMoves: game.history(), index: moves.length, branchFromPly: null, branchMoves: [],
    perspective: new Chess(initialFen).turn() === 'w' ? 'white' : 'black', ownGame: false };
}
// Test helper: per-ply review nodes for a line. Production builds these
// incrementally where needed (useReview) instead of paying for an eager
// per-ply timeline on every load.
export function testNodes(initialFen: string, moves: string[]): { initialFen: string; moves: string[]; fen: string }[] {
  const game = new Chess(initialFen);
  const nodes = [{ initialFen, moves: [] as string[], fen: game.fen() }];
  moves.forEach((move, index) => {
    applyUci(game, move);
    nodes.push({ initialFen, moves: moves.slice(0, index + 1), fen: game.fen() });
  });
  return nodes;
}
export function exportLine(analysis: Analysis): string {
  const game = replay(analysis.moves, analysis.initialFen);
  game.header('Event', 'Maia Board');
  if (analysis.initialFen !== START_FEN) game.header('SetUp', '1', 'FEN', analysis.initialFen);
  return game.pgn();
}
export function candidateSan(fen: string, uci: string): string {
  try { return applyUci(new Chess(fen), uci).san; } catch { return uci; }
}

// One replay owns the displayed position and the API's history, including custom starts.
export function analysisLine(analysis: Analysis, at = analysis.index): Position & { initialFen: string } {
  const initialFen = new Chess(analysis.initialFen).fen();
  const moves = analysis.branchFromPly === null ? analysis.moves : [...analysis.moves.slice(0, analysis.branchFromPly), ...analysis.branchMoves];
  return { ...positionOf(replay(moves.slice(0, at), initialFen)), initialFen };
}
export function analysisLength(analysis: Analysis): number {
  return analysis.branchFromPly === null ? analysis.moves.length : analysis.branchFromPly + analysis.branchMoves.length;
}
export function exportExplored(analysis: Analysis): string {
  return exportLine({ ...analysis, moves: analysisLine(analysis, analysisLength(analysis)).moves });
}
export function gameResult(game: Chess): string {
  return game.isCheckmate() ? (game.turn() === 'w' ? 'Black wins' : 'White wins') : game.isDraw() ? 'Draw' : 'Unfinished';
}
export function isResigned(game: Pick<StoredGame, 'result'>): boolean {
  return game.result === 'resigned';
}
// History and game-over banners share one reading: a resignation outranks the
// board, which stays replayable underneath.
export function storedGameResult(game: StoredGame): string {
  if (isResigned(game)) return `${sideName(oppositeColor(game.settings.userColor))} wins · resignation`;
  return gameResult(replay(game.moves));
}
// score_moves evaluates _history_after_move, then invert_wdl restores the choosing side.
// https://github.com/CSSLab/maia3/blob/1e13597c42d4858b7cfd7cfdae01e297263364b2/maia3/uci.py
export function absoluteWdl(fen: string, wdl: MoveResponse['wdl']) {
  const [loss, draw, win] = wdl;
  return new Chess(fen).turn() === 'w' ? [win, draw, loss] : [loss, draw, win];
}

// Memoized per-line derivation for the play path. State stores only UCI move
// lists, and every consumer used to re-derive fen/SAN/turn/game-over from move
// 0 independently (~6 full-line replays per commit, ~260 across the
// feedback-queue rebuild on a 130-ply game). One cache entry per distinct line
// holds everything a replay computes: each tip-advance costs exactly one replay
// (the genuinely new tip, whose history-aware terminality needs full history —
// threefold repetition is unknowable from a FEN), and every re-derivation of a
// known line (guards, renders, queue rebuilds, takebacks) is a Map hit.
//
// The incremental commit path must never call positionOf() on a FEN-parsed
// game: chess.js history starts empty on FEN load, so SAN/history would cover
// only the applied move. Commits therefore probe legality on a single parse
// and read the full derivation back from the memo.
export type LineRecord = Position & { terminal: Evaluation | null };

type LineEntry = {
  fen: string;
  sanMoves: string[];
  lastMove: [Key, Key] | undefined;
  // Always resolved at write time: null = ongoing. There is no "pending"
  // state — an unknown terminal would be indistinguishable from an ongoing
  // position (terminalEvaluation returns undefined for those), silently
  // disabling the memo.
  terminal: Evaluation | null;
  plies: number;
};

// Retention: tip-most entries plus the root. Commits need the tip, takebacks
// the tip-1/tip-2 prefixes, renders the current line; deep history navigation
// outside the window correctly degrades to one replay.
const LINE_CACHE_MAX = 64;
const lineCache = new Map<string, LineEntry>();

// Test observability only: counts full-line replays (computeEntry misses plus
// terminal resolutions). Lets the suite assert the per-commit replay bound.
// Reset per test; read-only in production.
let lineRecordMisses = 0;
export function lineRecordMissesForTests(): number { return lineRecordMisses; }
export function resetLineRecordsForTests(): void { lineCache.clear(); lineRecordMisses = 0; }

function lineCacheKey(moves: string[], initialFen: string): string {
  return JSON.stringify([new Chess(initialFen).fen(), moves]);
}

function touchLineEntry(key: string, entry: LineEntry): void {
  lineCache.delete(key);
  lineCache.set(key, entry);
  if (lineCache.size > LINE_CACHE_MAX) {
    for (const oldest of lineCache.keys()) {
      const candidate = lineCache.get(oldest);
      if (candidate && candidate.plies > 0) { lineCache.delete(oldest); break; }
    }
    if (lineCache.size > LINE_CACHE_MAX) lineCache.delete(lineCache.keys().next().value!);
  }
}

function computeLineEntry(moves: string[], initialFen: string): LineEntry {
  lineRecordMisses++;
  const game = replay(moves, initialFen);
  const position = positionOf(game);
  return { fen: position.fen, sanMoves: position.sanMoves, lastMove: position.lastMove, terminal: terminalEvaluation(game) ?? null, plies: moves.length };
}

function freshLineRecord(moves: string[], entry: LineEntry): LineRecord {
  // Copy-on-return: cached arrays are never shared out, so no caller can
  // poison the cache (or a sibling state version) by mutation. `moves` is the
  // caller's own array and needs no copy.
  return { fen: entry.fen, moves, sanMoves: [...entry.sanMoves],
    lastMove: entry.lastMove ? [...entry.lastMove] as [Key, Key] : undefined,
    terminal: entry.terminal ?? null };
}

export function lineRecord(moves: string[], initialFen = START_FEN): LineRecord {
  const key = lineCacheKey(moves, initialFen);
  let entry = lineCache.get(key);
  if (!entry) {
    entry = computeLineEntry(moves, initialFen);
    touchLineEntry(key, entry);
  } else {
    touchLineEntry(key, entry);
  }
  return freshLineRecord(moves, entry);
}

// Commit step: legality probe on a single parse (throws on illegal moves like
// game.move), canonical UCI from the applied move, and the full derivation
// back from the shared memo — exactly one replay per genuinely new tip, zero
// for the base or any re-derivation.
export function extendLine(moves: string[], initialFen: string, from: Square, to: Square, promotion?: string): { moves: string[]; record: LineRecord } {
  const probe = new Chess(lineRecord(moves, initialFen).fen);
  const applied = probe.move({ from, to, ...(promotion ? { promotion } : {}) });
  const nextMoves = [...moves, uciFromMove({ from: applied.from, to: applied.to, promotion: applied.promotion })];
  return { moves: nextMoves, record: lineRecord(nextMoves, initialFen) };
}

// Takebacks address the tip-1/tip-2 prefixes, which retention keeps: normally a
// hit, degrading to one replay after eviction or on a cold cache.
export function retreatLine(moves: string[], initialFen: string, plies: number): { moves: string[]; record: LineRecord } {
  const prefix = moves.slice(0, Math.max(0, moves.length - plies));
  return { moves: prefix, record: lineRecord(prefix, initialFen) };
}

// Result text without a replay: checkmate is position-only (safe from a
// FEN parse); draw-vs-unfinished is history-aware and comes solely from the
// memoized terminal — never from a FEN-parsed isDraw()/isGameOver(), which
// miss threefold repetition. Mirrors gameResult() exactly.
export function resultTextForTip(tipFen: string, terminal: Evaluation | null): string {
  const game = new Chess(tipFen);
  if (game.isCheckmate()) return game.turn() === 'w' ? 'Black wins' : 'White wins';
  return terminal ? 'Draw' : 'Unfinished';
}
