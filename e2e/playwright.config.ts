import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.FORESIGHT_E2E_PORT || 4188)
const baseURL = `http://127.0.0.1:${port}`

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: 'node server.mjs',
    url: `${baseURL}/health`,
    timeout: 20_000,
    reuseExistingServer: false,
    env: { FORESIGHT_E2E_PORT: String(port) },
  },
  projects: [
    {
      name: 'clerk-setup',
      testMatch: /global\.setup\.ts/,
    },
    {
      name: 'guest',
      testIgnore: [/global\.setup\.ts/, /auth[\\/]/],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'clerk-auth',
      testMatch: /auth[\\/].*\.spec\.ts/,
      dependencies: ['clerk-setup'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
