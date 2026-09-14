import { defineConfig } from '@playwright/test';

// Opt-in client-simulation instance for frontend performance debugging.
// Excluded from the default `playwright.config.ts` run on purpose: one
// scenario, one worker, always traced. Run with `npm run test:perf`.
export default defineConfig({
  testDir: './tests/perf',
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    // Off by default: the metrics JSON is the artifact, and trace
    // finalization flakes context teardown (ENOENT) on long runs, turning
    // green runs red after the body already passed. Re-enable per-run with
    // `npx playwright test -c playwright.perf.config.ts --trace on` when a
    // failure needs frame-by-frame diagnosis.
    trace: 'off',
  },
});
