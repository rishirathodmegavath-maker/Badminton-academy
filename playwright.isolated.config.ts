import { defineConfig } from "@playwright/test";

/**
 * Browser tests that create and edit records. They run ONLY against a disposable application instance:
 *   - E2E_DISPOSABLE=true must be set on purpose,
 *   - E2E_BASE_URL must be a loopback address that is not the development server (port 3100).
 * The instance must be started from a copy of the project with its own LOCAL_DATABASE_PATH (never `.data/development`)
 * and seeded with scripts/seed*.ts + scripts/seed-e2e-roles.ts. Nothing here reads `.env.local`; the caller passes the
 * disposable instance's variables explicitly (for example `node --env-file=<copy>/.env.local ...`).
 */
const base = process.env.E2E_BASE_URL;
if (process.env.E2E_DISPOSABLE !== "true" || !base)
  throw new Error(
    "Isolated browser tests need E2E_DISPOSABLE=true and E2E_BASE_URL (a disposable instance).",
  );
const url = new URL(base);
if (
  !["127.0.0.1", "localhost"].includes(url.hostname) ||
  url.port === "3100" ||
  url.port === ""
)
  throw new Error(
    `Refusing ${base}: the isolated tests only target a disposable loopback instance, never port 3100.`,
  );

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["training-draft.spec.ts", "payment-attempts.spec.ts", "coach-handover.spec.ts", "calendar-series.spec.ts", "phase9-family.spec.ts", "owner-step-up.spec.ts", "phase9-navigation.spec.ts", "monthly-report.spec.ts", "batch-reports.spec.ts", "dispatch-reports.spec.ts", "redesign.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    actionTimeout: 30_000,
    baseURL: base,
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  reporter: "list",
});
