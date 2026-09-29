import type { Route } from '@playwright/test';

// Server-owned cache identity uses the complete transport request. Legacy
// opaque client coordinates intentionally have no role in these fixtures.
// Understands both wire shapes: singles carry the full prefix, bulk entries
// carry only ply with the line shipping once per POST (resolved the same way
// the server derives its identity coordinates).
export function evaluationIdentity(engine: 'sf' | 'maia', body: any, line?: { initial_fen: string; moves: string[] }): string {
  const moves = body.moves ?? line?.moves.slice(0, body.ply);
  const initialFen = body.initial_fen ?? line?.initial_fen;
  return JSON.stringify([engine, body.fen, initialFen, moves,
    engine === 'sf' ? body.settings : [body.elo_maia, body.elo_user, body.model]]);
}

export class EvaluationFixture {
  readonly entries = new Map<string, { engine: 'sf' | 'maia'; value: unknown }>();
  get(engine: 'sf' | 'maia', body: any, line?: { initial_fen: string; moves: string[] }) { return this.entries.get(evaluationIdentity(engine, body, line)); }
  set(engine: 'sf' | 'maia', body: any, value: unknown, line?: { initial_fen: string; moves: string[] }) { this.entries.set(evaluationIdentity(engine, body, line), { engine, value }); }
  async lookup(route: Route, delay = 0): Promise<boolean> {
    if (new URL(route.request().url()).pathname !== '/evaluations/lookup') return false;
    if (route.request().method() !== 'POST') throw new Error('Lookup must use POST');
    const { line, requests } = route.request().postDataJSON();
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const results = requests.flatMap((body: any, index: number) => {
      const hit = this.get(body.engine, body, line);
      return hit ? [{ index, value: hit.value }] : [];
    });
    await route.fulfill({ json: { results } });
    return true;
  }
}
