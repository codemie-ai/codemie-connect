import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: 'results.json' }]],
  use: {
    baseURL: 'http://localhost:8935',
    screenshot: 'on',
    screenshotsDir: path.join(__dirname, '..', 'evidence', 'screenshots'),
  },
  webServer: {
    command: 'node static-server.mjs',
    port: 8935,
    reuseExistingServer: false,
  },
});
