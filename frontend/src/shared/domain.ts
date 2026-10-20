import { Chess, SQUARES, type Square } from 'chess.js';
import type { Key } from '@lichess-org/chessground/types';
import type { SideColor, BotModel, MoveResponse } from '../eval/api';
import type { Evaluation } from '../review/reviewMetrics';
import { outcomeFromGame } from '../review/reviewMetrics';
import { outcomeEvaluation } from '../review/outcomeEvaluation';
import { clampElo } from '../board/BoardTools';
import { mapGetOrNull } from './explicit';

// Terms: see spec/GLOSSARY.md (position/line/posId/lineKey).
export const START_FEN = new Chess().fen();
export type Mode = 'play' | 'analysis' | 'history' | 'settings';
export type Settings = {
  userColor: SideColor;
  botElo: number;
  userElo: number;
  model: BotModel;
  temperature?: number;
};
export type Position = {
  fen: string;
  moves: string[];
  sanMoves: string[];
  // Null at the root (no move yet) — never undefined.
  lastMove: [Key, Key] | null;
};
export type Analysis = {
  initialFen: string;
  moves: string[];
  sanMoves: string[];
  index: number;
  branchFromPly: number | null;
  branchMoves: string[];
  perspective: SideColor;
  ownGame: boolean;
  // Board identity from a pasted PGN's seven-tag roster. Present only when
  // the import carried at least one player name; movetext-only input and
  // platform games (which resolve identity from settings) leave it absent.
  players?: LinePlayers;
};
// One side's board identity: display name plus Elo when the source knew it.
export type LinePlayer = { name: string; elo?: number };
export type LinePlayers = { white: LinePlayer; black: LinePlayer };
export type Insight = { response: MoveResponse; fen: string; mode: Mode };
export type StoredGame = {
  id: string;
  createdAt: string;
  moves: string[];
  settings: Settings;
  result?: 'resigned';
  source?: string;
  opponent?: string;
  ratingDiff?: number;
  // Canonical clock (`600+5`, `180+0`, `3d` for correspondence days, `-`
  // for untimed). Absent means unlimited: local engine games and rows
  // saved before clocks were stamped.
  timeControl?: string;
  // Lichess speed pool (`blitz`, `rapid`, ...). Absent when unknown.
  speed?: string;
  // Per-ply remaining time in centiseconds, one entry per move for the side
  // that just moved (Lichess `clocks`, requested with clocks=true). Absent
  // when unknown: local games, correspondence/untimed imports, and rows
  // imported before readings were requested.
  clocks?: number[];
};
export const defaultSettings: Settings = {
  userColor: 'white',
  botElo: 1600,
  userElo: 400,
  model: '79m',
  temperature: 1,
};
export const oppositeColor = (color: SideColor): SideColor =>
  color === 'white' ? 'black' : 'white';
export type BoardOrientationSetting = 'auto' | SideColor;
export function normalizeBoardOrientation(stored: unknown): BoardOrientationSetting {
  return stored === 'white' || stored === 'black' ? stored : 'auto';
}
// Base orientation comes from the setting; 'auto' means the player's own
// color faces them (play userColor, analysis perspective). The manual flip
// button inverts whatever the setting resolved to.
export function resolveBoardOrientation(
  setting: BoardOrientationSetting,
  autoColor: SideColor,
  flipped: boolean,
): SideColor {
  const base = setting === 'auto' ? autoColor : setting;
  return flipped ? oppositeColor(base) : base;
}
export const sideName = (color: SideColor) => (color === 'white' ? 'White' : 'Black');

// Clock support: local engine games are untimed (no clock setting exists),
// while Lichess imports carry the canonical time control (`600+5`, `180+0`,
// `3d` for correspondence days, `-` for untimed) plus the speed pool.
export const LICHESS_SPEEDS = [
  'ultrabullet',
  'bullet',
  'blitz',
  'rapid',
  'classical',
  'correspondence',
  'unlimited',
] as const;
export type LichessSpeed = (typeof LICHESS_SPEEDS)[number];

