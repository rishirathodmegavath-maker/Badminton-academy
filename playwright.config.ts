import { defineConfig } from "@playwright/test";
process.loadEnvFile(".env.local");
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 60_000 },
  use: {
    actionTimeout: 30_000,
    baseURL: process.env.BETTER_AUTH_URL || "http://127.0.0.1:3100",
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  reporter: "list",
});
