import { defineConfig, devices } from '@playwright/test';

const testDataDir = process.env.NOURA_TEST_DATA_DIR ?? `/tmp/noura-playwright-${process.pid}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5180',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run server',
      url: 'http://localhost:8790/version',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...process.env,
        NOURA_PORT: '8790',
        NOURA_DATA_DIR: testDataDir,
        NOURA_DEPLOYMENT_MODE: 'local-synthetic',
        NOURA_SYNTHETIC_ONLY: 'true',
        NOURA_ALLOWED_ORIGINS: 'http://localhost:5180,http://localhost:8790',
      },
    },
    {
      command: 'npm run client -- --port 5180',
      url: 'http://localhost:5180',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { ...process.env, NOURA_BACKEND_PORT: '8790' },
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
