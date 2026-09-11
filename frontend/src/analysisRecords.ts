import { Chess } from 'chess.js';
import type { MaiaModel } from './api';
import { cacheHash, MAIA_REF } from './reviewCoordinator';
import { stockfishPolicy, type StockfishSettings } from './stockfishSettings';

// Whole-line completion records. The line hash covers normalized initial FEN
// plus UCI moves, so History games and pasted PGNs share records without game
// rows. Settings are part of freshness because Maia output differs per Elo and
// model; Stockfish cache keys ignore ratings, so post-change restores still
// hit its cache and only Maia re-infers.
export type RecordSettings = { eloMaia: number; eloUser: number; model: MaiaModel; stockfish?: StockfishSettings };
export type AnalysisRecord = {
  line_hash: string;
  settings: { elo_maia: number; elo_user: number; model: string; search_policy: string; maia_ref: string };
  positions: number; failed: number; completed_at: string;
};
export const ANALYSES_BATCH_LIMIT = 200;

export function lineHash(initialFen: string, moves: string[]): string {
  return cacheHash(JSON.stringify([new Chess(initialFen).fen(), moves]));
}

export function recordSettings(settings: RecordSettings): AnalysisRecord['settings'] {
  return { elo_maia: settings.eloMaia, elo_user: settings.eloUser, model: settings.model, search_policy: stockfishPolicy(settings.stockfish), maia_ref: MAIA_REF };
}

export function isFreshRecord(record: AnalysisRecord, settings: RecordSettings): boolean {
  const want = recordSettings(settings);
  return record.failed === 0 && record.settings.elo_maia === want.elo_maia && record.settings.elo_user === want.elo_user &&
    record.settings.model === want.model && record.settings.search_policy === want.search_policy && record.settings.maia_ref === want.maia_ref;
}

async function readRecords(response: Response): Promise<AnalysisRecord[]> {
  // Version skew (a server predating /analyses serves the SPA fallback HTML
  // here) must degrade to "no record", never to a stuck checking state.
  if (!response.ok) throw new Error(`Analysis records request failed (${response.status}).`);
  let body: unknown;
  try { body = await response.json(); }
  catch { return []; }
  const records = (body as { analyses?: unknown }).analyses;
  return Array.isArray(records) ? records.filter((record): record is AnalysisRecord => !!record && typeof record === 'object') : [];
}

export async function getAnalysisRecords(hashes: string[], fetchImpl: typeof fetch = fetch): Promise<AnalysisRecord[]> {
  const found: AnalysisRecord[] = [];
  for (let at = 0; at < hashes.length; at += ANALYSES_BATCH_LIMIT) {
    const query = hashes.slice(at, at + ANALYSES_BATCH_LIMIT).map(hash => `line=${encodeURIComponent(hash)}`).join('&');
    found.push(...await readRecords(await fetchImpl(`/analyses?${query}`)));
  }
  return found;
}

export async function putAnalysisRecord(lineHashValue: string, settings: RecordSettings, positions: number, failed: number, fetchImpl: typeof fetch = fetch): Promise<AnalysisRecord> {
  const response = await fetchImpl(`/analyses/${lineHashValue}`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: recordSettings(settings), positions, failed }) });
  if (!response.ok) throw new Error(`Analysis records request failed (${response.status}).`);
  return (await response.json()) as AnalysisRecord;
}
