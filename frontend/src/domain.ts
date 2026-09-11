import { Chess, type Square } from 'chess.js';
import type { Key } from '@lichess-org/chessground/types';
import type { MaiaColor, MaiaModel, MoveResponse } from './api';

export const START_FEN = new Chess().fen();
export type Mode = 'play' | 'analysis' | 'history' | 'settings';
export type Settings = { userColor: MaiaColor; eloMaia: number; eloUser: number; model: MaiaModel; temperature?: number };
export type Position = { fen: string; moves: string[]; sanMoves: string[]; lastMove?: [Key, Key] };
export type Analysis = { initialFen: string; moves: string[]; sanMoves: string[]; timeline: Position[]; index: number; branchFromPly: number | null; branchMoves: string[]; perspective: MaiaColor; ownGame: boolean };
export type Insight = { response: MoveResponse; fen: string; mode: Mode };
export type StoredGame = { id: string; createdAt: string; moves: string[]; settings: Settings };
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
  const timeline = [positionOf(game)];
  moves.forEach(move => { applyUci(game, move); timeline.push(positionOf(game)); });
  return { initialFen, moves, sanMoves: game.history(), timeline, index: moves.length, branchFromPly: null, branchMoves: [],
    perspective: new Chess(initialFen).turn() === 'w' ? 'white' : 'black', ownGame: false };
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
// score_moves evaluates _history_after_move, then invert_wdl restores the choosing side.
// https://github.com/CSSLab/maia3/blob/1e13597c42d4858b7cfd7cfdae01e297263364b2/maia3/uci.py
export function absoluteWdl(fen: string, wdl: MoveResponse['wdl']) {
  const [loss, draw, win] = wdl;
  return new Chess(fen).turn() === 'w' ? [win, draw, loss] : [loss, draw, win];
}
