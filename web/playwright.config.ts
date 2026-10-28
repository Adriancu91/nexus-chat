import { defineConfig, devices } from '@playwright/test';

const BACKEND_PORT = 18788;
const WEB_PORT = 4174;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;
// Local se folosește Chrome-ul instalat (fără descărcări); în CI, Chromium-ul Playwright.
const channel = process.env.CI ? undefined : 'chrome';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    baseURL: WEB_ORIGIN,
    locale: 'ro-RO',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobil', use: { ...devices['Pixel 7'], channel }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: [
    {
      command: 'node e2e/start-backend.mjs',
      url: `http://127.0.0.1:${BACKEND_PORT}/api/health`,
      env: { NEXUS_ALLOWED_ORIGINS: WEB_ORIGIN, E2E_BACKEND_PORT: String(BACKEND_PORT) },
      reuseExistingServer: false,
      stdout: 'ignore',
    },
    {
      command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
      url: WEB_ORIGIN,
      env: { VITE_BACKEND_URL: `http://127.0.0.1:${BACKEND_PORT}` },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
