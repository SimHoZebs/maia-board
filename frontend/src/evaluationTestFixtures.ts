import { Chess } from 'chess.js';
import type { MaiaModel, MoveResponse } from './api';
import type { Evaluation } from './reviewMetrics';
import { stockfishPolicy, defaultStockfishSettings, type StockfishSettings } from './stockfishSettings';

export function sfFixture(fen: string, settings: StockfishSettings = defaultStockfishSettings): Evaluation {
  const moves = new Chess(fen).moves({ verbose: true }).slice(0, settings.lines);
  const lines = moves.map((move, index) => ({ move: `${move.from}${move.to}${move.promotion ?? ''}`, score: { type: 'cp' as const, value: 20 - index * 10 }, depth: 12 }));
  return { engine: 'Stockfish 19', search_policy: stockfishPolicy(settings), terminal: null, depth: 12, best_move: lines[0].move, score: lines[0].score, lines };
}
export function maiaFixture(fen: string, model: MaiaModel = '79m', degraded = false): MoveResponse {
  const candidates = new Chess(fen).moves({ verbose: true }).slice(0, 2).map(move => `${move.from}${move.to}${move.promotion ?? ''}`);
  return { move: candidates[0], top_moves: candidates.map(move => ({ move, prob: 0.3, wdl: [0.2, 0.3, 0.5] as [number, number, number] })), wdl: [0.2, 0.3, 0.5], model_used: model, degraded };
}
export const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
