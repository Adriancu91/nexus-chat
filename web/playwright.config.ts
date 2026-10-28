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
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        channel,
        // Cameră și microfon simulate pentru testele de apel.
        permissions: ['camera', 'microphone'],
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--allow-loopback-in-peer-connection'] },
      },
      testIgnore: /mobile\.spec\.ts/,
    },
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
      // Al doilea backend: releu TURN activ, pentru testul apelurilor prin releu.
      command: 'node e2e/start-backend.mjs',
      url: `http://127.0.0.1:${BACKEND_PORT + 1}/api/health`,
      env: { NEXUS_ALLOWED_ORIGINS: WEB_ORIGIN, E2E_BACKEND_PORT: String(BACKEND_PORT + 1), E2E_VARIANT: 'relay' },
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
