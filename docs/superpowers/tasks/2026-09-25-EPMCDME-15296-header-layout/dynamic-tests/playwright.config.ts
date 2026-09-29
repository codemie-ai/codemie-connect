import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: 'http://localhost:8935',
    screenshot: 'on',
  },
  webServer: {
    command: 'node static-server.mjs',
    port: 8935,
    reuseExistingServer: false,
  },
});
