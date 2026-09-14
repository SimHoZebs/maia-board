import { Chess } from 'chess.js';
import { retryBusy, withDeadline } from './evaluationTransport';
export type MaiaColor = 'white' | 'black';
export type MaiaModel = '79m' | '5m';

export type MoveRequest = {
  fen: string;
  moves: string[];
  elo_maia: number;
  elo_user: number;
  model: MaiaModel;
  maia_color: MaiaColor;
  initial_fen?: string;
  temperature?: number;
};

export type TopMove = {
  move: string;
  prob: number;
};

export type MoveResponse = {
  move: string;
  top_moves: TopMove[];
  wdl: [number, number, number];
  model_used: MaiaModel;
  degraded: boolean;
};

export type ApiErrorCode =
  | 'engine_busy'
  | 'engine_unavailable'
  | 'game_over'
  | 'history_too_long'
  | 'invalid_elo'
  | 'invalid_fen'
  | 'invalid_initial_fen'
  | 'invalid_json'
  | 'invalid_maia_color'
  | 'invalid_model'
  | 'invalid_move'
  | 'invalid_position'
  | 'invalid_request'
  | 'method_not_allowed'
  | 'missing_elo'
  | 'not_maia_turn'
  | 'position_mismatch'
  | 'server_unreachable'
  | 'unknown';

