import assert from "node:assert/strict";
import type { Harness } from "./harness";
import type { TestClient } from "./client";
import { FIXTURE_PASSWORD } from "./fixtures";
import { signedIn, AUTH } from "./accounts";
import { parseProvisioningUri, totpAt, type ProvisioningUri } from "./totp";
export const TF = `${AUTH}/two-factor`;
/**
 * Authenticator codes for the current step and the one either side are all accepted, and each may
 * be presented once. This hands out distinct valid codes per account (offsets 0, +1, -1) so a
 * scenario can sign in more than once. It first waits out the last seconds of a 30-second step so
 * a boundary cannot invalidate a code between computing it and using it.
 */
export async function stableWindow(marginMs = 4000) {
  const into = Date.now() % 30_000;
  if (into > 30_000 - marginMs)
    await new Promise((r) => setTimeout(r, 30_000 - into + 150));
}
export type Enrolled = {
  id: string;
  email: string;
  uri: ProvisioningUri;
  backupCodes: string[];
  /** A code valid right now that this authenticator has not presented before. */
  code(): string;
  used: Set<string>;
};
const OFFSETS = [0, 1, -1];
export async function enroll(
  app: Harness,
  user: { id: string; email: string },
  password = FIXTURE_PASSWORD,
): Promise<Enrolled & { client: TestClient }> {
  await stableWindow();
  const client = await signedIn(app, user.email, password);
  const enable = await client.post(`${TF}/enable`, { password });
  assert.equal(enable.status, 200, enable.text);
  const body = enable.json as { totpURI: string; backupCodes: string[] };
  const uri = parseProvisioningUri(body.totpURI);
  const enrolled: Enrolled = {
    id: user.id,
    email: user.email,
    uri,
    backupCodes: body.backupCodes,
    used: new Set<string>(),
    code() {
      // Computed at call time and compared with what was already presented, so a step boundary
      // crossed mid-scenario can never make the helper hand out a code twice.
      for (const offset of OFFSETS) {
        const candidate = totpAt(uri.secret, offset);
        if (!this.used.has(candidate)) {
          this.used.add(candidate);
          return candidate;
        }
      }
      throw new Error("out of distinct valid codes for this authenticator");
    },
  };
  const verify = await client.post(`${TF}/verify-totp`, { code: enrolled.code() });
  assert.equal(verify.status, 200, `activation: ${verify.text}`);
  // Activation replaces the session; the new cookie works.
  assert.equal((await client.get("/api/academy/identity")).status, 200);
  return Object.assign(enrolled, { client });
}
/** Password sign-in for an enrolled account: returns the pending-challenge client. */
export async function startChallenge(
  app: Harness,
  email: string,
  password = FIXTURE_PASSWORD,
) {
  const client = app.anonymous();
  const step1 = await client.signIn(email, password);
  return { client, step1 };
}
export const twoFactorRedirect = (r: { json: unknown }) =>
  (r.json as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect === true;
