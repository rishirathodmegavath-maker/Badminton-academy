import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
  sensitiveSessionMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { and, eq, ne } from "drizzle-orm";
import * as z from "zod";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { accountGate, gateAllowsPath } from "./account-gate";
import { installTemporaryCredential, removeAuthenticator } from "./credentials";
import { activeMembershipOf, resolveMembership, selectAcademy } from "./active-academy";
import { activeMemberships } from "./membership";
import { AcademyCreationError, createAcademyFor } from "./academy-creation";
import { can } from "./authority";
import { googleConfig, refusalFrom } from "./google";
import { emailDeliveryConfigured } from "./email-delivery";
import { TERMS_VERSION } from "./onboarding-policy";
import {
  MfaAdminError,
  changeMfaPolicy,
  mfaOverview,
} from "./mfa-admin";
import { MFA_MODES, mfaPolicy } from "./mfa-policy";
import { mfaStanding } from "./mfa-policy-store";
import { PASSWORD_MAX_LENGTH, passwordProblem } from "./password-policy";
import { DENIAL_RESPONSE, resetDecision } from "./reset-policy";
import { recordSecurityEvent } from "./security-events";
import { recordAccess } from "../audit/application/record";
import {
  clearFailures,
  refundAttempt,
  reserveAttempt,
  reserveOwnerReauth,
  THROTTLE_MAX_FAILURES,
  throttleKey,
} from "./sign-in-throttle";
import { generateTemporaryPassword } from "./temporary-password";
import { claimTotpCode } from "./totp-replay";
/**
 * Account security on top of Better Auth (no parallel authentication system):
 *
 *  - /account/change-password       the only password-change route (the stock one is blocked so its
 *                                   optional, client-controlled session handling cannot be used)
 *  - /account/admin/reset-password  owner-initiated temporary password (and optional authenticator reset)
 *  - /account/security-state        what the signed-in person still has to do
 *  - hooks                          forced-rotation gate, per-account sign-in throttle, authenticator
 *                                   code replay protection, device-trust refusal, audit trail
 *
 * Two-factor authentication itself is Better Auth's own plugin; this file only constrains it.
 */
type Status = ConstructorParameters<typeof APIError>[0];
const fail = (status: Status, message: string, code: string) =>
  new APIError(status, { message, code });
const noStore = (ctx: { setHeader?: (k: string, v: string) => void }) =>
  ctx.setHeader?.("Cache-Control", "no-store");
const TOO_MANY = () =>
  fail(
    "TOO_MANY_REQUESTS",
    "Too many failed attempts. Try again in a few minutes.",
    "TOO_MANY_ATTEMPTS",
  );
