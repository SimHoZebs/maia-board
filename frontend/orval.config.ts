import { defineConfig } from 'orval';

// Orval reads the Huma-served contract (checked in at spec/openapi.yaml;
// regenerate with `npm run openapi`) and emits zod schemas + inferred
// types. Transport stays hand-written (evaluationTransport's deadlines,
// busy-retry, and cache headers); only SHAPE validation is generated.
// Semantic checks (UCI legality, WDL sums, policy agreement) stay in the
// parse* functions, which run on zod-validated shapes.
export default defineConfig({
  maia: {
    input: '../spec/openapi.yaml',
    output: {
      target: 'src/api/generated/maia.zod.ts',
      client: 'zod',
      override: {
        zod: {
          coerce: false,
          strict: {
            response: true,
            body: true,
            query: true,
            params: true,
            header: false,
          },
        },
      },
    },
  },
});