export class MaiaApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status?: number;

  constructor(code: ApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'MaiaApiError';
    this.code = code;
    this.status = status;
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isModel(value: unknown): value is MaiaModel {
  return value === '79m' || value === '5m';
}

const uci = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
// Single legality source for engine responses. Returns the legal set; callers
// throw their own domain error (MaiaApiError vs incomplete-evaluation Error)
// so wire error types stay unchanged.
export function legalUciSet(fen: string): Set<string> {
  return new Set(new Chess(fen).moves({ verbose: true }).map(move => `${move.from}${move.to}${move.promotion ?? ''}`));
}
export function assertLegalUci(moves: string[], fen: string): void {
  const legal = legalUciSet(fen);
  for (const move of moves) if (!legal.has(move)) throw new Error(`Illegal UCI move: ${move}`);
}
export function parseMoveResponse(value: unknown, expected?: { model: MaiaModel; fen: string; temperature?: number }): MoveResponse {
  if (!isRecord(value) || typeof value.move !== 'string' || !uci.test(value.move) || !isModel(value.model_used) || typeof value.degraded !== 'boolean') {
    throw new MaiaApiError('unknown', 'Maia returned an incomplete response.');
  }
  if (!Array.isArray(value.top_moves) || !value.top_moves.length || value.top_moves.length > 5 || !value.top_moves.every((candidate) => isRecord(candidate) && typeof candidate.move === 'string' && uci.test(candidate.move) && probability(candidate.prob)) || new Set(value.top_moves.map(candidate => candidate.move)).size !== value.top_moves.length) {
    throw new MaiaApiError('unknown', 'Maia returned invalid candidate moves.');
  }
  const candidates = value.top_moves as TopMove[];
  const sum = candidates.reduce((total, candidate) => total + candidate.prob, 0);
  if (sum <= 0 || sum > 1.000001 || candidates.some((candidate, index) => index > 0 && candidate.prob > candidates[index - 1].prob + 1e-7)) throw new MaiaApiError('unknown', 'Maia returned invalid candidate probabilities.');
  if (!Array.isArray(value.wdl) || value.wdl.length !== 3 || !value.wdl.every(probability) || Math.abs(value.wdl.reduce((sum, part) => sum + part, 0) - 1) > 1e-6) {
    throw new MaiaApiError('unknown', 'Maia returned invalid WDL data.');
  }
  if (expected) {
    if (value.model_used !== expected.model && !(expected.model === '79m' && value.model_used === '5m' && value.degraded)) throw new MaiaApiError('unknown', 'Maia returned a different model.');
    if (value.degraded !== (value.model_used !== expected.model)) throw new MaiaApiError('unknown', 'Maia returned inconsistent fallback identity.');
    if (!expected.temperature && value.move !== candidates[0].move) {
      // Upstream argmax and topk may order equal logits differently. Preserve
      // its selected move when the highest policies tie, mirroring the
      // backend's deterministic validation (including a full 5-way tie whose
      // selected move can fall outside the listed ranks).
      const selected = candidates.find(candidate => candidate.move === value.move);
      const tied = selected ? Math.abs(selected.prob - candidates[0].prob) <= 1e-7
        : candidates.length === 5 && Math.abs(candidates[4].prob - candidates[0].prob) <= 1e-7;
      if (!tied) throw new MaiaApiError('unknown', 'Maia returned an inconsistent selected move.');
    }
    try { assertLegalUci([value.move, ...value.top_moves.map(candidate => candidate.move)], expected.fen); }
    catch { throw new MaiaApiError('unknown', 'Maia returned an illegal candidate move.'); }
  }
  return {
    move: value.move,
    top_moves: value.top_moves as TopMove[],
    wdl: value.wdl as [number, number, number],
    model_used: value.model_used,
    degraded: value.degraded,
  };
}

function parseErrorCode(value: unknown): ApiErrorCode {
  if (!isRecord(value) || typeof value.code !== 'string') return 'unknown';
  const known: ApiErrorCode[] = [
    'engine_busy', 'engine_unavailable', 'game_over', 'history_too_long', 'invalid_elo',
    'invalid_fen', 'invalid_initial_fen', 'invalid_json', 'invalid_maia_color',
    'invalid_model', 'invalid_move', 'invalid_position', 'invalid_request',
    'method_not_allowed', 'missing_elo', 'not_maia_turn', 'position_mismatch',
    'server_unreachable', 'unknown',
  ];
  return known.includes(value.code as ApiErrorCode) ? value.code as ApiErrorCode : 'unknown';
}

export async function requestMove(payload: MoveRequest, fetchImpl: FetchLike = fetch, signal?: AbortSignal): Promise<MoveResponse & { cached?: boolean }> {
  return withDeadline(async transportSignal => {
    let response: Response;
    try {
      response = await retryBusy(fetchImpl, '/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, transportSignal);
    } catch (error) {
      if (transportSignal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw new MaiaApiError('server_unreachable', 'The Maia server could not be reached.');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MaiaApiError('unknown', 'The Maia server returned unreadable data.', response.status);
    }
    if (!response.ok) {
      const code = parseErrorCode(body);
      const message = isRecord(body) && typeof body.message === 'string' ? body.message : 'The Maia server rejected this position.';
      throw new MaiaApiError(code, message, response.status);
    }
    const parsed = parseMoveResponse(body, payload);
    return response.headers.get('X-Eval-Cache') === 'hit' ? { ...parsed, cached: true } : parsed;
  }, signal);
}

export function readableApiError(error: unknown): string {
  if (!(error instanceof MaiaApiError)) return 'Something went wrong while contacting Maia.';
  switch (error.code) {
    case 'server_unreachable':
    case 'engine_unavailable':
      return 'Maia is unreachable. Check that the server is running on your LAN.';
    case 'engine_busy':
      return 'Maia is busy. Wait a moment and try again.';
    case 'not_maia_turn':
      return 'Maia is not on move in this position.';
    case 'game_over':
      return 'This position has no legal moves.';
    case 'position_mismatch':
    case 'invalid_fen':
    case 'invalid_initial_fen':
    case 'invalid_move':
    case 'invalid_position':
    case 'history_too_long':
      return 'The position or move history is invalid. Check the FEN and PGN.';
    case 'invalid_elo':
    case 'missing_elo':
      return 'The Elo settings are invalid. Choose both ratings before trying again.';
    case 'invalid_maia_color':
      return 'The Maia side setting is invalid. Choose White or Black and try again.';
    case 'invalid_request':
    case 'invalid_json':
    case 'invalid_model':
    case 'method_not_allowed':
      return 'The Maia server could not read this request.';
    default:
      return error.message;
  }
}
