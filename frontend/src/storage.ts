import { normalizeSettings, replay, type Settings, type StoredGame } from './domain';

export const KEYS = { settings: 'maia-board.settings.v1', current: 'maia-board.current-game.v1', saved: 'maia-board.saved-games.v1', analysis: 'maia-board.analysis.v1', snapshot: 'maia-board.analysis-snapshot.v1', feedback: 'maia-board.feedback.v1', badgeLoading: 'maia-board.badge-loading.v1' };
export function readStorage<T>(key: string): T | undefined {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : undefined; }
  catch { return undefined; }
}
export function writeStorage(key: string, value: unknown): Error | undefined {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch (cause) { return new Error(`Local storage is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`); }
}
export function restoreGame(value: unknown): StoredGame | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Partial<StoredGame>;
  if (typeof record.id !== 'string' || !Array.isArray(record.moves) || !record.moves.every(move => typeof move === 'string')) return;
  try {
    replay(record.moves);
    return { id: record.id, moves: record.moves, createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(), settings: normalizeSettings(record.settings), ...(record.result === 'resigned' ? { result: 'resigned' as const } : {}) };
  } catch { return; }
}
export function loadSaved(): StoredGame[] {
  const raw = readStorage<unknown>(KEYS.saved);
  return Array.isArray(raw) ? raw.map(restoreGame).filter((game): game is StoredGame => !!game) : [];
}
export function loadSettings(): Settings { return normalizeSettings(readStorage<Partial<Settings>>(KEYS.settings)); }
