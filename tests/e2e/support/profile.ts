import { test } from "@playwright/test";

/**
 * Ties a spec to the browser-test PROFILE that provides what it needs (scripts/lib/e2e-profiles.ts).
 *
 * Under the profile runner (E2E_PROFILE is set) a missing precondition is an ERROR: the run fails and says what the profile should
 * have provided, so a test can never pass or "skip" its way past a server that is not configured for it. Outside the runner, on a
 * developer's own server, the test is skipped with the reason, as these specs always were.
 */
export function configured(condition: boolean, reason: string) {
  if (condition) return;
  const profile = process.env.E2E_PROFILE;
  if (profile) throw new Error(`Profile "${profile}" did not provide what these tests need: ${reason}`);
  test.skip(true, reason);
}
