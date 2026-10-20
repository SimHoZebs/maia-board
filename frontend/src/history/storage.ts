import {
  normalizeClocks,
  normalizeSettings,
  normalizeSpeed,
  normalizeTimeControl,
  replay,
  type Settings,
  type StoredGame,
} from '../shared/domain';
import { isRecord, isStringArray } from '../shared/guards';

export const KEYS = {
  settings: 'maia-board.settings.v1',
  analysis: 'maia-board.analysis.v1',
  snapshot: 'maia-board.analysis-snapshot.v1',
  feedback: 'maia-board.feedback.v1',
  playVerdict: 'maia-board.play-verdict.v1',
  badgeLoading: 'maia-board.badge-loading.v1',
  coordinatesOnSquares: 'maia-board.coordinates-on-squares.v1',
  sound: 'maia-board.sound-enabled.v1',
  boardOrientation: 'maia-board.board-orientation.v1',
  bestLineWindow: 'maia-board.best-line-window.v1',
  arrows: 'maia-board.arrows.v1',
  arrowBasis: 'maia-board.arrow-basis.v1',
  userEloAnchor: 'maia-board.user-elo-anchor.v1',
  lichessSync: 'maia-board.lichess-sync.v1',
  lichessEloBasis: 'maia-board.lichess-elo-basis.v1',
};
export function readStorage<T>(key: string): T | undefined {
  // Quarantined JSON boundary: JSON.parse() returns `any`, which flows into
  // the generic without an assertion. Every caller validates downstream —
  // parseStoredGame (saved/current games), normalizeSettings (settings),
  // normalizeStockfishSettings / === true checks (state.ts), and key-specific
  // narrowing (useBotBoard.ts) — so no `as` cast is needed or allowed here.
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}
export function writeStorage(key: string, value: unknown): Error | undefined {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (cause) {
    return new Error(
      `Local storage is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
// Narrows unvalidated storage JSON to normalizeSettings' input without
// asserting: only values normalizeSettings can distinguish pass through (its
// own per-field fallbacks decide the rest), so behavior is unchanged.
function toSettingsInput(value: unknown): Partial<Settings> | undefined {
  if (!isRecord(value)) return undefined;
  const input: Partial<Settings> = {};
  const { userColor, model, botElo, userElo, temperature } = value;
  if (userColor === 'black' || userColor === 'white') input.userColor = userColor;
  if (model === '5m' || model === '79m') input.model = model;
  if (typeof botElo === 'number') input.botElo = botElo;
  if (typeof userElo === 'number') input.userElo = userElo;
  if (typeof temperature === 'number') input.temperature = temperature;
  return input;
}
export function parseStoredGame(value: unknown): StoredGame | undefined {
  if (!isRecord(value)) return;
  const {
    id,
    moves,
    createdAt,
    settings,
    result,
    source,
    opponent,
    ratingDiff,
    rating_diff,
    timeControl,
    time_control,
    speed,
    clocks,
  } = value;
  if (typeof id !== 'string' || !isStringArray(moves)) return;
  const diff = ratingDiff ?? rating_diff;
  const clock = normalizeTimeControl(timeControl ?? time_control);
  const pool = normalizeSpeed(speed);
  const readings = normalizeClocks(clocks);
  try {
    replay(moves);
    return {
      id,
      moves,
      createdAt: typeof createdAt === 'string' ? createdAt : new Date(0).toISOString(),
      settings: normalizeSettings(toSettingsInput(settings)),
      ...(result === 'resigned' ? { result: 'resigned' as const } : {}),
      ...(typeof source === 'string' && source.length > 0 && source.length <= 64 ? { source } : {}),
      ...(typeof opponent === 'string' && opponent.length > 0 && opponent.length <= 64
        ? { opponent }
        : {}),
      ...(typeof diff === 'number' && Number.isInteger(diff) && diff >= -1000 && diff <= 1000
        ? { ratingDiff: diff }
        : {}),
      ...(clock !== undefined ? { timeControl: clock } : {}),
      ...(pool !== undefined ? { speed: pool } : {}),
      ...(readings !== undefined ? { clocks: readings } : {}),
    };
  } catch {
    return;
  }
}
export function loadSettings(): Settings {
  return normalizeSettings(readStorage<Partial<Settings>>(KEYS.settings));
}
