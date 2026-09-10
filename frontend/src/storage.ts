import { normalizeSettings, replay, type Settings, type StoredGame } from './domain';

export const KEYS = { settings: 'maia-board.settings.v1', current: 'maia-board.current-game.v1', saved: 'maia-board.saved-games.v1', analysis: 'maia-board.analysis.v1' };
export function readStorage<T>(key: string): T | undefined {
  try { const value = localStorage.getItem(key); return value ? JSON.parse(value) as T : undefined; }
  catch { return undefined; }
}
export function writeStorage(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage availability must not block play. */ }
}
export function restoreGame(value: unknown): StoredGame | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Partial<StoredGame>;
  if (typeof record.id !== 'string' || !Array.isArray(record.moves) || !record.moves.every(move => typeof move === 'string')) return;
  try {
    replay(record.moves);
    return { id: record.id, moves: record.moves, createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date(0).toISOString(), settings: normalizeSettings(record.settings) };
  } catch { return; }
}
export function loadSaved(): StoredGame[] {
  const raw = readStorage<unknown>(KEYS.saved);
  return Array.isArray(raw) ? raw.map(restoreGame).filter((game): game is StoredGame => !!game).slice(0, 8) : [];
}
export function loadSettings(): Settings { return normalizeSettings(readStorage<Partial<Settings>>(KEYS.settings)); }
