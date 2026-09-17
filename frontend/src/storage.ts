import { normalizeSettings, replay, type Settings, type StoredGame } from './domain';
import { isRecord, isStringArray } from './guards';

export const KEYS = { settings: 'maia-board.settings.v1', current: 'maia-board.current-game.v1', saved: 'maia-board.saved-games.v1', analysis: 'maia-board.analysis.v1', snapshot: 'maia-board.analysis-snapshot.v1', feedback: 'maia-board.feedback.v1', badgeLoading: 'maia-board.badge-loading.v1', coordinatesOnSquares: 'maia-board.coordinates-on-squares.v1', boardOrientation: 'maia-board.board-orientation.v1' };
export function readStorage<T>(key: string): T | undefined {
  // Quarantined JSON boundary: JSON.parse() returns `any`, which flows into
  // the generic without an assertion. Every caller validates downstream —
  // restoreGame (saved/current games), normalizeSettings (settings),
  // normalizeStockfishSettings / === true checks (state.ts), and key-specific
  // narrowing (useMaiaBoard.ts) — so no `as` cast is needed or allowed here.
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) : undefined; }
  catch { return undefined; }
}
export function writeStorage(key: string, value: unknown): Error | undefined {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (cause) { return new Error(`Local storage is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`); }
}
// Narrows unvalidated storage JSON to normalizeSettings' input without
// asserting: only values normalizeSettings can distinguish pass through (its
// own per-field fallbacks decide the rest), so behavior is unchanged.
function toSettingsInput(value: unknown): Partial<Settings> | undefined {
  if (!isRecord(value)) return undefined;
  const input: Partial<Settings> = {};
  const { userColor, model, eloMaia, eloUser, temperature } = value;
  if (userColor === 'black' || userColor === 'white') input.userColor = userColor;
  if (model === '5m' || model === '79m') input.model = model;
  if (typeof eloMaia === 'number') input.eloMaia = eloMaia;
  if (typeof eloUser === 'number') input.eloUser = eloUser;
  if (typeof temperature === 'number') input.temperature = temperature;
  return input;
}
export function restoreGame(value: unknown): StoredGame | undefined {
  if (!isRecord(value)) return;
  const { id, moves, createdAt, settings, result } = value;
  if (typeof id !== 'string' || !isStringArray(moves)) return;
  try {
    replay(moves);
    return { id, moves, createdAt: typeof createdAt === 'string' ? createdAt : new Date(0).toISOString(), settings: normalizeSettings(toSettingsInput(settings)), ...(result === 'resigned' ? { result: 'resigned' as const } : {}) };
  } catch { return; }
}
export function loadSaved(): StoredGame[] {
  const raw = readStorage<unknown>(KEYS.saved);
  return Array.isArray(raw) ? raw.map(restoreGame).filter((game): game is StoredGame => !!game) : [];
}
export function loadSettings(): Settings { return normalizeSettings(readStorage<Partial<Settings>>(KEYS.settings)); }
