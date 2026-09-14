import { defineConfig } from '@playwright/test';

export default defineConfig({
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results/presentation',
  testDir: './tests', testIgnore: /perf/,
  fullyParallel: true, workers: 2,
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
