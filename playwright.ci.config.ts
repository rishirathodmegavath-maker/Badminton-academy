import { defineConfig } from "@playwright/test";
import { missingSpecEnvironment, profileByName } from "./scripts/lib/e2e-profiles";

/**
 * Browser tests for ONE profile (see scripts/lib/e2e-profiles.ts), against the disposable server that scripts/e2e-ci.ts started
 * for it. It is not meant to be run by hand: the runner sets E2E_PROFILE and the environment the profile declares, and a missing
 * piece is an error here, never a reason to skip tests.
 *
 *   no retries    a test that needs a second chance is a flaky test, and a retry would hide it
 *   forbidOnly    a stray test.only cannot quietly shrink the run
 *   one worker    the specs share one database and one sign-in rate limit on purpose
 */
const name = process.env.E2E_PROFILE;
if (!name) throw new Error("playwright.ci.config.ts is run by scripts/e2e-ci.ts, which sets E2E_PROFILE.");
const profile = profileByName(name);
const missing = missingSpecEnvironment(profile, process.env);
if (missing.length) throw new Error(`Profile "${profile.name}" is missing: ${missing.join(", ")}.`);

const base = process.env.E2E_BASE_URL!;
const url = new URL(base);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || ["", "3100", "3200", "3300"].includes(url.port) || Number(url.port) !== profile.port)
  throw new Error(`Refusing ${base}: profile "${profile.name}" runs only against its own disposable loopback server (port ${profile.port}).`);
if (process.env.E2E_DISPOSABLE !== "true") throw new Error("E2E_DISPOSABLE=true is required.");

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: profile.specs.map((s) => s.replace(/^tests\/e2e\//, "")),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  outputDir: process.env.E2E_OUTPUT_DIR || "test-results",
  use: {
    actionTimeout: 30_000,
    baseURL: base,
    channel: "chrome",
    headless: true,
    trace: "retain-on-failure",
  },
  reporter: [["list"], ["json"]],
});
