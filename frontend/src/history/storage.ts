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

export class StorageError extends Error {
  readonly key: string;
  constructor(key: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
    this.key = key;
  }
}

// Missing keys are the only `undefined` this boundary returns. Corrupt JSON
// and unavailable localStorage throw StorageError instead of collapsing
// into the missing state.
export function readStorage<T>(key: string): T | undefined {
  // Quarantined JSON boundary: JSON.parse() returns `any`, which flows into
  // the generic without an assertion. Every caller validates downstream —
  // parseStoredGame (saved/current games), normalizeSettings (settings),
  // normalizeStockfishSettings / === true checks (state.ts), and key-specific
  // narrowing (useBotBoard.ts) — so no `as` cast is needed or allowed here.
  let value: string | null;
  try {
    value = localStorage.getItem(key);
  } catch (cause) {
    throw new StorageError(key, `Local storage is unavailable for ${key}.`, { cause });
  }
  if (value === null || value === '') return undefined;
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new StorageError(key, `Stored value for ${key} is corrupt.`, { cause });
  }
}

// Success is silent (void). Failures throw StorageError — never `Error |
// undefined`, where `undefined` meant success.
export function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (cause) {
    throw new StorageError(
      key,
      `Local storage is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
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
export type ParseGameResult =
  | { ok: true; game: StoredGame }
  | {
      ok: false;
      reason: 'not-record' | 'missing-id' | 'bad-moves' | 'illegal-history' | 'missing-moves';
    };

// Rejects carry their reason instead of collapsing into `undefined`.
// Callers switch on `ok` and route the reason into recovery — never
// truthiness (`if (game)`), which drops the cause.
export function parseStoredGame(value: unknown): ParseGameResult {
  if (!isRecord(value)) return { ok: false, reason: 'not-record' };
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
  if (typeof id !== 'string') return { ok: false, reason: 'missing-id' };
  if (!isStringArray(moves)) return { ok: false, reason: 'bad-moves' };
  // Legacy `rating_diff` vs canonical `ratingDiff`: canonical wins when both
  // are present; absence is not a failure (untimed/local rows omit it).
  const diff = ratingDiff !== undefined ? ratingDiff : rating_diff;
  // Legacy `time_control` vs canonical `timeControl`: same precedence.
  const clock = normalizeTimeControl(timeControl !== undefined ? timeControl : time_control);
  const pool = normalizeSpeed(speed);
  const readings = normalizeClocks(clocks);
  try {
    replay(moves);
  } catch {
    return { ok: false, reason: 'illegal-history' };
  }
  return {
    ok: true,
    game: {
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
    },
  };
}
export function loadSettings(): Settings {
  // Missing storage is defaults. Corrupt storage is an explicit repair, not
  // a silent fallback: it logs once with the key and then defaults, so the
  // failure is visible while the board stays usable.
  try {
    return normalizeSettings(readStorage<Partial<Settings>>(KEYS.settings));
  } catch (error) {
    if (error instanceof StorageError) {
      console.warn(`maia-board: corrupt settings for ${error.key}; using defaults.`);
      return normalizeSettings(undefined);
    }
    throw error;
  }
}

// Preference reads that must survive corrupt storage: missing returns
// `undefined` for the normalizer to default; corrupt logs an explicit repair
// and also returns `undefined`. Callers never see StorageError here —
// boot-critical game data (repository, snapshot) lets it throw instead.
export function readPreference<T>(key: string): T | undefined {
  try {
    return readStorage<T>(key);
  } catch (error) {
    if (error instanceof StorageError) {
      console.warn(`maia-board: corrupt preference for ${error.key}; using defaults.`);
      return undefined;
    }
    throw error;
  }
}
