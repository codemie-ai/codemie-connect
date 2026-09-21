import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: 'http://localhost:8941',
    screenshot: 'on',
  },
  webServer: {
    command: 'node static-server.mjs',
    port: 8941,
    reuseExistingServer: false,
  },
});