/** Stock Better Auth routes that must not be reachable: either replaced above or not configured. */
const BLOCKED = new Set([
  "/change-password",
  "/request-password-reset",
  "/two-factor/get-totp-uri",
  // Token-addressed: replaced by /account/revoke-session (id-addressed) so tokens need never be listed.
  "/revoke-session",
  "/send-verification-email",
  "/verify-email",
  // Provider tokens are never needed (and none are kept), so nothing may hand them out or refresh them.
  "/get-access-token",
  "/refresh-token",
  "/account-info",
  "/list-accounts",
  // Replaced by /account/unlink-google, which needs no provider identifier in the browser.
  "/unlink-account",
  // A password oracle for any holder of a session (a stolen cookie could guess the password here at the general rate
  // limit, outside the per-account sign-in throttle and the authenticator lockout). The application never calls it.
  "/verify-password",
]);
// Endpoints the forced-rotation gate does not need to look at: nobody is signed in yet, or the
// endpoint is exactly how a gated person finds out what to do.
const UNGATED = new Set([
  "/get-session",
  "/sign-out",
  "/sign-in/email",
  "/account/security-state",
  "/account/sign-in-methods",
]);
type Scratch = {
  enrolling?: boolean;
  /** The sign-in attempt this request claimed in the per-account throttle (see reserveAttempt). */
  claim?: { key: string; reachedLimit: boolean };
};
const scratch = (ctx: { context: unknown }) => ctx.context as Scratch;
type AnyCtx = Parameters<typeof getSessionFromCtx>[0];
async function twoFactorSubject(ctx: AnyCtx & { context: any }) {
  const session = await getSessionFromCtx(ctx);
  if (session?.session)
    return {
      userId: session.user.id as string,
      signedIn: true,
      twoFactorEnabled: !!(session.user as { twoFactorEnabled?: boolean })
        .twoFactorEnabled,
    };
  const cookie = ctx.context.createAuthCookie("two_factor");
  const challenge = await (ctx as any).getSignedCookie(
    cookie.name,
    ctx.context.secret,
  );
  if (!challenge) return null;
  const record =
    await ctx.context.internalAdapter.findVerificationValue(challenge);
  return record
    ? {
        userId: record.value as string,
        signedIn: false,
        twoFactorEnabled: true,
      }
    : null;
}
async function revokeOtherSessions(userId: string, keepToken?: string) {
  const db = database();
  const others = keepToken
    ? and(eq(t.session.userId, userId), ne(t.session.token, keepToken))
    : eq(t.session.userId, userId);
  return (
    await db.delete(t.session).where(others).returning({ id: t.session.id })
  ).length;
}
export function accountSecurity(): BetterAuthPlugin {
  const policyAtStart = mfaPolicy(); // a misspelt policy fails loudly here
  return {
    id: "account-security",
    endpoints: {
      // The academies this person may work in, and which one this session is working in (0017). Only the caller's own
      // active memberships; nothing about any other person or academy. The id is a handle for choosing among them:
      // /account/select-academy checks it against the person's memberships again.
      listAcademies: createAuthEndpoint(
        "/account/academies",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          noStore(ctx);
          const { user, session } = ctx.context.session;
          const r = await resolveMembership(user.id, session.id);
          const mine = r.status === "none" ? [] : r.active;
          const current = r.status === "resolved" ? r.chosen.academyId : null;
          return ctx.json({
            academies: mine.map((m) => ({
              academyId: m.academyId,
              name: m.academyName,
              role: m.role,
              current: m.academyId === current,
            })),
            selectionRequired: r.status === "selection_required",
            noAccess: r.status === "none" ? r.code : null,
          });
        },
      ),
      // Choose (or switch) the academy this session works in. Not a login: the session, its cookie and its expiry are
      // unchanged; only which membership later requests resolve to. A gated session (temporary password, required
      // authenticator) cannot reach it. An academy the person is not an ACTIVE member of answers exactly like one that
      // does not exist.
      selectAcademy: createAuthEndpoint(
        "/account/select-academy",
        {
          method: "POST",
          body: z.object({ academyId: z.string().min(1).max(200) }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          noStore(ctx);
          const { user, session } = ctx.context.session;
          const picked = await selectAcademy(user.id, session.id, ctx.body.academyId);
          if (!picked)
            throw fail(
              "NOT_FOUND",
              "That academy is not available to your account.",
              "ACADEMY_NOT_AVAILABLE",
            );
          // Recorded in the academy that was entered. The one it was left is deliberately not named here, so
          // one academy's log never reveals that the person also belongs to another.
          await recordSecurityEvent(database(), {
            event: "ACADEMY_SELECTED",
            academyId: picked.chosen.academyId,
            actorId: user.id,
            targetUserId: user.id,
            detail: { switched: picked.previousAcademyId !== null && picked.previousAcademyId !== picked.chosen.academyId },
          });
          return ctx.json({ academyId: picked.chosen.academyId, name: picked.chosen.academyName, role: picked.chosen.role });
        },
      ),
      // Start an academy of one's own and become its owner (so a person who signed up is not left with nothing to do).
      // Needs a signed-in, ungated session like every /account endpoint; the person is always the owner of what they
      // create and of nothing else. The academy is created and chosen for this session in one step.
      createAcademy: createAuthEndpoint(
        "/account/create-academy",
        {
          method: "POST",
          body: z.object({
            name: z.string().max(200),
            contactEmail: z.string().max(300),
            country: z.enum(["IN", "US"]),
            city: z.string().max(200),
            currency: z.enum(["INR", "USD"]),
            timezone: z.string().max(64).optional(),
          }),
          use: [sessionMiddleware],
        },
        async (ctx) => {
          noStore(ctx);
          const { user, session } = ctx.context.session;
          try {
            const created = await createAcademyFor(user.id, session.id, ctx.body);
            await recordSecurityEvent(database(), {
              event: "ACADEMY_CREATED",
              academyId: created.academyId,
              actorId: user.id,
              targetUserId: user.id,
              detail: { timezone: created.timezone, country: ctx.body.country, currency: ctx.body.currency },
            });
            return ctx.json({ academyId: created.academyId, name: created.name, role: created.role });
          } catch (error) {
            if (error instanceof AcademyCreationError)
              throw fail(error.status === 400 ? "BAD_REQUEST" : "CONFLICT", error.message, error.code);
            throw error;
          }
        },
      ),
      securityState: createAuthEndpoint(
        "/account/security-state",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          noStore(ctx);
          const { user } = ctx.context.session;
          const memberships = await activeMemberships(user.id);
          const twoFactorEnabled = !!(user as { twoFactorEnabled?: boolean })
            .twoFactorEnabled;
          const standing = await mfaStanding(memberships);
          const gate = await accountGate({
            userId: user.id,
            twoFactorEnabled,
            memberships,
          });
          const [temporary] = await database()
            .select()
            .from(t.temporaryCredential)
            .where(eq(t.temporaryCredential.userId, user.id));
          return ctx.json({
            gate: gate?.code ?? null,
            message: gate?.message ?? null,
            passwordChangeRequired:
              gate?.code === "PASSWORD_CHANGE_REQUIRED" ||
              gate?.code === "TEMPORARY_PASSWORD_EXPIRED",
            temporaryPasswordExpiresAt:
              temporary?.expiresAt.toISOString() ?? null,
            twoFactorEnabled,
            mfa: {
              // Strictest stage applying to this person (deployment or academy policy).
              mode: standing.mode,
              // optional | warn | required, for this person's role(s) right now.
              level: standing.level,
              required: standing.level !== "optional",
              enrolmentRequired: gate?.code === "MFA_ENROLLMENT_REQUIRED",
            },
          });
        },
      ),
      // Which sign-in methods exist and, for a signed-in person, whether Google is linked. Public: the login
      // screen uses it to show "Continue with Google" only when Google really is configured. No secrets, no ids.
      signInMethods: createAuthEndpoint(
        "/account/sign-in-methods",
        { method: "GET" },
        async (ctx) => {
          noStore(ctx);
          const google = googleConfig(process.env);
          const session = await getSessionFromCtx(ctx);
          let linked: boolean | null = null;
          let authenticator: boolean | null = null;
          if (session?.session) {
            const rows = await database()
              .select({ id: t.account.id })
              .from(t.account)
              .where(
                and(
                  eq(t.account.userId, session.user.id),
                  eq(t.account.providerId, "google"),
                ),
              );
            linked = rows.length > 0;
            authenticator = !!(session.user as { twoFactorEnabled?: boolean })
              .twoFactorEnabled;
          }
          const email = emailDeliveryConfigured();
          return ctx.json({
            google: { enabled: google.enabled, linked, authenticator },
            // Signup and sign-in never need email. Only password reset by email does; the forgot-password screen
            // says so when it is off.
            signup: { termsVersion: TERMS_VERSION },
            passwordReset: { enabled: email },
          });
        },
      ),
      // Unlink the signed-in person's own Google sign-in. Scoped to the caller; their password keeps working.
      unlinkGoogle: createAuthEndpoint(
        "/account/unlink-google",
        { method: "POST", use: [sessionMiddleware] },
        async (ctx) => {
          noStore(ctx);
          const { user } = ctx.context.session;
          const removed = await database()
            .delete(t.account)
            .where(
              and(
                eq(t.account.userId, user.id),
                eq(t.account.providerId, "google"),
              ),
            )
            .returning({ id: t.account.id });
          if (!removed.length)
            throw fail("NOT_FOUND", "Google is not linked to this account.", "NOT_LINKED");
          await recordSecurityEvent(database(), {
            event: "GOOGLE_UNLINKED",
            actorId: user.id,
            targetUserId: user.id,
          });
          return ctx.json({ status: true });
        },
      ),
      revokeSession: createAuthEndpoint(
        "/account/revoke-session",
        {
          method: "POST",
          body: z.object({ id: z.string().min(1).max(200) }),
          use: [sensitiveSessionMiddleware],
        },
        async (ctx) => {
          noStore(ctx);
          const { user, session } = ctx.context.session;
          if (ctx.body.id === session.id)
            throw fail(
              "BAD_REQUEST",
              "Use sign out to end the session you are using.",
              "CURRENT_SESSION",
            );
          // Scoped to the caller's own sessions: another person's id behaves like an unknown one.
          const removed = await database()
            .delete(t.session)
            .where(
              and(eq(t.session.id, ctx.body.id), eq(t.session.userId, user.id)),
            )
            .returning({ id: t.session.id });
          if (!removed.length)
            throw fail("NOT_FOUND", "Session not found.", "SESSION_NOT_FOUND");
          return ctx.json({ status: true });
        },
      ),
      changePassword: createAuthEndpoint(
        "/account/change-password",
        {
          method: "POST",
          body: z.object({
            currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
            newPassword: z.string().max(PASSWORD_MAX_LENGTH),
          }),
          use: [sensitiveSessionMiddleware],
        },
        async (ctx) => {
          noStore(ctx);
          const { user } = ctx.context.session;
          const { currentPassword, newPassword } = ctx.body;
          const throttle = throttleKey(
            ctx.context.secret,
            "change-password",
            user.id,
          );
          // Claim the attempt first so parallel guesses cannot all pass the lock check.
          if (!(await reserveAttempt(throttle)).allowed) throw TOO_MANY();
          const account =
            await ctx.context.internalAdapter.findCredentialAccount(user.id);
          if (!account?.password)
            throw fail(
              "BAD_REQUEST",
              "This account has no password to change.",
              "NO_PASSWORD",
            );
          const verify = (password: string) =>
            ctx.context.password.verify({ hash: account.password!, password });
          if (!(await verify(currentPassword))) {
            await recordSecurityEvent(database(), {
              event: "PASSWORD_CHANGE_FAILED",
              actorId: user.id,
              targetUserId: user.id,
            });
            throw fail(
              "BAD_REQUEST",
              "The current password is incorrect.",
              "INVALID_PASSWORD",
            );
          }
          await clearFailures(throttle);
          // Also stops a temporary password being "changed" into itself.
          if (await verify(newPassword))
            throw fail(
              "BAD_REQUEST",
              "The new password must be different from the current one.",
              "PASSWORD_UNCHANGED",
            );
          const problem = passwordProblem(newPassword, {
            email: user.email,
            name: user.name,
          });
          if (problem) throw fail("BAD_REQUEST", problem, "WEAK_PASSWORD");
          const passwordHash = await ctx.context.password.hash(newPassword);
          const db = database();
          const outcome = await db.transaction(async (tx) => {
            // Compare-and-set against the hash that was verified: if another change landed in
            // between, this one fails instead of silently overwriting it.
            const swapped = await tx
              .update(t.account)
              .set({ password: passwordHash, updatedAt: new Date() })
              .where(
                and(
                  eq(t.account.id, account.id),
                  eq(t.account.password, account.password!),
                ),
              )
              .returning({ id: t.account.id });
            if (!swapped.length)
              throw fail(
                "CONFLICT",
                "Your password was changed by another request. Sign in again and retry.",
                "CONCURRENT_CHANGE",
              );
            const cleared = await tx
              .delete(t.temporaryCredential)
              .where(eq(t.temporaryCredential.userId, user.id))
              .returning({ userId: t.temporaryCredential.userId });
            // Policy: every session ends (this one included) and a fresh one is issued below, so a
            // stolen cookie cannot survive the change and the current cookie value changes too.
            const revoked = await tx
              .delete(t.session)
              .where(eq(t.session.userId, user.id))
              .returning({ id: t.session.id });
            await recordSecurityEvent(tx, {
              event: "PASSWORD_CHANGED",
              actorId: user.id,
              targetUserId: user.id,
              detail: {
                wasTemporary: cleared.length > 0,
                revokedSessions: revoked.length,
              },
            });
            return { revoked: revoked.length };
          });
          await clearFailures(throttle);
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          if (!session)
            throw fail(
              "INTERNAL_SERVER_ERROR",
              "Password changed. Please sign in again.",
              "SESSION_NOT_CREATED",
            );
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ status: true, revokedSessions: outcome.revoked });
        },
      ),
      mfaPolicyView: createAuthEndpoint(
        "/account/mfa-policy",
        { method: "GET", use: [sessionMiddleware] },
        async (ctx) => {
          noStore(ctx);
          const { user, session } = ctx.context.session;
          // The academy this session is working in, resolved on the server (active-academy.ts); authority comes from
          // that stored membership, never from the request.
          const own = await activeMembershipOf(user.id, session.id);
          if (!own || !can(own, "security.mfa.view"))
            throw fail(
              "FORBIDDEN",
              "Your role cannot view the two-factor policy.",
              "NOT_AUTHORIZED",
            );
          const overview = await mfaOverview(database(), {
            id: user.id,
            academyId: own.academyId,
            role: own.role,
          });
          // Phase 7: the readiness list names members and their enrolment state; recording it is
          // fail-closed like every other sensitive read.
          await recordAccess(database(), {
            id: user.id,
            academyId: own.academyId,
            role: own.role,
          }, {
            category: "ACCOUNT_SECURITY",
            operation: "LIST",
            context: { counts: { members: overview.needsAction.length } },
          });
          return ctx.json(overview);
        },
      ),
      mfaPolicyChange: createAuthEndpoint(
        "/account/mfa-policy",
        {
          method: "POST",
          body: z.object({
            mode: z.enum(MFA_MODES as unknown as [string, ...string[]]),
            roles: z.array(z.string().min(1).max(40)).max(12),
            reason: z.string().trim().min(10).max(500),
            ownerPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
            acknowledgeRisk: z.boolean().optional(),
            emergencyOverride: z.boolean().optional(),
            emergencyReason: z.string().trim().max(500).optional(),
          }),
          use: [sensitiveSessionMiddleware],
        },
        async (ctx) => {
          noStore(ctx);
          const { user, session } = ctx.context.session;
          const input = ctx.body;
          const own = await activeMembershipOf(user.id, session.id);
          if (!own || !can(own, "security.mfa.edit"))
            throw fail(
              "FORBIDDEN",
              "Only an academy owner can change the two-factor policy.",
              "NOT_OWNER",
            );
          const actor = { id: user.id, academyId: own.academyId };
          // Re-authentication, on the same per-person counter as other owner actions.
          const throttle = throttleKey(
            ctx.context.secret,
            "owner-reauth",
            user.id,
          );
          if (!(await reserveOwnerReauth(throttle)).allowed) throw TOO_MANY();
          const ownAccount =
            await ctx.context.internalAdapter.findCredentialAccount(user.id);
          const ok =
            !!ownAccount?.password &&
            (await ctx.context.password.verify({
              hash: ownAccount.password,
              password: input.ownerPassword,
            }));
          if (!ok)
            throw fail(
              "FORBIDDEN",
              "Your password was not accepted. Nothing was changed.",
              "REAUTHENTICATION_FAILED",
            );
          await clearFailures(throttle);
          let outcome;
          try {
            outcome = await database().transaction((tx) =>
              changeMfaPolicy(tx, actor, {
                mode: input.mode as (typeof MFA_MODES)[number],
                roles: input.roles,
                reason: input.reason,
                acknowledgeRisk: input.acknowledgeRisk,
                emergencyOverride: input.emergencyOverride,
                emergencyReason: input.emergencyReason,
              }),
            );
          } catch (error) {
            if (error instanceof MfaAdminError)
              throw fail(error.status, error.message, error.code);
            throw error;
          }
          return ctx.json({
            changed: outcome.changed,
            overview: await mfaOverview(database(), {
              ...actor,
              role: "OWNER",
            }),
          });
        },
      ),
      adminResetPassword: createAuthEndpoint(
        "/account/admin/reset-password",
        {
          method: "POST",
          body: z.object({
            userId: z.string().min(1).max(200),
            reason: z.string().trim().min(10).max(500),
            ownerPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
            resetAuthenticator: z.boolean().optional(),
          }),
          use: [sensitiveSessionMiddleware],
        },
        async (ctx) => {
          noStore(ctx);
          const { user } = ctx.context.session;
          const input = ctx.body;
          const db = database();
          // Authority is derived from the actor's stored membership in the academy this session is working in
          // (resolved on the server), never from the request.
          const own = await activeMembershipOf(user.id, ctx.context.session.session.id);
          if (!own)
            throw fail(
              "FORBIDDEN",
              DENIAL_RESPONSE.NOT_OWNER.message,
              "NOT_OWNER",
            );
          const actor = {
            id: user.id,
            academyId: own.academyId,
            role: own.role,
          };
          const targetMemberships = await activeMemberships(input.userId);
          const decision = resetDecision(actor, {
            id: input.userId,
            memberships: targetMemberships,
          });
          if (!decision.allowed) {
            await recordSecurityEvent(db, {
              event: "ADMIN_RESET_DENIED",
              academyId: actor.academyId,
              actorId: actor.id,
              // Only a target already proven to be a member is referenced; a requested id that is
              // not one of this academy's members stays out of the foreign-key column.
              targetUserId: targetMemberships.some(
                (m) => m.academyId === actor.academyId,
              )
                ? input.userId
                : null,
              detail: { reason: decision.reason },
            });
            const response = DENIAL_RESPONSE[decision.reason];
            throw fail(response.status, response.message, decision.reason);
          }
          // Re-authentication: the owner proves they are still the person at the keyboard.
          const throttle = throttleKey(
            ctx.context.secret,
            "owner-reauth",
            user.id,
          );
          if (!(await reserveOwnerReauth(throttle)).allowed) throw TOO_MANY();
          const ownAccount =
            await ctx.context.internalAdapter.findCredentialAccount(user.id);
          const ok =
            !!ownAccount?.password &&
            (await ctx.context.password.verify({
              hash: ownAccount.password,
              password: input.ownerPassword,
            }));
          if (!ok) {
            throw fail(
              "FORBIDDEN",
              "Your password was not accepted. Nothing was changed.",
              "REAUTHENTICATION_FAILED",
            );
          }
          await clearFailures(throttle);
          const temporaryPassword = generateTemporaryPassword();
          const passwordHash =
            await ctx.context.password.hash(temporaryPassword);
          const result = await db.transaction(async (tx) => {
            // Member changes lock the academy row (settings unit of work). Taking the same lock
            // and deciding again makes the authorization atomic with the write: a membership that
            // changed since the first check (demoted owner, target made an owner) is caught here.
            await tx
              .select()
              .from(t.academies)
              .where(eq(t.academies.id, actor.academyId))
              .for("update");
            const asDb = tx as unknown as ReturnType<typeof database>;
            const current = (await activeMemberships(actor.id, asDb)).find((m) => m.academyId === actor.academyId);
            const recheck = resetDecision(
              {
                id: actor.id,
                academyId: actor.academyId,
                role: current?.role ?? "",
              },
              {
                id: input.userId,
                memberships: await activeMemberships(input.userId, asDb),
              },
            );
            if (!recheck.allowed)
              throw fail(
                "CONFLICT",
                "Membership changed while this was being processed. Review the member and try again.",
                "MEMBERSHIP_CHANGED",
              );
            const issued = await installTemporaryCredential(tx, {
              userId: input.userId,
              passwordHash,
              source: "OWNER_RESET",
              issuedBy: actor.id,
              secret: ctx.context.secret,
            });
            const authenticatorRemoved = input.resetAuthenticator
              ? await removeAuthenticator(tx, input.userId)
              : false;
            await recordSecurityEvent(tx, {
              event: "ADMIN_PASSWORD_RESET",
              academyId: actor.academyId,
              actorId: actor.id,
              targetUserId: input.userId,
              detail: {
                reason: input.reason,
                expiresAt: issued.expiresAt.toISOString(),
                revokedSessions: issued.revokedSessions,
                authenticatorRemoved,
              },
            });
            if (authenticatorRemoved)
              await recordSecurityEvent(tx, {
                event: "MFA_RESET_BY_ADMIN",
                academyId: actor.academyId,
                actorId: actor.id,
                targetUserId: input.userId,
                detail: { reason: input.reason },
              });
            return { issued, authenticatorRemoved };
          });
          // The only time the temporary password exists in plaintext: hand it over privately.
          return ctx.json({
            userId: input.userId,
            temporaryPassword,
            expiresAt: result.issued.expiresAt.toISOString(),
            revokedSessions: result.issued.revokedSessions,
            authenticatorRemoved: result.authenticatorRemoved,
          });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (c: { path?: string }) =>
            BLOCKED.has(c.path ?? "") ||
            (c.path ?? "").startsWith("/reset-password"),
          handler: createAuthMiddleware(async () => {
            throw fail(
              "NOT_FOUND",
              "This operation is not available.",
              "NOT_AVAILABLE",
            );
          }),
        },
        {
          matcher: (c: { path?: string }) => c.path === "/two-factor/disable",
          handler: createAuthMiddleware(async (ctx) => {
            // Where the policy requires two-factor for this person, turning it off is refused: a
            // stolen session plus password could otherwise swap in the thief's authenticator.
            // Lost device? An owner resets the authenticator (reason + re-authentication) or the
            // operator runs recovery; both are audited.
            const session = await getSessionFromCtx(ctx);
            if (!session?.session) return;
            const standing = await mfaStanding(
              await activeMemberships(session.user.id),
            );
            if (standing.level === "required")
              throw fail(
                "FORBIDDEN",
                "Your role requires two-factor authentication, so it cannot be turned off here. If you lost your device, ask an academy owner to reset it.",
                "MFA_REQUIRED_BY_POLICY",
              );
          }),
        },
        {
          matcher: (c: { path?: string }) =>
            c.path === "/two-factor/verify-totp" ||
            c.path === "/two-factor/verify-backup-code",
          handler: createAuthMiddleware(async (ctx) => {
            // A remembered device would skip the second factor on later sign-ins.
            if (
              (ctx.body as { trustDevice?: unknown } | undefined)?.trustDevice
            )
              throw fail(
                "BAD_REQUEST",
                "Trusted devices are not supported.",
                "TRUST_DEVICE_DISABLED",
              );
          }),
        },
        {
          matcher: (c: { path?: string }) => c.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const email = (ctx.body as { email?: unknown } | undefined)?.email;
            if (typeof email !== "string") return;
            const key = throttleKey(ctx.context.secret, "sign-in", email);
            // Claim the attempt before the password is checked (atomic): ten claims per window,
            // however many requests arrive at once.
            const claim = await reserveAttempt(key);
            if (!claim.allowed) throw TOO_MANY();
            scratch(ctx).claim = { key, reachedLimit: claim.reachedLimit };
          }),
        },
        {
          matcher: (c: { path?: string }) =>
            c.path === "/two-factor/verify-totp",
          handler: createAuthMiddleware(async (ctx) => {
            const subject = await twoFactorSubject(ctx as never);
            const code = (ctx.body as { code?: unknown } | undefined)?.code;
            if (!subject || typeof code !== "string") return;
            scratch(ctx).enrolling =
              subject.signedIn && !subject.twoFactorEnabled;
            if (!(await claimTotpCode(subject.userId, code)))
              throw fail("UNAUTHORIZED", "Invalid code", "INVALID_CODE");
          }),
        },
        {
          matcher: (c: { path?: string }) => !UNGATED.has(c.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            if (!ctx.headers?.get("cookie")) return;
            const session = await getSessionFromCtx(ctx);
            if (!session?.session) return;
            const memberships = await activeMemberships(session.user.id);
            const gate = await accountGate({
              userId: session.user.id,
              twoFactorEnabled: !!(
                session.user as { twoFactorEnabled?: boolean }
              ).twoFactorEnabled,
              memberships,
            });
            if (gate && !gateAllowsPath(gate.code, ctx.path ?? ""))
              throw fail("FORBIDDEN", gate.message, gate.code);
          }),
        },
        {
          // A person's display name is also the name shown as the approver of reports and nutrition plans,
          // so it is identity data, not a preference: only an academy owner changes it (Settings -> members,
          // which is authorised and written to the audit trail). The stock self-service route is refused for
          // every role, whatever the request carries (name, image or anything else). This hook sits AFTER the
          // forced-rotation gate, so a gated session still receives the gate's own answer first.
          matcher: (c: { path?: string }) => c.path === "/update-user",
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getSessionFromCtx(ctx);
            if (!session?.session) return; // not signed in: Better Auth answers 401 itself
            await recordSecurityEvent(database(), {
              event: "PROFILE_UPDATE_REFUSED",
              actorId: session.user.id,
              targetUserId: session.user.id,
            });
            throw fail(
              "FORBIDDEN",
              "Your name and sign-in details are managed by your academy owner. Ask them to change it for you.",
              "PROFILE_MANAGED_BY_OWNER",
            );
          }),
        },
      ],
      after: [
        {
          // Google: a started session is recorded; a refusal is recorded unless the session hook already did
          // (it knows the person, so those two are attributed to their academy there).
          matcher: (c: { path?: string }) => (c.path ?? "").startsWith("/callback/"),
          handler: createAuthMiddleware(async (ctx) => {
            const created = ctx.context.newSession;
            if (created) {
              await recordSecurityEvent(database(), {
                event: "GOOGLE_SIGN_IN",
                actorId: created.user.id,
                targetUserId: created.user.id,
              });
              return;
            }
            const returned = ctx.context.returned;
            if (!isAPIError(returned)) return;
            const location =
              (returned.headers as Headers | undefined)?.get?.("location") ?? "";
            let code: string | null = null;
            try {
              code = new URL(location, "http://placeholder.invalid").searchParams.get("error");
            } catch {
              code = null;
            }
            if (!code) return;
            const reason = refusalFrom(code);
            if (reason === "mfa_enrolled" || reason === "temporary_password_expired") return;
            await recordSecurityEvent(database(), {
              event: "GOOGLE_SIGN_IN_REFUSED",
              detail: { reason },
            });
          }),
        },
        {
          matcher: (c: { path?: string }) => c.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const claim = scratch(ctx).claim;
            if (!claim) return; // refused before it was counted, or no usable email
            const email = (ctx.body as { email?: unknown }).email as string;
            const returned = ctx.context.returned;
            if (!isAPIError(returned)) return void (await clearFailures(claim.key));
            const code = (returned.body as { code?: string } | undefined)?.code;
            if (code === "TEMPORARY_PASSWORD_EXPIRED") {
              // Only reachable after the correct password was presented: not a failed guess.
              await clearFailures(claim.key);
              const [person] = await database()
                .select({ id: t.user.id })
                .from(t.user)
                .where(eq(t.user.email, email.trim().toLowerCase()));
              await recordSecurityEvent(database(), {
                event: "TEMPORARY_PASSWORD_EXPIRED_SIGNIN",
                targetUserId: person?.id ?? null,
              });
              return;
            }
            if (code !== "INVALID_EMAIL_OR_PASSWORD") {
              // No verdict on the password (e.g. a malformed request): give the claim back.
              await refundAttempt(claim.key);
              return;
            }
            // The failure was already counted when the attempt was claimed.
            if (claim.reachedLimit) {
              const [person] = await database()
                .select({ id: t.user.id })
                .from(t.user)
                .where(eq(t.user.email, email.trim().toLowerCase()));
              await recordSecurityEvent(database(), {
                event: "SIGN_IN_LOCKED",
                targetUserId: person?.id ?? null,
                detail: { failures: THROTTLE_MAX_FAILURES },
              });
            }
          }),
        },
        {
          matcher: (c: { path?: string }) =>
            (c.path ?? "").startsWith("/two-factor/") ||
            (c.path ?? "").startsWith("/account/"),
          handler: createAuthMiddleware(async (ctx) => {
            noStore(ctx);
          }),
        },
        {
          matcher: (c: { path?: string }) => c.path === "/list-sessions",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (isAPIError(returned) || !Array.isArray(returned)) return;
            const current = (await getSessionFromCtx(ctx))?.session.token;
            // Session tokens are bearer credentials; the browser never needs to read them.
            return ctx.json(
              returned.map((s: Record<string, unknown>) => ({
                id: s.id,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                expiresAt: s.expiresAt,
                ipAddress: s.ipAddress ?? null,
                userAgent: s.userAgent ?? null,
                current: s.token === current,
              })),
            );
          }),
        },
        {
          matcher: (c: { path?: string }) => c.path === "/two-factor/enable",
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const session = await getSessionFromCtx(ctx);
            const id = session?.user.id ?? ctx.context.newSession?.user.id;
            if (id)
              await recordSecurityEvent(database(), {
                event: "MFA_ENROLLMENT_STARTED",
                actorId: id,
                targetUserId: id,
              });
          }),
        },
        {
          matcher: (c: { path?: string }) =>
            c.path === "/two-factor/verify-totp",
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned) || !scratch(ctx).enrolling)
              return;
            const created = ctx.context.newSession;
            if (!created) return;
            // Authenticator just activated: end every other session so a session opened before the
            // second factor existed cannot outlive its introduction.
            const revoked = await revokeOtherSessions(
              created.user.id,
              created.session.token,
            );
            await recordSecurityEvent(database(), {
              event: "MFA_ENABLED",
              actorId: created.user.id,
              targetUserId: created.user.id,
              detail: { revokedSessions: revoked },
            });
          }),
        },
        {
          matcher: (c: { path?: string }) =>
            c.path === "/two-factor/verify-backup-code",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned as
              { user?: { id?: string } } | undefined;
            if (isAPIError(returned) || !returned?.user?.id) return;
            await recordSecurityEvent(database(), {
              event: "MFA_RECOVERY_CODE_USED",
              actorId: returned.user.id,
              targetUserId: returned.user.id,
            });
          }),
        },
        {
          matcher: (c: { path?: string }) =>
            c.path === "/two-factor/generate-backup-codes",
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const session = await getSessionFromCtx(ctx);
            if (session?.user.id)
              await recordSecurityEvent(database(), {
                event: "MFA_RECOVERY_CODES_REGENERATED",
                actorId: session.user.id,
                targetUserId: session.user.id,
              });
          }),
        },
        {
          matcher: (c: { path?: string }) => c.path === "/two-factor/disable",
          handler: createAuthMiddleware(async (ctx) => {
            if (isAPIError(ctx.context.returned)) return;
            const created = ctx.context.newSession;
            if (!created) return;
            const revoked = await revokeOtherSessions(
              created.user.id,
              created.session.token,
            );
            await database()
              .delete(t.totpUsed)
              .where(eq(t.totpUsed.userId, created.user.id));
            await recordSecurityEvent(database(), {
              event: "MFA_DISABLED",
              actorId: created.user.id,
              targetUserId: created.user.id,
              detail: { revokedSessions: revoked },
            });
          }),
        },
      ],
    },
    rateLimit: [],
    $ERROR_CODES: {},
    // Evaluated when authentication is first set up, so a bad MFA_* value is reported immediately.
    options: { mfa: policyAtStart.mode },
  } as unknown as BetterAuthPlugin;
}
