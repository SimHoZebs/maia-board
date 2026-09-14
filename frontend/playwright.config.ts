import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testIgnore: /perf/,
  fullyParallel: true, workers: 2,
  use: { browserName: 'chromium', headless: true, viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
