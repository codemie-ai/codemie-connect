import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: 'http://localhost:8934',
    screenshot: 'on',
  },
  webServer: {
    command: 'node static-server.mjs',
    port: 8934,
    reuseExistingServer: false,
  },
});
