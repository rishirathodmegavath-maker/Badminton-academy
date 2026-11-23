import assert from "node:assert/strict";
import test from "node:test";
import { enforceSecurityConfigAtStartup } from "../src/modules/identity/startup-guard";

const quiet = { warn() {}, info() {}, error() {} };
const GOOD = {
  NODE_ENV: "production",
  BETTER_AUTH_SECRET: "k9Qz3vL1mX8pR2wT6yB4nC7dF0hJ5sA9uE2gI8oM",
  BETTER_AUTH_URL: "https://app.example.org",
  DATABASE_URL: "postgres://u:p@db.internal:5432/app",
  TRUSTED_PROXIES: "10.0.0.1",
};

test("production start-up with an unsafe configuration ends the process with a non-zero code (it does not linger)", () => {
  const codes: number[] = [];
  const lines: string[] = [];
  enforceSecurityConfigAtStartup({ ...GOOD, DATABASE_URL: "", BETTER_AUTH_SECRET: "LeakCanary9" }, { ...quiet, error: (m: string) => lines.push(m) }, (c) => codes.push(c));
  assert.deepEqual(codes, [1]);
  assert.ok(lines.some((l) => /DATABASE_URL: Is required in production/.test(l)), "the value-free finding is printed");
  assert.ok(lines.some((l) => /will not start/.test(l)));
  // a value from the environment never reaches the output
  assert.ok(!lines.join(" ").includes("LeakCanary9"));
});

test("a safe production configuration, and any development configuration, start normally (no exit)", () => {
  const codes: number[] = [];
  enforceSecurityConfigAtStartup(GOOD, quiet, (c) => codes.push(c));
  enforceSecurityConfigAtStartup({ NODE_ENV: "development", BETTER_AUTH_SECRET: "short", BETTER_AUTH_URL: "http://127.0.0.1:3100" }, quiet, (c) => codes.push(c));
  assert.deepEqual(codes, []);
});