export function normalizeTimeControl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (value === '-') return value;
  if (/^\d{1,2}d$/.test(value)) {
    const days = Number.parseInt(value.slice(0, -1), 10);
    if (days >= 1 && days <= 14) return value;
    return undefined;
  }
  const parts = value.split('+');
  if (parts.length !== 2) return undefined;
  const initial = Number(parts[0]);
  const increment = Number(parts[1]);
  if (
    !Number.isInteger(initial) ||
    !Number.isInteger(increment) ||
    initial < 0 ||
    initial > 1209600 ||
    increment < 0 ||
    increment > 3600
  )
    return undefined;
  return value;
}

export function normalizeSpeed(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return (LICHESS_SPEEDS as readonly string[]).includes(value) ? value : undefined;
}

// Per-ply remaining centiseconds: every entry a non-negative integer
// within 14 days, at most one per ply. Empty and mismatched arrays are
// dropped by the importer (length is checked against the move list there);
// this boundary only guards the shape.
export function normalizeClocks(value: unknown): number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096) return undefined;
  if (
    !value.every(
      entry =>
        typeof entry === 'number' &&
        Number.isInteger(entry) &&
        entry >= 0 &&
        entry <= 14 * 86400 * 100,
    )
  )
    return undefined;
  return [...value];
}

// Urgency threshold for the remaining-time label: under a minute the
// strip clock turns orange.
export const LOW_TIME_CENTISECONDS = 6000;

// Compact remaining-time label for one reading: `m:ss` under an hour,
// `h:mm:ss` above. Centiseconds truncate (a clock shows whole seconds).
export function formatClock(centiseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(centiseconds / 100));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

// Remaining time for one side at a viewed ply. Readings are per-move for
// the side that just moved, so each side reads its latest entry at or
// before the ply; a side yet to move falls back to the initial time when
// the time control names one. Undefined when no data covers the position.
export function remainingAt(
  game: Pick<StoredGame, 'clocks' | 'timeControl'>,
  ply: number,
  color: SideColor,
): number | undefined {
  const readings = game.clocks;
  if (readings !== undefined) {
    const parity = color === 'white' ? 0 : 1;
    for (let index = Math.min(ply, readings.length) - 1; index >= 0; index--) {
      if (index % 2 === parity) return readings[index];
    }
  }
  if (
    game.timeControl !== undefined &&
    game.timeControl !== '-' &&
    !game.timeControl.endsWith('d')
  ) {
    const initial = Number(game.timeControl.split('+')[0]);
    if (Number.isInteger(initial) && initial >= 0) return initial * 100;
  }
  return undefined;
}

// Static clock label for history and board strips (no ticking: finished
// imports show their setting, local games show unlimited).
export function formatTimeControl(game: Pick<StoredGame, 'timeControl' | 'speed'>): string {
  const speed = game.speed;
  const raw = game.timeControl;
  if (raw !== undefined && /^\d{1,2}d$/.test(raw)) {
    const days = Number.parseInt(raw.slice(0, -1), 10);
    const label = `${days} day${days === 1 ? '' : 's'}/move`;
    return speed && speed !== 'unlimited' ? `${label} • ${speed}` : label;
  }
  if (raw !== undefined && raw !== '-') {
    const [initialRaw, incrementRaw] = raw.split('+');
    const initial = Number(initialRaw);
    const increment = Number(incrementRaw);
    if (Number.isInteger(initial) && Number.isInteger(increment)) {
      const base = initial % 60 === 0 ? String(initial / 60) : `${initial}s`;
      const label = `${base}+${increment}`;
      return speed && speed !== 'unlimited' ? `${label} • ${speed}` : label;
    }
  }
  if (speed === 'correspondence') return 'Correspondence';
  if (speed && speed !== 'unlimited') return `∞ • ${speed}`;
  return '∞';
}
export const newId = () =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Null (or an omitted argument) means no stored settings: every field
// falls back, and each fallback is named below. The container is narrowed
// once here so no `?.` trails into the per-field fallbacks.
export function normalizeSettings(stored: Partial<Settings> | null = null): Settings {
  const input: Partial<Settings> = stored === null ? {} : stored;
  const elo = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5000
      ? value
      : fallback;
  // Opponent bot strength never leaves the trained range (a stored
  // 400 still conditions, displays, and caches as 800); the player's own
  // identity stays raw for the coming global-Elo pass.
  const botElo = (value: unknown, fallback: number) => clampElo(elo(value, fallback));
  const storedBotElo = input.botElo;
  // The player's own rating defaults to the 400 anchor (see userElo.ts),
  // never to the bot strength: mirroring botElo guesses the user is a 1600
  // player. Pre-rename saves keep their stored userElo.
  return {
    userColor: input.userColor === 'black' ? 'black' : 'white',
    model: input.model === '5m' ? '5m' : '79m',
    botElo: botElo(storedBotElo, 1600),
    userElo: elo(input.userElo, 400),
    temperature:
      typeof input.temperature === 'number' &&
      Number.isFinite(input.temperature) &&
      input.temperature >= 0 &&
      input.temperature <= 2
        ? input.temperature
        : 0,
  };
}

