import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { database } from "../../src/infrastructure/database/client";
import * as t from "../../src/infrastructure/database/schema";
import { FIXTURE_PASSWORD, addFixtureUser, type AcademyId, type Role } from "./fixtures";
import type { Harness } from "./harness";
import type { TestClient } from "./client";
/**
 * Shared helpers for the account-security suites: throw-away members, sign-in, and direct reads
 * of the security tables (so assertions check the database, not just the HTTP response).
 */
export const AUTH = "/api/auth";
export const CHANGE = `${AUTH}/account/change-password`;
export const RESET = `${AUTH}/account/admin/reset-password`;
export const STATE = `${AUTH}/account/security-state`;
export const code = (r: { json: unknown }) =>
  (r.json as { code?: string } | null)?.code;
let counter = 0;
export const unique = () => ++counter;
export const NEW_PASSWORD = () => `Orchid-Lantern-Meadow-${unique()}-Quartz`;
export async function newMember(
  role: Role = "COACH",
  academyId: AcademyId = "green",
  prefix = "acct",
) {
  const id = `${prefix}-${unique()}-${role.toLowerCase().replace(/_/g, "")}`;
  const { email } = await addFixtureUser(id, [{ academyId, role }]);
  return { id, email };
}
export async function signedIn(
  app: Harness,
  email: string,
  password = FIXTURE_PASSWORD,
): Promise<TestClient> {
  const client = app.anonymous();
  const r = await client.signIn(email, password);
  assert.equal(r.status, 200, `sign-in ${r.status} ${r.text.slice(0, 120)}`);
  assert.ok(client.hasSession(), "a session cookie was issued");
  return client;
}
export const sessionsOf = async (userId: string) =>
  (await database().select().from(t.session).where(eq(t.session.userId, userId))).length;
export const hashOf = async (userId: string) =>
  (
    await database()
      .select()
      .from(t.account)
      .where(and(eq(t.account.userId, userId), eq(t.account.providerId, "credential")))
  )[0].password!;
export const events = async (userId: string, event?: string) =>
  (
    await database()
      .select()
      .from(t.securityEvent)
      .where(eq(t.securityEvent.targetUserId, userId))
  ).filter((e) => !event || e.event === event);
export const temporaryRow = async (userId: string) =>
  (
    await database()
      .select()
      .from(t.temporaryCredential)
      .where(eq(t.temporaryCredential.userId, userId))
  )[0];
/** Move a temporary credential's expiry to an absolute time (simulates the passage of time). */
export const setExpiry = (userId: string, expiresAt: Date, issuedAt?: Date) =>
  database()
    .update(t.temporaryCredential)
    .set({ expiresAt, ...(issuedAt ? { issuedAt } : {}) })
    .where(eq(t.temporaryCredential.userId, userId));
export const hoursFromNow = (hours: number) =>
  new Date(Date.now() + hours * 3600 * 1000);
export type ResetResult = {
  userId: string;
  temporaryPassword: string;
  expiresAt: string;
  revokedSessions: number;
  authenticatorRemoved: boolean;
};
export function reset(
  owner: TestClient,
  userId: string,
  overrides: Record<string, unknown> = {},
  init: Parameters<TestClient["post"]>[2] = {},
) {
  return owner.post(
    RESET,
    {
      userId,
      reason: "Member forgot their password; identity confirmed in person.",
      ownerPassword: FIXTURE_PASSWORD,
      ...overrides,
    },
    init,
  );
}
/** Everything in the database that could plausibly hold a secret, as one string. */
export async function secretBearingRows() {
  const db = database();
  return JSON.stringify([
    await db.select().from(t.securityEvent),
    await db.select().from(t.temporaryCredential),
    await db.select().from(t.verification),
    await db.select().from(t.audit),
    await db.select().from(t.signInThrottle),
    await db.select().from(t.totpUsed),
    await db.select().from(t.rateLimit),
  ]);
}

/**
 * An account that is WAITING FOR AN EMAILED CODE (email_verification_required, unverified). Password signup no longer
 * creates these (it needs no email), but the optional code step still exists for them: this builds one directly and asks
 * for its code through the real resend endpoint, so the verify/resend/Google/reset suites still exercise that path.
 * Needs a configured mail provider (the resend endpoint answers 503 without one).
 */
export async function pendingVerificationAccount(
  app: Harness,
  over: Partial<{ name: string; email: string; password: string }> = {},
) {
  const body = {
    name: "Priya Mehta",
    email: `pending-${unique()}-${Date.now().toString(36)}@example.test`,
    password: NEW_PASSWORD(),
    ...over,
  };
  body.email = body.email.toLowerCase();
  const id = crypto.randomUUID();
  await database().insert(t.user).values({
    id,
    name: body.name,
    email: body.email,
    emailVerified: false,
    emailVerificationRequired: true,
    termsAcceptedAt: new Date(),
    termsVersion: "2026-11-12",
  });
  await database().insert(t.account).values({
    id: crypto.randomUUID(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashPassword(body.password),
  });
  const client = app.anonymous();
  const response = await client.post("/api/auth/onboarding/resend-verification", { email: body.email });
  return { client, body, response, id };
}
