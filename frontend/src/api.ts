import { Chess } from 'chess.js';
import { fetchJsonWithBusyRetry } from './evaluationTransport';
import { isRecord } from './guards';
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
  wdl: [number, number, number];
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
  | 'superseded'
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

function isModel(value: unknown): value is MaiaModel {
  return value === '79m' || value === '5m';
}

const uci = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

function isTopMove(value: unknown): value is TopMove {
  return isRecord(value) && typeof value.move === 'string' && uci.test(value.move) && probability(value.prob) && isWdlTuple(value.wdl);
}

function isTopMoves(value: unknown): value is TopMove[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 5 && value.every(isTopMove)
    && new Set(value.map(candidate => candidate.move)).size === value.length;
}

function isWdlTuple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every(probability)
    && Math.abs(value.reduce((sum: number, part: number) => sum + part, 0) - 1) <= 1e-6;
}

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
  if (!isTopMoves(value.top_moves)) {
    throw new MaiaApiError('unknown', 'Maia returned invalid candidate moves.');
  }
  const candidates = value.top_moves;
  const sum = candidates.reduce((total, candidate) => total + candidate.prob, 0);
  if (sum <= 0 || sum > 1.000001 || candidates.some((candidate, index) => index > 0 && candidate.prob > candidates[index - 1].prob + 1e-7)) throw new MaiaApiError('unknown', 'Maia returned invalid candidate probabilities.');
  if (!isWdlTuple(value.wdl)) {
    throw new MaiaApiError('unknown', 'Maia returned invalid WDL data.');
  }
  const wdl = value.wdl;
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
    top_moves: candidates,
    wdl,
    model_used: value.model_used,
    degraded: value.degraded,
  };
}

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'engine_busy', 'engine_unavailable', 'game_over', 'history_too_long', 'invalid_elo',
  'invalid_fen', 'invalid_initial_fen', 'invalid_json', 'invalid_maia_color',
  'invalid_model', 'invalid_move', 'invalid_position', 'invalid_request',
  'method_not_allowed', 'missing_elo', 'not_maia_turn', 'position_mismatch',
  'server_unreachable', 'superseded', 'unknown',
]);

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && KNOWN_ERROR_CODES.has(value);
}

export function parseErrorCode(value: unknown): ApiErrorCode {
  if (!isRecord(value)) return 'unknown';
  return isApiErrorCode(value.code) ? value.code : 'unknown';
}

export type RequestPriority = 'play' | 'focus';

export async function requestMove(payload: MoveRequest, fetchImpl: FetchLike = fetch, signal?: AbortSignal, _opts?: { priority?: RequestPriority }): Promise<MoveResponse & { cached?: boolean }> {
  // Lane is endpoint-implied (POST /move → Play): no X-Priority header.
  // superseded/503 codes flow through unchanged via the shared helper.
  let response: Response;
  let body: unknown;
  try {
    ({ response, body } = await fetchJsonWithBusyRetry(fetchImpl, '/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, signal));
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError' && signal?.aborted))) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    if (error instanceof MaiaApiError) throw error;
    throw new MaiaApiError('server_unreachable', 'The Maia server could not be reached.');
  }
  if (body === null || body === undefined) {
    // fetchJson returns null only when the body was unreadable; an abort
    // surfaces as AbortError above, so this is a genuine wire error.
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new MaiaApiError('unknown', 'The Maia server returned unreadable data.', response!.status);
  }
  if (!response.ok) {
    const code = parseErrorCode(body);
    const message = isRecord(body) && typeof body.message === 'string' ? body.message : 'The Maia server rejected this position.';
    throw new MaiaApiError(code, message, response.status);
  }
  const parsed = parseMoveResponse(body, payload);
  return response.headers.get('X-Eval-Cache') === 'hit' ? { ...parsed, cached: true } : parsed;
}

export function readableApiError(error: unknown): string {
  if (!(error instanceof MaiaApiError)) return 'Something went wrong while contacting Maia.';
  switch (error.code) {
    case 'server_unreachable':
    case 'engine_unavailable':
      return 'Maia is unreachable. Check that the server is running on your LAN.';
    case 'engine_busy':
      return 'Maia is busy. Wait a moment and try again.';
    case 'superseded':
      return 'A newer request replaced this position.';
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