// One validated text→square boundary for every chess-square cast site
// (domain, state, ChessBoard, reviewArrows, workspaces). chess.js owns the
// 64-square list, so a lookup table proves membership with no assertion;
// callers handle undefined explicitly (throw or skip) and never misrender.
// Chessground keys add the off-board rank-0 file (a0..h0) to the 64 squares.
const SQUARE_LOOKUP: Record<string, Square | undefined> = Object.fromEntries(
  SQUARES.map(square => [square, square]),
);
export function parseSquare(text: unknown): Square | null {
  if (typeof text !== 'string') return null;
  const found = SQUARE_LOOKUP[text];
  return found === undefined ? null : found;
}
const KEY_LOOKUP: Record<string, Key | undefined> = Object.fromEntries([
  ...SQUARES.map(square => [square, square]),
  ...(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const).map(file => [`${file}0`, `${file}0`]),
]);
export function parseKey(text: unknown): Key | null {
  if (typeof text !== 'string') return null;
  const found = KEY_LOOKUP[text];
  return found === undefined ? null : found;
}

export function applyUci(game: Chess, uci: string) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error(`Invalid UCI move: ${uci}`);
  const from = parseSquare(uci.slice(0, 2));
  const to = parseSquare(uci.slice(2, 4));
  if (from === null || to === null) throw new Error(`Invalid UCI move: ${uci}`);
  return game.move({ from, to, ...(uci[4] ? { promotion: uci[4] } : {}) });
}
export function uciFromMove(move: { from: string; to: string; promotion?: string }) {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}
export function replay(moves: string[], initialFen = START_FEN): Chess {
  const key = posId(initialFen, moves);
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
  const last = history.length > 0 ? history[history.length - 1] : null;
  return {
    fen: game.fen(),
    moves: history.map(uciFromMove),
    sanMoves: game.history(),
    lastMove: last === null ? null : [last.from, last.to],
  };
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
    if (
      !token ||
      token === '...' ||
      /^\d+\.{1,3}$/.test(token) ||
      /^(1-0|0-1|1\/2-1\/2|\*)$/.test(token) ||
      /^\$\d+$/.test(token)
    )
      continue;
    try {
      moves.push(
        uciFromMove(
          /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(token) ? applyUci(game, token) : game.move(token),
        ),
      );
    } catch {
      throw new Error(`Could not read PGN move "${token}".`);
    }
  }
  return moves;
}
export function loadLine(fen = '', pgn = ''): Analysis {
  // Explicit FEN wins; otherwise honor the starting position in an exported PGN.
  const fenTag = pgn.match(/\[FEN\s+"([^"]+)"\]/i);
  const initialFen = new Chess(fen.trim() || (fenTag === null ? '' : fenTag[1]) || START_FEN).fen();
  const moves = parsePgnMoves(pgn, new Chess(initialFen));
  const timeline = buildTimeline(initialFen, moves);
  const players = parsePgnPlayers(pgn);
  return {
    initialFen,
    moves,
    sanMoves: timeline.rows.slice(1).map(row => row.san),
    index: moves.length,
    branchFromPly: null,
    branchMoves: [],
    perspective: timeline.rows[0].turn,
    ownGame: false,
    ...(players ? { players } : {}),
  };
}
// PGN seven-tag roster carries the board names: White/Black plus their Elos
// when present. Parsed on import so pasted games keep their identity on the
// strips; absent name headers mean movetext-only input (no players). A bare
// `White` tag never matches `WhiteElo`: the closing quote pattern requires
// whitespace after the tag name.
export function parsePgnPlayers(pgn: string): LinePlayers | null {
  const tag = (name: string): string | null => {
    const found = pgn.match(new RegExp(`\\[${name}\\s+"([^"]+)"\\]`, 'i'));
    const value = found === null ? null : found[1].trim();
    // PGN uses "?" for unknown: chess.js also emits it for unset headers on
    // export, so it parses as absent and header-less lines round-trip clean.
    if (value === null || value === '' || value === '?') return null;
    return value.slice(0, 64);
  };
  const elo = (name: string): number | null => {
    const raw = tag(name);
    const parsed = Number.parseInt(raw === null ? '' : raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 5000 ? parsed : null;
  };
  const player = (color: 'White' | 'Black'): LinePlayer | null => {
    const name = tag(color);
    if (name === null) return null;
    const rating = elo(`${color}Elo`);
    return rating === null ? { name } : { name, elo: rating };
  };
  const white = player('White');
  const black = player('Black');
  if (white === null && black === null) return null;
  return {
    white: white === null ? { name: 'White' } : white,
    black: black === null ? { name: 'Black' } : black,
  };
}
// Untrusted-storage counterpart of parsePgnPlayers: snapshots persist the
// parsed roster, so refresh restores it only when it still validates.
export function normalizeLinePlayers(value: unknown): LinePlayers | null {
  if (typeof value !== 'object' || value === null) return null;
  const side = (entry: unknown, fallback: string): LinePlayer => {
    if (typeof entry !== 'object' || entry === null) return { name: fallback };
    const record = entry as Record<string, unknown>;
    const name =
      typeof record.name === 'string' && record.name.trim()
        ? record.name.trim().slice(0, 64)
        : fallback;
    const elo =
      typeof record.elo === 'number' &&
      Number.isInteger(record.elo) &&
      record.elo >= 0 &&
      record.elo <= 5000
        ? record.elo
        : null;
    return elo === null ? { name } : { name, elo };
  };
  const record = value as Record<string, unknown>;
  if (record.white === undefined && record.black === undefined) return null;
  return { white: side(record.white, 'White'), black: side(record.black, 'Black') };
}
export function exportLine(analysis: Analysis, timeControl?: string): string {
  const game = replay(analysis.moves, analysis.initialFen);
  game.setHeader('Event', 'Maia Board');
  if (analysis.players) {
    game.setHeader('White', analysis.players.white.name);
    game.setHeader('Black', analysis.players.black.name);
    if (analysis.players.white.elo !== undefined)
      game.setHeader('WhiteElo', String(analysis.players.white.elo));
    if (analysis.players.black.elo !== undefined)
      game.setHeader('BlackElo', String(analysis.players.black.elo));
  }
  if (timeControl !== undefined && normalizeTimeControl(timeControl) !== undefined) {
    game.setHeader('TimeControl', timeControl);
  }
  if (analysis.initialFen !== START_FEN) {
    game.setHeader('SetUp', '1');
    game.setHeader('FEN', analysis.initialFen);
  }
  return game.pgn();
}
export function candidateSan(fen: string, uci: string): string {
  try {
    return applyUci(new Chess(fen), uci).san;
  } catch {
    return uci;
  }
}

// One timeline owns the displayed position and the API's history, including
// custom starts. The stored initialFen is already normalized at load; the
// timeline's normalized root is the canonical identity (no extra FEN parse).
export function analysisLine(
  analysis: Analysis,
  at = analysis.index,
): Position & { initialFen: string } {
  const moves =
    analysis.branchFromPly === null
      ? analysis.moves
      : [...analysis.moves.slice(0, analysis.branchFromPly), ...analysis.branchMoves];
  const timeline = buildTimeline(analysis.initialFen, moves);
  const clamped = Math.max(0, Math.min(at, moves.length));
  return {
    fen: timeline.rows[clamped].fen,
    moves: moves.slice(0, clamped),
    sanMoves: timeline.rows.slice(1, clamped + 1).map(row => row.san),
    lastMove: timeline.rows[clamped].lastMove,
    initialFen: timeline.initialFen,
  };
}
export function analysisLength(analysis: Analysis): number {
  return analysis.branchFromPly === null
    ? analysis.moves.length
    : analysis.branchFromPly + analysis.branchMoves.length;
}
export function exportExplored(analysis: Analysis): string {
  return exportLine({ ...analysis, moves: analysisLine(analysis, analysisLength(analysis)).moves });
}
export function gameResult(game: Chess): string {
  return game.isCheckmate()
    ? game.turn() === 'w'
      ? 'Black wins'
      : 'White wins'
    : game.isDraw()
      ? 'Draw'
      : 'Unfinished';
}
export function isResigned(game: Pick<StoredGame, 'result'>): boolean {
  return game.result === 'resigned';
}
// History and game-over banners share one reading: a resignation outranks the
// board, which stays replayable underneath.
export function storedGameResult(game: StoredGame): string {
  if (isResigned(game))
    return `${sideName(oppositeColor(game.settings.userColor))} wins · resignation`;
  return resultTextForOutcome(tipRow(buildTimeline(START_FEN, game.moves)).outcome);
}
// Losing-king marker for game-over boards: scan the displayed FEN for the
// given side's king. Invalid FEN or a missing king yields undefined so
// callers render no badge rather than a wrong one.
export function findKingSquare(game: Chess, color: 'w' | 'b'): Square | null {
  for (const row of game.board()) {
    for (const square of row) {
      if (square && square.type === 'k' && square.color === color) return square.square;
    }
  }
  return null;
}
const KING_SQUARE_CACHE_LIMIT = 512;
const kingSquareCache = new Map<string, Key | null>();
export function kingSquare(fen: string, color: SideColor): Key | null {
  const key = `${fen}|${color}`;
  const hit = mapGetOrNull(kingSquareCache, key);
  // A cached null is a settled miss (invalid FEN or no king) — only a
  // true map miss recomputes. has/get pairs would read the miss twice.
  if (hit !== null || kingSquareCache.has(key)) return hit;
  let result: Key | null;
  try {
    const found = findKingSquare(new Chess(fen), color === 'white' ? 'w' : 'b');
    result = found === null ? null : parseKey(found);
  } catch {
    result = null;
  }
  kingSquareCache.set(key, result);
  if (kingSquareCache.size > KING_SQUARE_CACHE_LIMIT)
    kingSquareCache.delete(kingSquareCache.keys().next().value!);
  return result;
}
// score_moves evaluates _history_after_move, then invert_wdl restores the choosing side.
// https://github.com/CSSLab/maia3/blob/1e13597c42d4858b7cfd7cfdae01e297263364b2/maia3/uci.py
export function absoluteWdl(fen: string, wdl: MoveResponse['wdl']) {
  const [loss, draw, win] = wdl;
  return turnFromFen(fen) === 'white' ? [win, draw, loss] : [loss, draw, win];
}

// One history-aware walk owns the position facts for every ply.
export type TimelineRow = {
  ply: number;
  uci: string;
  san: string;
  fen: string;
  turn: 'white' | 'black';
  // Side to move in check. Computed once during the derivation walk
  // (game.inCheck()), so render loops read it instead of parsing the FEN.
  check: boolean;
  outcome: DomainOutcome | null;
  lastMove: [Key, Key] | null;
};
export type Timeline = { initialFen: string; moves: string[]; rows: TimelineRow[] };
export type DomainOutcome = { kind: 'checkmate'; winner: SideColor } | { kind: 'draw' };
const timelineCache = new Map<string, Timeline>();
const TIMELINE_CACHE_LIMIT = 64;
function touchTimeline(key: string, timeline: Timeline) {
  timelineCache.delete(key);
  timelineCache.set(key, timeline);
  if (timelineCache.size > TIMELINE_CACHE_LIMIT)
    timelineCache.delete(timelineCache.keys().next().value!);
}
function outcome(game: Chess): DomainOutcome | null {
  return outcomeFromGame(game);
}

// Test observability only: counts builder invocations, mirroring
// lineRecordMissesForTests. Lets the suite assert that render loops and
// navigation read rows without rebuilding the timeline.
let timelineBuilds = 0;
export function timelineBuildsForTests(): number {
  return timelineBuilds;
}
export function resetTimelinesForTests(): void {
  timelineCache.clear();
  timelineBuilds = 0;
}

export function buildTimeline(initialFen: string, moves: string[]): Timeline {
  const key = posId(initialFen, moves);
  const cached = timelineCache.get(key);
  if (cached) {
    touchTimeline(key, cached);
    return cached;
  }
  return deriveTimeline(initialFen, moves, key).timeline;
}
function deriveTimeline(
  initialFen: string,
  moves: string[],
  key: string,
): { timeline: Timeline; game: Chess } {
  timelineBuilds++;
  const game = new Chess(initialFen);
  const normalized = game.fen();
  // Prefix rows are shared with retained timelines, including branches and
  // takebacks. The scan is bounded by 64 lines and allocates no prefixes.
  // Null means no shared prefix found — never undefined.
  let shared: Timeline | null = null;
  let sharedPly = -1;
  for (const candidate of timelineCache.values()) {
    if (candidate.initialFen !== normalized) continue;
    let ply = 0;
    while (
      ply < moves.length &&
      ply < candidate.moves.length &&
      candidate.moves[ply] === moves[ply]
    )
      ply++;
    if (ply > sharedPly) {
      shared = candidate;
      sharedPly = ply;
    }
  }
  const rows: TimelineRow[] = [
    shared === null
      ? {
          ply: 0,
          uci: '',
          san: '',
          fen: game.fen(),
          turn: game.turn() === 'w' ? 'white' : 'black',
          check: game.inCheck(),
          outcome: outcome(game),
          lastMove: null,
        }
      : shared.rows[0],
  ];
  for (const uci of moves) {
    const applied = applyUci(game, uci);
    if (shared !== null && rows.length <= sharedPly) {
      rows.push(shared.rows[rows.length]);
      continue;
    }
    rows.push({
      ply: rows.length,
      uci: uciFromMove(applied),
      san: applied.san,
      fen: game.fen(),
      turn: game.turn() === 'w' ? 'white' : 'black',
      check: game.inCheck(),
      outcome: outcome(game),
      lastMove: [applied.from, applied.to],
    });
  }
  const timeline = { initialFen: normalized, moves: [...moves], rows };
  for (const row of rows) {
    if (row.lastMove !== null) Object.freeze(row.lastMove);
    if (row.outcome) Object.freeze(row.outcome);
    Object.freeze(row);
  }
  Object.freeze(timeline.moves);
  Object.freeze(rows);
  Object.freeze(timeline);
  touchTimeline(key, timeline);
  return { timeline, game };
}

// Stable position identity: the server's history inputs, never memory IDs.
// Repetitions share fen but differ in moves-prefix; custom starts share fen
// but differ in initialFen. Both must miss each other and survive rebuilds.
export function posId(initialFen: string, prefixMoves: readonly string[]): string {
  return JSON.stringify([initialFen, prefixMoves]);
}
// Full-line scope key: hash(initialFen + moves). Abort scopes and cache keys
// share this identity so a line change invalidates exactly its own work.
export function lineKeyFor(initialFen: string, moves: readonly string[]): string {
  return posId(initialFen, moves);
}

// Thin row views: O(1) reads into the once-per-line timeline, never a re-walk.
export function rowAt(timeline: Timeline, ply: number): TimelineRow {
  const clamped = Math.max(0, Math.min(ply, timeline.rows.length - 1));
  return timeline.rows[clamped];
}
const tipMemo = new WeakMap<Timeline, TimelineRow>();
export function tipRow(timeline: Timeline): TimelineRow {
  let cached = tipMemo.get(timeline);
  if (!cached) {
    cached = timeline.rows[timeline.rows.length - 1];
    tipMemo.set(timeline, cached);
  }
  return cached;
}
// Alias for the REFACTOR rowAt/tip/materialAt trio: the tip row owns the
// live outcome/turn/check without a replay.
export function tip(timeline: Timeline): TimelineRow {
  return tipRow(timeline);
}

// Side to move straight from the FEN turn field. Position-only and total
// (no history input), so render loops read this instead of parsing a Chess
// instance for the turn.
export function turnFromFen(fen: string): 'white' | 'black' | undefined {
  const token = fen.split(' ')[1];
  if (token === 'w') return 'white';
  if (token === 'b') return 'black';
  return undefined;
}

export type MaterialScore = { white: number; black: number; diff: number };
const MATERIAL_VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
// FEN piece-placement scan (kings excluded, diff White-relative). Matches
// materialFromFen exactly without a Chess parse.
function materialFromFenString(fen: string): MaterialScore {
  let white = 0;
  let black = 0;
  const placement = fen.split(' ')[0] ?? '';
  for (const char of placement) {
    if (char === '/' || (char >= '1' && char <= '8')) continue;
    const lower = char.toLowerCase();
    if (lower === 'k') continue;
    const value = MATERIAL_VALUES[lower];
    if (value === undefined) continue;
    if (char === lower) black += value;
    else white += value;
  }
  return { white, black, diff: white - black };
}
// Memoized material per timeline (keyed by the lineKey-owned timeline
// identity): one FEN-string scan per row on first use, then O(1) reads while
// scrubbing. Never constructs a Chess instance.
const materialMemo = new WeakMap<Timeline, MaterialScore[]>();
export function materialAt(timeline: Timeline, ply: number): MaterialScore {
  let cached = materialMemo.get(timeline);
  if (!cached) {
    cached = timeline.rows.map(row => materialFromFenString(row.fen));
    materialMemo.set(timeline, cached);
  }
  const clamped = Math.max(0, Math.min(ply, cached.length - 1));
  return cached[clamped] ?? { white: 0, black: 0, diff: 0 };
}

// Length of the legal prefix of a possibly-untrusted move list. One plain
// legality walk, no history evaluation: callers narrow corrupt lines before
// paying for the full timeline build.
export function legalPrefixLength(initialFen: string, moves: string[]): number {
  const game = new Chess(initialFen);
  let length = 0;
  for (const uci of moves) {
    try {
      applyUci(game, uci);
    } catch {
      break;
    }
    length++;
  }
  return length;
}

// Compatibility projection for persistence callers. A thin view over the
// canonical timeline: no rebuild beyond the shared once-per-line build, no
// per-row walks. Only this boundary materializes SAN arrays.
export type LineRecord = Position & { terminal: Evaluation | null };
export function lineRecordMissesForTests(): number {
  return timelineBuilds;
}
export function resetLineRecordsForTests(): void {
  resetTimelinesForTests();
}
export function lineRecord(moves: string[], initialFen = START_FEN): LineRecord {
  const timeline = buildTimeline(initialFen, moves);
  const end = tipRow(timeline);
  return {
    fen: end.fen,
    moves,
    sanMoves: timeline.rows.slice(1).map(row => row.san),
    lastMove: end.lastMove === null ? null : [...end.lastMove],
    terminal: outcomeEvaluation(end.outcome),
  };
}

// Commit step: legality probe on a single parse (throws on illegal moves like
// game.move), canonical UCI from the applied move, and the full derivation
// back from the shared memo — exactly one replay per genuinely new tip, zero
// for the base or any re-derivation.
export function extendLine(
  moves: string[],
  initialFen: string,
  from: Square,
  to: Square,
  promotion?: string,
): { moves: string[]; record: LineRecord } {
  const probe = new Chess(lineRecord(moves, initialFen).fen);
  const applied = probe.move({ from, to, ...(promotion ? { promotion } : {}) });
  const nextMoves = [
    ...moves,
    uciFromMove({ from: applied.from, to: applied.to, promotion: applied.promotion }),
  ];
  return { moves: nextMoves, record: lineRecord(nextMoves, initialFen) };
}

// Takebacks address the tip-1/tip-2 prefixes, which retention keeps: normally a
// hit, degrading to one replay after eviction or on a cold cache.
export function retreatLine(
  moves: string[],
  initialFen: string,
  plies: number,
): { moves: string[]; record: LineRecord } {
  const prefix = moves.slice(0, Math.max(0, moves.length - plies));
  return { moves: prefix, record: lineRecord(prefix, initialFen) };
}

// History-aware terminal flags for every prefix of a line, read off the
// canonical timeline: one progressive walk instead of per-prefix replays.
export function terminalFlags(initialFen: string, moves: string[]): boolean[] {
  return buildTimeline(initialFen, moves).rows.map(row => row.outcome !== null);
}

// Result text without a replay: the memoized timeline outcome owns both
// branches — checkmate names its winner, any other terminal is a draw.
// Mirrors gameResult() exactly; never parses a FEN (FEN-parsed
// isDraw()/isGameOver() miss threefold repetition).
export function resultTextForOutcome(outcome: DomainOutcome | null): string {
  if (!outcome) return 'Unfinished';
  if (outcome.kind === 'checkmate') return outcome.winner === 'white' ? 'White wins' : 'Black wins';
  return 'Draw';
}
export function resultTextForTip(_tipFen: string, terminal: Evaluation | null): string {
  if (terminal !== null && terminal.terminal === 'white_win') return 'White wins';
  if (terminal !== null && terminal.terminal === 'black_win') return 'Black wins';
  return terminal !== null ? 'Draw' : 'Unfinished';
}
