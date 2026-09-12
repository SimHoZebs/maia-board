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
  // Opaque read-through coordinates (see reviewCoordinator.maiaCacheKeyForMoveRequest):
  // the backend serves a matching cached row or computes live and stores it.
  cache_hash?: string;
  cache_key?: string;
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

export function parseMoveResponse(value: unknown): MoveResponse {
  if (!isRecord(value) || typeof value.move !== 'string' || !isModel(value.model_used) || typeof value.degraded !== 'boolean') {
    throw new MaiaApiError('unknown', 'Maia returned an incomplete response.');
  }
  if (!Array.isArray(value.top_moves) || !value.top_moves.every((candidate) => isRecord(candidate) && typeof candidate.move === 'string' && typeof candidate.prob === 'number')) {
    throw new MaiaApiError('unknown', 'Maia returned invalid candidate moves.');
  }
  if (!Array.isArray(value.wdl) || value.wdl.length !== 3 || !value.wdl.every((part) => typeof part === 'number' && Number.isFinite(part))) {
    throw new MaiaApiError('unknown', 'Maia returned invalid WDL data.');
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
  const post = async (coordinates: boolean): Promise<Response> => {
    const { cache_hash: _hash, cache_key: _key, ...rest } = payload;
    try {
      return await fetchImpl('/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(coordinates ? payload : rest),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        throw new DOMException('Aborted', 'AbortError');
      }
      throw new MaiaApiError('server_unreachable', 'The Maia server could not be reached.');
    }
  };
  const read = async (response: Response): Promise<{ parsed: MoveResponse; hit: boolean }> => {
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
    return { parsed: parseMoveResponse(body), hit: response.headers.get('X-Eval-Cache') === 'hit' };
  };
  const hasCoordinates = payload.cache_hash !== undefined || payload.cache_key !== undefined;
  const first = await post(hasCoordinates);
  try {
    const { parsed, hit } = await read(first);
    // Read-through backends mark served rows; absence means live inference
    // (or an older backend without the header).
    if (hit) return { ...parsed, cached: true as const };
    return parsed;
  } catch (error) {
    // A served row that fails validation is poison (e.g. a lax legacy PUT):
    // fall back to live inference once. The coord-less retry files nothing
    // server-side, so write the validated live result back explicitly to heal
    // the row (never degraded stand-ins); other failures propagate as-is.
    if (!hasCoordinates || first.headers.get('X-Eval-Cache') !== 'hit') throw error;
    const { parsed } = await read(await post(false));
    if (!parsed.degraded) {
      const { cache_hash: hash, cache_key: key } = payload;
      void (async () => {
        try {
          await fetchImpl(`/evaluations/${hash}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ engine: 'maia', key, value: parsed }),
          });
        } catch {
          // Best-effort: the live game continues regardless.
        }
      })();
    }
    return parsed;
  }
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
