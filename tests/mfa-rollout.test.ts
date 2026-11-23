import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { accountSecurity } from "../src/modules/identity/account-security";
import { MfaPolicyError } from "../src/modules/identity/mfa-policy";
import { FIXTURE_PASSWORD } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import {
  CHANGE,
  NEW_PASSWORD,
  STATE,
  code,
  events,
  newMember as makeMember,
  reset,
  signedIn as signIn,
  type ResetResult,
} from "./helpers/accounts";
import { TF, enroll as enrollUser, startChallenge, twoFactorRedirect } from "./helpers/mfa";
/**
 * Introducing MFA safely: enforcement is off by default, staged (warn, then enforce), per role,
 * reversible, and a person who is required to enrol can always sign in and enrol, so no account
 * is ever locked out by turning it on. Policy is read per request, so tests flip it in-process.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("mfa-rollout");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    delete process.env.MFA_ENFORCEMENT;
    delete process.env.MFA_REQUIRED_ROLES;
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const newMember = (role: Parameters<typeof makeMember>[0] = "COACH") => makeMember(role, "green", "ro");
const signedIn = (email: string, password = FIXTURE_PASSWORD) => signIn(app, email, password);
async function withPolicy<T>(policy: { mode?: string; roles?: string }, run: () => Promise<T>) {
  const saved = [process.env.MFA_ENFORCEMENT, process.env.MFA_REQUIRED_ROLES];
  const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set("MFA_ENFORCEMENT", policy.mode);
  set("MFA_REQUIRED_ROLES", policy.roles);
  try {
    return await run();
  } finally {
    set("MFA_ENFORCEMENT", saved[0]);
    set("MFA_REQUIRED_ROLES", saved[1]);
  }
}
const state = async (client: Awaited<ReturnType<typeof signedIn>>) =>
  (await client.get(STATE)).json as { gate: string | null; mfa: { mode: string; level: string; required: boolean; enrolmentRequired: boolean }; twoFactorEnabled: boolean };
test("default: MFA is available but required of nobody, so nothing changes for existing users", async () => {
  const owner = await signedIn((await newMember("OWNER")).email);
  const s = await state(owner);
  assert.equal(s.mfa.mode, "off");
  assert.equal(s.mfa.required, false);
  assert.equal(s.gate, null);
  assert.equal((await owner.get("/api/academy")).status, 200);
  // Stray policy roles with the mode off must not enable anything.
  await withPolicy({ mode: "off", roles: "OWNER,ADMIN,COACH" }, async () => {
    assert.equal((await owner.get("/api/academy")).status, 200);
    assert.equal((await state(owner)).mfa.required, false);
  });
});
test("warn: roles are told MFA is expected but keep full access", async () => {
  const owner = await signedIn((await newMember("OWNER")).email);
  const coach = await signedIn((await newMember("COACH")).email);
  await withPolicy({ mode: "warn" }, async () => {
    const s = await state(owner);
    assert.deepEqual(s.mfa, { mode: "warn", level: "warn", required: true, enrolmentRequired: false });
    assert.equal(s.gate, null);
    assert.equal((await owner.get("/api/academy")).status, 200);
    // Approved default: every staff role is told; guardians and adult players are not.
    assert.equal((await state(coach)).mfa.level, "warn");
    const guardian = await signedIn((await newMember("GUARDIAN")).email);
    assert.deepEqual((await state(guardian)).mfa, { mode: "warn", level: "optional", required: false, enrolmentRequired: false });
  });
});
test("enforce: required roles without an authenticator are gated; others are untouched", async () => {
  const admin = await signedIn((await newMember("ADMIN")).email);
  const owner = await signedIn((await newMember("OWNER")).email);
  const coach = await signedIn((await newMember("COACH")).email);
  const guardian = await signedIn((await newMember("GUARDIAN")).email);
  await withPolicy({ mode: "enforce" }, async () => {
    for (const client of [admin, owner]) {
      const blocked = await client.get("/api/academy");
      assert.equal(blocked.status, 403);
      assert.equal(code(blocked), "MFA_ENROLLMENT_REQUIRED");
      assert.equal((await client.get("/api/training")).status, 403);
      assert.equal((await client.post("/api/academy/players/save", {})).status, 403);
      for (const [path, body] of [
        ["/api/auth/update-user", { name: "X" }],
        ["/api/auth/revoke-other-sessions", {}],
        ["/api/auth/two-factor/disable", { password: FIXTURE_PASSWORD }],
        ["/api/auth/two-factor/generate-backup-codes", { password: FIXTURE_PASSWORD }],
        ["/api/auth/account/admin/reset-password", { userId: "x", reason: "xxxxxxxxxxxx", ownerPassword: "x" }],
      ] as const)
        assert.equal((await client.post(path, body)).status, 403, path);
      const s = await state(client);
      assert.equal(s.gate, "MFA_ENROLLMENT_REQUIRED");
      assert.equal(s.mfa.enrolmentRequired, true);
    }
    // Every staff role is required by default; guardians stay optional.
    assert.equal(code(await coach.get("/api/academy")), "MFA_ENROLLMENT_REQUIRED");
    assert.equal((await state(coach)).mfa.required, true);
    assert.equal((await guardian.get("/api/academy/identity")).status, 200);
    assert.equal((await state(guardian)).mfa.required, false);
  });
  // Reversible: back to off and everyone is through again with nothing lost.
  assert.equal((await owner.get("/api/academy/identity")).status, 200);
  assert.equal((await admin.get("/api/academy/identity")).status, 200);
});
test("enforce: a required person is never locked out - sign in, enrol, continue", async () => {
  const owner = await newMember("OWNER");
  await withPolicy({ mode: "enforce" }, async () => {
    const e = await enrollUser(app, owner);
    // Enrolling lifted the gate on the activating session itself.
    const client = e.client;
    assert.equal((await client.get("/api/academy/identity")).status, 200);
    assert.equal((await state(client)).gate, null);
    assert.equal((await state(client)).twoFactorEnabled, true);
    // From now on the second factor is part of signing in.
    const next = await startChallenge(app, owner.email);
    assert.ok(twoFactorRedirect(next.step1));
    assert.equal((await next.client.post(`${TF}/verify-totp`, { code: e.code() })).status, 200);
    assert.equal((await next.client.get("/api/academy")).status, 200);
    // And an enrolled owner can still run the owner workflow.
    const target = await newMember("COACH");
    assert.equal((await reset(next.client, target.id)).status, 200);
  });
});
test("enforce: a person whose session predates enforcement can still enrol from that session", async () => {
  const admin = await newMember("ADMIN");
  const client = await signedIn(admin.email);
  await withPolicy({ mode: "enforce" }, async () => {
    assert.equal((await client.get("/api/academy")).status, 403);
    const { parseProvisioningUri, totpAt } = await import("./helpers/totp");
    const enable = await client.post(`${TF}/enable`, { password: FIXTURE_PASSWORD });
    assert.equal(enable.status, 200, enable.text);
    const key = parseProvisioningUri((enable.json as { totpURI: string }).totpURI).secret;
    assert.equal((await client.post(`${TF}/verify-totp`, { code: totpAt(key, 0) })).status, 200);
    assert.equal((await client.get("/api/academy/identity")).status, 200);
  });
});
test("the set of required roles is configurable", async () => {
  const coach = await signedIn((await newMember("COACH")).email);
  const owner = await signedIn((await newMember("OWNER")).email);
  await withPolicy({ mode: "enforce", roles: "coach, finance" }, async () => {
    assert.equal(code(await coach.get("/api/academy")), "MFA_ENROLLMENT_REQUIRED");
    assert.equal((await owner.get("/api/academy/identity")).status, 200, "owner is not in this list");
  });
});
test("a temporary password is changed first, then the required enrolment follows", async () => {
  const admin = await newMember("ADMIN");
  const resetter = await signedIn((await newMember("OWNER")).email);
  const r = await reset(resetter, admin.id);
  assert.equal(r.status, 200);
  const temporary = (r.json as ResetResult).temporaryPassword;
  await withPolicy({ mode: "enforce" }, async () => {
    const person = app.anonymous();
    assert.equal((await person.signIn(admin.email, temporary)).status, 200);
    assert.equal(code(await person.get("/api/academy")), "PASSWORD_CHANGE_REQUIRED");
    const changed = await person.post(CHANGE, { currentPassword: temporary, newPassword: NEW_PASSWORD() });
    assert.equal(changed.status, 200);
    assert.equal(code(await person.get("/api/academy")), "MFA_ENROLLMENT_REQUIRED");
    assert.equal((await state(person)).gate, "MFA_ENROLLMENT_REQUIRED");
  });
});
test("owner-initiated authenticator reset: lost device and lost codes are recoverable, never silently", async () => {
  const target = await newMember("FINANCE");
  const e = await enrollUser(app, target);
  const owner = await signedIn((await newMember("OWNER")).email);
  // Without the explicit flag the authenticator stays.
  const plain = await reset(owner, target.id);
  assert.equal((plain.json as ResetResult).authenticatorRemoved, false);
  const still = await startChallenge(app, target.email, (plain.json as ResetResult).temporaryPassword);
  assert.ok(twoFactorRedirect(still.step1), "a new temporary password does not bypass the second factor");
  // A non-owner cannot ask for it either.
  const admin = await signedIn((await newMember("ADMIN")).email);
  const denied = await reset(admin, target.id, { resetAuthenticator: true });
  assert.equal(denied.status, 403);
  assert.ok(await database().select().from(t.twoFactor).where(eq(t.twoFactor.userId, target.id)).then((r) => r.length === 1));
  // With the flag: authenticator and codes are gone, sessions end, both events are written.
  const full = await reset(owner, target.id, { resetAuthenticator: true, reason: "Lost phone and recovery codes; identity checked at the club." });
  assert.equal(full.status, 200, full.text);
  assert.equal((full.json as ResetResult).authenticatorRemoved, true);
  assert.equal((await e.client.get("/api/academy/identity")).status, 401);
  assert.equal((await database().select().from(t.twoFactor).where(eq(t.twoFactor.userId, target.id))).length, 0);
  assert.equal((await database().select().from(t.user).where(eq(t.user.id, target.id)))[0].twoFactorEnabled, false);
  assert.equal((await events(target.id, "MFA_RESET_BY_ADMIN")).length, 1);
  const reasons = (await events(target.id, "ADMIN_PASSWORD_RESET")).map((x) => (x.detail as { reason: string }).reason);
  assert.ok(reasons.some((x) => x.includes("Lost phone")));
  // Sign-in now needs the new temporary password (replaced at once) and no second factor.
  const person = app.anonymous();
  const signin = await person.signIn(target.email, (full.json as ResetResult).temporaryPassword);
  assert.equal(signin.status, 200);
  assert.equal(twoFactorRedirect(signin), false);
  assert.equal(code(await person.get("/api/academy")), "PASSWORD_CHANGE_REQUIRED");
  // The old authenticator's codes mean nothing now.
  assert.equal((await person.post(`${TF}/verify-totp`, { code: e.code() })).status >= 400, true);
});
test("resetting the authenticator of someone who has none is harmless", async () => {
  const target = await newMember("COACH");
  const owner = await signedIn((await newMember("OWNER")).email);
  const r = await reset(owner, target.id, { resetAuthenticator: true });
  assert.equal(r.status, 200);
  assert.equal((r.json as ResetResult).authenticatorRemoved, false);
  assert.equal((await events(target.id, "MFA_RESET_BY_ADMIN")).length, 0);
});
test("a misspelt policy fails loudly instead of silently disabling it", async () => {
  await withPolicy({ mode: "enforced" }, async () => {
    assert.throws(() => accountSecurity(), MfaPolicyError);
  });
  await withPolicy({ mode: "warn", roles: "OWNER,CHEF" }, async () => {
    assert.throws(() => accountSecurity(), /CHEF/);
  });
});
