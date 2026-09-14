import type { Route } from '@playwright/test';

// Server-owned cache identity uses the complete transport request. Legacy
// opaque client coordinates intentionally have no role in these fixtures.
export function evaluationIdentity(engine: 'sf' | 'maia', body: any): string {
  return JSON.stringify([engine, body.fen, body.initial_fen, body.moves,
    engine === 'sf' ? body.settings : [body.elo_maia, body.elo_user, body.model]]);
}

export class EvaluationFixture {
  readonly entries = new Map<string, { engine: 'sf' | 'maia'; value: unknown }>();
  get(engine: 'sf' | 'maia', body: any) { return this.entries.get(evaluationIdentity(engine, body)); }
  set(engine: 'sf' | 'maia', body: any, value: unknown) { this.entries.set(evaluationIdentity(engine, body), { engine, value }); }
  async lookup(route: Route, delay = 0): Promise<boolean> {
    if (new URL(route.request().url()).pathname !== '/evaluations/lookup') return false;
    if (route.request().method() !== 'POST') throw new Error('Lookup must use POST');
    const { requests } = route.request().postDataJSON();
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    const results = requests.flatMap((body: any, index: number) => {
      const hit = this.get(body.engine, body);
      return hit ? [{ index, value: hit.value }] : [];
    });
    await route.fulfill({ json: { results } });
    return true;
  }
}
