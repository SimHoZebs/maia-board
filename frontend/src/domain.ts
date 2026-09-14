import { Chess, type Square } from 'chess.js';
import type { Key } from '@lichess-org/chessground/types';
import type { MaiaColor, MaiaModel, MoveResponse } from './api';
import type { Evaluation } from './reviewMetrics';
import { outcomeEvaluation } from './outcomeEvaluation';

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
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error(`Invalid UCI move: ${uci}`);
  return game.move({ from: uci.slice(0, 2) as Square, to: uci.slice(2, 4) as Square, ...(uci[4] ? { promotion: uci[4] } : {}) });
}
export function uciFromMove(move: { from: string; to: string; promotion?: string }) {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}
export function replay(moves: string[], initialFen = START_FEN): Chess {
  const key = timelineKey(initialFen, moves);
  const cached = timelineCache.get(key);
  if (!cached) return deriveTimeline(initialFen, moves, key).game;
  // Compatibility callers need a mutable, history-bearing Chess instance.
  // Its reconstruction is one walk; domain facts stay in the cached timeline.
  touchTimeline(key, cached);
  const game = new Chess(cached.initialFen);
  cached.moves.forEach(move => applyUci(game, move));
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
  const timeline = buildTimeline(initialFen, moves);
  return { initialFen, moves, sanMoves: timeline.rows.slice(1).map(row => row.san), index: moves.length, branchFromPly: null, branchMoves: [],
    perspective: timeline.rows[0].turn, ownGame: false };
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
  const timeline = buildTimeline(initialFen, moves);
  const clamped = Math.max(0, Math.min(at, moves.length));
  return {
    fen: timeline.rows[clamped].fen,
    moves: moves.slice(0, clamped),
    sanMoves: timeline.rows.slice(1, clamped + 1).map(row => row.san),
    lastMove: timeline.rows[clamped].lastMove,
    initialFen,
  };
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

// One history-aware walk owns the position facts for every ply.
export type TimelineRow = {
  ply: number;
  uci: string;
  san: string;
  fen: string;
  turn: 'white' | 'black';
  outcome: DomainOutcome | null;
  historyId: number;
  lastMove: [Key, Key] | undefined;
};
export type Timeline = { initialFen: string; moves: string[]; rows: TimelineRow[] };
export type DomainOutcome = { kind: 'checkmate'; winner: MaiaColor } | { kind: 'draw' };
const timelineCache = new Map<string, Timeline>();
const TIMELINE_CACHE_LIMIT = 64;
let nextHistoryId = 0;
const timelineKey = (initialFen: string, moves: string[]) => JSON.stringify([initialFen, moves]);
function touchTimeline(key: string, timeline: Timeline) {
  timelineCache.delete(key); timelineCache.set(key, timeline);
  if (timelineCache.size > TIMELINE_CACHE_LIMIT) timelineCache.delete(timelineCache.keys().next().value!);
}
function outcome(game: Chess): DomainOutcome | null {
  return game.isCheckmate() ? { kind: 'checkmate', winner: game.turn() === 'w' ? 'black' : 'white' }
    : game.isDraw() ? { kind: 'draw' } : null;
}

// Test observability only: counts builder invocations, mirroring
// lineRecordMissesForTests. Lets the suite assert that render loops and
// navigation read rows without rebuilding the timeline.
let timelineBuilds = 0;
export function timelineBuildsForTests(): number { return timelineBuilds; }
export function resetTimelinesForTests(): void { timelineCache.clear(); timelineBuilds = 0; }

export function buildTimeline(initialFen: string, moves: string[]): Timeline {
  const key = timelineKey(initialFen, moves);
  const cached = timelineCache.get(key);
  if (cached) { touchTimeline(key, cached); return cached; }
  return deriveTimeline(initialFen, moves, key).timeline;
}
function deriveTimeline(initialFen: string, moves: string[], key: string): { timeline: Timeline; game: Chess } {
  timelineBuilds++;
  const game = new Chess(initialFen);
  const normalized = game.fen();
  // Prefix row identity is shared with retained timelines, including branches
  // and takebacks. The scan is bounded by 64 lines and allocates no prefixes.
  // After all equivalent histories leave this window, a rebuild gets fresh
  // local IDs and may restore its evaluations from the server again.
  let shared: Timeline | undefined;
  let sharedPly = -1;
  for (const candidate of timelineCache.values()) {
    if (candidate.initialFen !== normalized) continue;
    let ply = 0;
    while (ply < moves.length && ply < candidate.moves.length && candidate.moves[ply] === moves[ply]) ply++;
    if (ply > sharedPly) { shared = candidate; sharedPly = ply; }
  }
  const rows: TimelineRow[] = [shared?.rows[0] ?? {
    ply: 0, uci: '', san: '', fen: game.fen(),
    turn: game.turn() === 'w' ? 'white' : 'black',
    outcome: outcome(game),
    historyId: ++nextHistoryId,
    lastMove: undefined,
  }];
  for (const uci of moves) {
    const applied = applyUci(game, uci);
    if (shared && rows.length <= sharedPly) { rows.push(shared.rows[rows.length]); continue; }
    rows.push({
      ply: rows.length,
      uci: uciFromMove(applied),
      san: applied.san,
      fen: game.fen(),
      turn: game.turn() === 'w' ? 'white' : 'black',
      outcome: outcome(game),
      historyId: ++nextHistoryId,
      lastMove: [applied.from, applied.to],
    });
  }
  const timeline = { initialFen: normalized, moves: [...moves], rows };
  for (const row of rows) { if (row.lastMove) Object.freeze(row.lastMove); if (row.outcome) Object.freeze(row.outcome); Object.freeze(row); }
  Object.freeze(timeline.moves); Object.freeze(rows); Object.freeze(timeline);
  touchTimeline(key, timeline);
  return { timeline, game };
}

// Length of the legal prefix of a possibly-untrusted move list. One plain
// legality walk, no history evaluation: callers narrow corrupt lines before
// paying for the full timeline build.
export function legalPrefixLength(initialFen: string, moves: string[]): number {
  const game = new Chess(initialFen);
  let length = 0;
  for (const uci of moves) {
    try { applyUci(game, uci); }
    catch { break; }
    length++;
  }
  return length;
}

// Compatibility projection for persistence callers. Chess facts always come
// from the canonical timeline; only this boundary materializes SAN arrays.
export type LineRecord = Position & { terminal: Evaluation | null };
export function lineRecordMissesForTests(): number { return timelineBuilds; }
export function resetLineRecordsForTests(): void { resetTimelinesForTests(); }
export function lineRecord(moves: string[], initialFen = START_FEN): LineRecord {
  const timeline = buildTimeline(initialFen, moves);
  const tip = timeline.rows[moves.length];
  return { fen: tip.fen, moves, sanMoves: timeline.rows.slice(1).map(row => row.san),
    lastMove: tip.lastMove ? [...tip.lastMove] : undefined, terminal: outcomeEvaluation(tip.outcome) ?? null };
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

// History-aware terminal flags for every prefix of a line, read off the
// canonical timeline: one progressive walk instead of per-prefix replays.
export function terminalFlags(initialFen: string, moves: string[]): boolean[] {
  return buildTimeline(initialFen, moves).rows.map(row => row.outcome !== null);
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
