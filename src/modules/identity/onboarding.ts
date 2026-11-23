import { randomBytes, randomInt } from "node:crypto";
import { APIError, createAuthEndpoint } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { and, desc, eq, inArray } from "drizzle-orm";
import * as z from "zod";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import {
  enqueueAuthEmail,
  hashVerificationSecret,
  verifyVerificationSecret,
} from "../../infrastructure/email";
import { config } from "../../shared/config";
import { passwordResetEmail, verificationEmail } from "./auth-emails";
import { emailDeliveryConfigured, kickAuthEmailDelivery } from "./email-delivery";
import {
  EMAIL_COOLDOWN_MS,
  EMAIL_MAX,
  GENERIC_RESET_RESPONSE,
  GENERIC_SIGNUP_RESPONSE,
  SIGNUP_CREATED_RESPONSE,
  NAME_MAX,
  NAME_MIN,
  ONBOARDING_MESSAGES,
  OTP_LENGTH,
  OTP_TTL_MS,
  RESET_TTL_MS,
  SEND_MAX_PER_WINDOW,
  TERMS_VERSION,
  VERIFY_MAX_ATTEMPTS,
} from "./onboarding-policy";
import { PASSWORD_MAX_LENGTH, passwordProblem } from "./password-policy";
import { recordSecurityEvent } from "./security-events";
import { isWellFormedSecondFactorCode, verifySecondFactorCode } from "./second-factor";
import {
  clearFailures,
  reserveAttempt,
  throttleKey,
} from "./sign-in-throttle";
import type { Tx } from "./credentials";

/**
 * Public onboarding on top of Better Auth (no parallel authentication system), mounted under /api/auth/onboarding:
 *
 *  - /onboarding/signup               email + password signup. NO EMAIL IS NEEDED: the account is created at once,
 *                                     UNASSIGNED (no academy membership, ever, from this route) and UNVERIFIED, with
 *                                     the accepted terms recorded. No session is created; the person signs in next.
 *                                     An address that already has an account is refused (409) and left untouched.
 *                                     Being unverified keeps the account out of email password recovery and Google
 *                                     linking, which need a verified address.
 *  - /onboarding/verify-email         (optional, email delivery required; only for an account that is waiting for a
 *                                     code) the emailed 6-digit code PLUS the password the person wants, typed twice.
 *                                     The code proves the mailbox; only then is a password installed (replacing
 *                                     whatever signup stored), so nobody who has not read the mailbox ever chooses
 *                                     the password of an address. Marks it verified; the person then signs in
 *                                     normally. No session is created.
 *  - /onboarding/resend-verification  a fresh code (the previous one stops working).
 *  - /onboarding/forgot-password      emails a single-use reset link (token in the URL fragment, never a query
 *                                     string). Owners are never offered it (owner recovery is the operator's job).
 *  - /onboarding/reset-password       spends the link. An account with an authenticator also needs a current code
 *                                     (or one recovery code): email access alone never replaces a second factor,
 *                                     and the reset never removes the authenticator.
 *
 * Every answer that could reveal whether an address has an account is identical either way.
 */
type Status = ConstructorParameters<typeof APIError>[0];
const fail = (status: Status, message: string, code: string) =>
  new APIError(status, { message, code });
const noStore = (ctx: { setHeader?: (k: string, v: string) => void }) =>
  ctx.setHeader?.("Cache-Control", "no-store");
const tooMany = () =>
  fail("TOO_MANY_REQUESTS", ONBOARDING_MESSAGES.TOO_MANY_ATTEMPTS, "TOO_MANY_ATTEMPTS");
const invalidCode = () =>
  fail("BAD_REQUEST", ONBOARDING_MESSAGES.INVALID_CODE, "INVALID_CODE");
const invalidToken = () =>
  fail("BAD_REQUEST", ONBOARDING_MESSAGES.INVALID_RESET_TOKEN, "INVALID_RESET_TOKEN");

const normalizeEmail = (email: string) => email.trim().toLowerCase();
const otpIdentifier = (email: string) => `email-otp:${email}`;
const resetIdentifier = (userId: string) => `password-reset:${userId}`;
const otpBinding = (userId: string, email: string) => `${userId}\0${email}`;
const TOKEN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/;

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX)
  .pipe(z.email());
const passwordField = z.string().min(1).max(PASSWORD_MAX_LENGTH);

type Db = ReturnType<typeof database>;
type Account = { secret: string };

/** A fresh 6-digit code from the system CSPRNG (uniform; no modulo bias). */
const newCode = () => String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, "0");

/** Pending (unsent) emails of a kind to this person stop being sent once a newer one replaces them. */
async function supersedePendingEmails(
  tx: Tx | Db,
  userId: string,
  kind: "EMAIL_VERIFICATION_OTP" | "PASSWORD_RESET_LINK",
) {
  await tx
    .update(t.authEmailOutbox)
    .set({
      status: "FAILED_PERMANENT",
      sealedPayload: null,
      lastErrorCode: "SUPERSEDED",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(t.authEmailOutbox.userId, userId),
        eq(t.authEmailOutbox.kind, kind),
        inArray(t.authEmailOutbox.status, ["PENDING", "FAILED_RETRYABLE"]),
      ),
    );
}

/** True when the last email of this kind to this person was queued less than the cooldown ago. */
async function withinCooldown(
  db: Tx | Db,
  userId: string,
  kind: "EMAIL_VERIFICATION_OTP" | "PASSWORD_RESET_LINK",
  now: Date,
) {
  const [latest] = await db
    .select({ createdAt: t.authEmailOutbox.createdAt })
    .from(t.authEmailOutbox)
    .where(and(eq(t.authEmailOutbox.userId, userId), eq(t.authEmailOutbox.kind, kind)))
    .orderBy(desc(t.authEmailOutbox.createdAt))
    .limit(1);
  return !!latest && now.getTime() - latest.createdAt.getTime() < EMAIL_COOLDOWN_MS;
}

/**
 * Replaces any live code with a new one and queues the email, in the caller's transaction. The code is stored
 * only as a keyed hash bound to the person and address; the plaintext exists in memory here and, sealed, in the
 * outbox row until it is sent.
 */
async function issueVerificationCode(
  tx: Tx,
  input: { userId: string; email: string; name: string; secret: string; now: Date },
) {
  await tx
    .delete(t.verification)
    .where(eq(t.verification.identifier, otpIdentifier(input.email)));
  await supersedePendingEmails(tx, input.userId, "EMAIL_VERIFICATION_OTP");
  const code = newCode();
  const id = crypto.randomUUID();
  const expiresAt = new Date(input.now.getTime() + OTP_TTL_MS);
  await tx.insert(t.verification).values({
    id,
    identifier: otpIdentifier(input.email),
    value: hashVerificationSecret(
      "email-otp",
      code,
      otpBinding(input.userId, input.email),
      input.secret,
    ),
    expiresAt,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await enqueueAuthEmail(tx, {
    kind: "EMAIL_VERIFICATION_OTP",
    userId: input.userId,
    idempotencyKey: `email-otp:${id}`,
    payload: verificationEmail({ to: input.email, name: input.name, code }),
    expiresAt,
    authSecret: input.secret,
  });
}

/** Self-service reset is for verified, password-holding accounts that are not an academy owner. */
async function resetEligibility(db: Tx | Db, person: { id: string; emailVerified: boolean }) {
  if (!person.emailVerified) return "UNVERIFIED" as const;
  const [credential] = await db
    .select({ id: t.account.id })
    .from(t.account)
    .where(and(eq(t.account.userId, person.id), eq(t.account.providerId, "credential")));
  if (!credential) return "NO_PASSWORD" as const;
  const owners = await db
    .select({ academyId: t.memberships.academyId })
    .from(t.memberships)
    .where(
      and(
        eq(t.memberships.userId, person.id),
        eq(t.memberships.role, "OWNER"),
        eq(t.memberships.active, true),
      ),
    );
  if (owners.length) return "OWNER" as const;
  return null;
}

export function onboarding(): BetterAuthPlugin {
  const accountOf = (ctx: { context: { secret: string } }): Account => ({
    secret: ctx.context.secret,
  });
  return {
    id: "onboarding",
    endpoints: {
      signup: createAuthEndpoint(
        "/onboarding/signup",
        {
          method: "POST",
          body: z.object({
            name: z.string().trim().min(NAME_MIN).max(NAME_MAX),
            email: emailField,
            password: passwordField,
            acceptTerms: z.boolean(),
            termsVersion: z.string().max(40).optional(),
          }),
        },
        async (ctx) => {
          noStore(ctx);
          const { secret } = accountOf(ctx);
          const input = ctx.body;
          if (input.acceptTerms !== true)
            throw fail("BAD_REQUEST", ONBOARDING_MESSAGES.TERMS_REQUIRED, "TERMS_REQUIRED");
          if (input.termsVersion !== undefined && input.termsVersion !== TERMS_VERSION)
            throw fail("CONFLICT", ONBOARDING_MESSAGES.TERMS_VERSION_CHANGED, "TERMS_VERSION_CHANGED");
          const now = new Date();
          const claim = await reserveAttempt(
            throttleKey(secret, "signup", input.email),
            now,
            SEND_MAX_PER_WINDOW,
          );
          if (!claim.allowed) throw tooMany();
          const problem = passwordProblem(input.password, {
            email: input.email,
            name: input.name,
          });
          if (problem) throw fail("BAD_REQUEST", problem, "WEAK_PASSWORD");
          const passwordHash = await ctx.context.password.hash(input.password);
          // No email is involved: the account exists as soon as this transaction commits, so signup works whether or
          // not a mail provider is configured. It is UNVERIFIED (email_verified = false), which is what keeps it out
          // of every path that depends on owning the mailbox: password recovery by email (resetEligibility) and a
          // Google link (mayHoldGoogle) both require a verified address. It is also UNASSIGNED: no membership.
          const created = await database().transaction(async (tx) => {
            const userId = crypto.randomUUID();
            const [row] = await tx
              .insert(t.user)
              .values({
                id: userId,
                name: input.name,
                email: input.email,
                emailVerified: false,
                // Nothing is waiting for a code, so nothing blocks the first sign-in.
                emailVerificationRequired: false,
                termsAcceptedAt: now,
                termsVersion: TERMS_VERSION,
              })
              .onConflictDoNothing({ target: t.user.email })
              .returning({ id: t.user.id });
            if (!row) return false;
            await tx.insert(t.account).values({
              id: crypto.randomUUID(),
              accountId: userId,
              providerId: "credential",
              userId,
              password: passwordHash,
            });
            await recordSecurityEvent(tx, {
              event: "ACCOUNT_SIGNED_UP",
              actorId: userId,
              targetUserId: userId,
              detail: { method: "password", emailVerified: false, termsVersion: TERMS_VERSION },
            });
            return true;
          });
          // An address that already has an account is never touched: not its password, name, terms or verification
          // state, whoever owns it and however it was created. There is no mailbox proof to rely on, so the person
          // is told plainly instead of being shown a success that would not let them in. (Per-address and per-client
          // limits above bound how fast addresses can be probed.)
          if (!created) throw fail("CONFLICT", ONBOARDING_MESSAGES.EMAIL_IN_USE, "EMAIL_IN_USE");
          return ctx.json(SIGNUP_CREATED_RESPONSE);
        },
      ),

      verifyEmail: createAuthEndpoint(
        "/onboarding/verify-email",
        {
          method: "POST",
          body: z.object({
            email: emailField,
            code: z.string().trim().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`)),
            // Re-entered and confirmed HERE, after mailbox proof: this, not the signup password, becomes the password.
            password: passwordField,
            confirmPassword: passwordField,
          }),
        },
        async (ctx) => {
          noStore(ctx);
          const { secret } = accountOf(ctx);
          const { email, code, password, confirmPassword } = ctx.body;
          // Checks that need nothing from the account run first and spend no attempt, so they say nothing about it.
          if (password !== confirmPassword)
            throw fail("BAD_REQUEST", ONBOARDING_MESSAGES.PASSWORD_MISMATCH, "PASSWORD_MISMATCH");
          const early = passwordProblem(password, { email });
          if (early) throw fail("BAD_REQUEST", early, "WEAK_PASSWORD");
          const now = new Date();
          const db = database();
          const key = throttleKey(secret, "verify-email", email);
          // Claim the attempt before anything is looked up (atomic), exactly like a password guess.
          const claim = await reserveAttempt(key, now, VERIFY_MAX_ATTEMPTS);
          const withdraw = () =>
            db.delete(t.verification).where(eq(t.verification.identifier, otpIdentifier(email)));
          if (!claim.allowed) {
            await withdraw();
            throw tooMany();
          }
          // Hashed before anything is looked up (an unknown address costs the same as a known one). Only a request
          // that passed the attempt limit gets here, so this cannot be used to burn CPU in volume.
          const passwordHash = await ctx.context.password.hash(password);
          const [person] = await db.select().from(t.user).where(eq(t.user.email, email));
          const [row] = person
            ? await db
                .select()
                .from(t.verification)
                .where(eq(t.verification.identifier, otpIdentifier(email)))
                .orderBy(desc(t.verification.createdAt))
                .limit(1)
            : [];
          const live = !!person && !!row && row.expiresAt.getTime() > now.getTime();
          // A comparison is always made (against a throwaway value when there is nothing to compare with),
          // so the answer and its cost do not tell an unknown address from a known one.
          const matches = verifyVerificationSecret(
            live ? row!.value : hashVerificationSecret("email-otp", "000000", "none", secret),
            "email-otp",
            code,
            live ? otpBinding(person!.id, email) : "none",
            secret,
          );
          if (!live || !matches) {
            // The last allowed guess has been spent: withdraw the code so a new one must be requested.
            if (claim.reachedLimit) await withdraw();
            throw invalidCode();
          }
          // The code is right, so this is the mailbox's owner. Only now is the password also judged against the
          // account's own details (name); the code is not spent by a refusal, so they can simply choose another.
          const problem = passwordProblem(password, { email: person!.email, name: person!.name });
          if (problem) throw fail("BAD_REQUEST", problem, "WEAK_PASSWORD");
          const verified = await db.transaction(async (tx) => {
            const [current] = await tx
              .select()
              .from(t.user)
              .where(eq(t.user.id, person!.id))
              .for("update");
            // Only a public signup that is still waiting for its address to be verified.
            if (!current || current.emailVerified || !current.emailVerificationRequired) return false;
            // Single use: whichever request deletes the row wins.
            const spent = await tx
              .delete(t.verification)
              .where(eq(t.verification.id, row!.id))
              .returning({ id: t.verification.id });
            if (!spent.length) return false;
            // The password the person typed with the code replaces whatever the signup(s) stored, locked or not.
            const replaced = await tx
              .update(t.account)
              .set({ password: passwordHash, updatedAt: now })
              .where(
                and(eq(t.account.userId, person!.id), eq(t.account.providerId, "credential")),
              )
              .returning({ id: t.account.id });
            if (!replaced.length)
              await tx.insert(t.account).values({
                id: crypto.randomUUID(),
                accountId: person!.id,
                providerId: "credential",
                userId: person!.id,
                password: passwordHash,
              });
            await tx
              .update(t.user)
              .set({ emailVerified: true, updatedAt: now })
              .where(eq(t.user.id, person!.id));
            // No session can exist for an unverified account; anything that does is ended all the same.
            const revoked = await tx
              .delete(t.session)
              .where(eq(t.session.userId, person!.id))
              .returning({ id: t.session.id });
            await tx
              .delete(t.verification)
              .where(eq(t.verification.identifier, otpIdentifier(email)));
            await supersedePendingEmails(tx, person!.id, "EMAIL_VERIFICATION_OTP");
            await tx
              .delete(t.signInThrottle)
              .where(eq(t.signInThrottle.key, throttleKey(secret, "sign-in", email)));
            await recordSecurityEvent(tx, {
              event: "EMAIL_VERIFIED",
              actorId: person!.id,
              targetUserId: person!.id,
              detail: { passwordSet: true, revokedSessions: revoked.length },
            });
            return true;
          });
          if (!verified) throw invalidCode();
          await clearFailures(key);
          // Deliberately no session: the person signs in next, with whatever their account requires.
          return ctx.json({ status: true });
        },
      ),

      resendVerification: createAuthEndpoint(
        "/onboarding/resend-verification",
        { method: "POST", body: z.object({ email: emailField }) },
        async (ctx) => {
          noStore(ctx);
          const { secret } = accountOf(ctx);
          if (!emailDeliveryConfigured())
            throw fail("SERVICE_UNAVAILABLE", ONBOARDING_MESSAGES.SIGNUP_UNAVAILABLE, "SIGNUP_UNAVAILABLE");
          const { email } = ctx.body;
          const now = new Date();
          const claim = await reserveAttempt(
            throttleKey(secret, "resend-verification", email),
            now,
            SEND_MAX_PER_WINDOW,
          );
          if (!claim.allowed) throw tooMany();
          await database().transaction(async (tx) => {
            const [person] = await tx
              .select()
              .from(t.user)
              .where(eq(t.user.email, email))
              .for("update");
            if (
              !person ||
              !person.emailVerificationRequired ||
              person.emailVerified ||
              (await withinCooldown(tx, person.id, "EMAIL_VERIFICATION_OTP", now))
            )
              return;
            await issueVerificationCode(tx, {
              userId: person.id,
              email,
              name: person.name,
              secret,
              now,
            });
          });
          kickAuthEmailDelivery(secret);
          return ctx.json(GENERIC_SIGNUP_RESPONSE);
        },
      ),

      forgotPassword: createAuthEndpoint(
        "/onboarding/forgot-password",
        { method: "POST", body: z.object({ email: emailField }) },
        async (ctx) => {
          noStore(ctx);
          const { secret } = accountOf(ctx);
          if (!emailDeliveryConfigured())
            throw fail("SERVICE_UNAVAILABLE", ONBOARDING_MESSAGES.RESET_UNAVAILABLE, "RESET_UNAVAILABLE");
          const { email } = ctx.body;
          const now = new Date();
          const claim = await reserveAttempt(
            throttleKey(secret, "forgot-password", email),
            now,
            SEND_MAX_PER_WINDOW,
          );
          if (!claim.allowed) throw tooMany();
          const origin = config().BETTER_AUTH_URL.replace(/\/+$/, "");
          await database().transaction(async (tx) => {
            const [person] = await tx
              .select()
              .from(t.user)
              .where(eq(t.user.email, email))
              .for("update");
            if (!person) return;
            const refusal = await resetEligibility(tx, person);
            if (refusal === "OWNER") {
              // Owners are recovered by the server operator, never by email.
              await recordSecurityEvent(tx, {
                event: "PASSWORD_RESET_REFUSED",
                targetUserId: person.id,
                detail: { reason: "OWNER_ACCOUNT", stage: "request" },
              });
              return;
            }
            if (refusal || (await withinCooldown(tx, person.id, "PASSWORD_RESET_LINK", now)))
              return;
            await tx
              .delete(t.verification)
              .where(eq(t.verification.identifier, resetIdentifier(person.id)));
            await supersedePendingEmails(tx, person.id, "PASSWORD_RESET_LINK");
            const id = crypto.randomUUID();
            const secretPart = randomBytes(32).toString("base64url");
            const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
            await tx.insert(t.verification).values({
              id,
              identifier: resetIdentifier(person.id),
              value: hashVerificationSecret("reset-token", secretPart, person.id, secret),
              expiresAt,
              createdAt: now,
              updatedAt: now,
            });
            // The token rides in the URL fragment: it is never sent to a server, a log or a Referer header.
            const link = `${origin}/reset-password#token=${id}.${secretPart}`;
            await enqueueAuthEmail(tx, {
              kind: "PASSWORD_RESET_LINK",
              userId: person.id,
              idempotencyKey: `password-reset:${id}`,
              payload: passwordResetEmail({ to: email, name: person.name, link }),
              expiresAt,
              authSecret: secret,
            });
            await recordSecurityEvent(tx, {
              event: "PASSWORD_RESET_REQUESTED",
              actorId: person.id,
              targetUserId: person.id,
            });
          });
          kickAuthEmailDelivery(secret);
          return ctx.json(GENERIC_RESET_RESPONSE);
        },
      ),

      resetPassword: createAuthEndpoint(
        "/onboarding/reset-password",
        {
          method: "POST",
          body: z.object({
            token: z.string().min(1).max(200),
            password: passwordField,
            mfaCode: z.string().trim().max(40).optional(),
          }),
        },
        async (ctx) => {
          noStore(ctx);
          const { secret } = accountOf(ctx);
          const input = ctx.body;
          const match = TOKEN.exec(input.token.trim());
          if (!match) throw invalidToken();
          const [, tokenId, tokenSecret] = match;
          const now = new Date();
          const db = database();
          const tokenKey = throttleKey(secret, "reset-token", tokenId);
          const claim = await reserveAttempt(tokenKey, now, VERIFY_MAX_ATTEMPTS);
          const withdraw = () =>
            db.delete(t.verification).where(eq(t.verification.id, tokenId));
          if (!claim.allowed) {
            await withdraw();
            throw tooMany();
          }
          const [row] = await db
            .select()
            .from(t.verification)
            .where(eq(t.verification.id, tokenId));
          const userId = row?.identifier.startsWith("password-reset:")
            ? row.identifier.slice("password-reset:".length)
            : null;
          const live = !!row && !!userId && row.expiresAt.getTime() > now.getTime();
          const valid = verifyVerificationSecret(
            live ? row!.value : hashVerificationSecret("reset-token", "none", "none", secret),
            "reset-token",
            tokenSecret,
            live ? userId! : "none",
            secret,
          );
          if (!live || !valid) {
            if (claim.reachedLimit) await withdraw();
            throw invalidToken();
          }
          const [person] = await db.select().from(t.user).where(eq(t.user.id, userId!));
          const refusal = person ? await resetEligibility(db, person) : "UNVERIFIED";
          if (!person || refusal) {
            // The account changed since the link was issued (made an owner, lost its password...).
            await withdraw();
            if (person && refusal === "OWNER")
              await recordSecurityEvent(db, {
                event: "PASSWORD_RESET_REFUSED",
                targetUserId: person.id,
                detail: { reason: "OWNER_ACCOUNT", stage: "complete" },
              });
            throw invalidToken();
          }
          const problem = passwordProblem(input.password, {
            email: person.email,
            name: person.name,
          });
          if (problem) throw fail("BAD_REQUEST", problem, "WEAK_PASSWORD");
          // Second factor: an account with an authenticator proves it here too. The link alone is not enough.
          let method: "totp" | "backup" | null = null;
          if (person.twoFactorEnabled) {
            if (!input.mfaCode || !isWellFormedSecondFactorCode(input.mfaCode))
              throw fail("UNPROCESSABLE_ENTITY", ONBOARDING_MESSAGES.MFA_CODE_REQUIRED, "MFA_CODE_REQUIRED");
            const mfaKey = throttleKey(secret, "reset-mfa", person.id);
            if (!(await reserveAttempt(mfaKey, now, VERIFY_MAX_ATTEMPTS)).allowed) throw tooMany();
            const result = await verifySecondFactorCode(
              ctx.context,
              person.id,
              input.mfaCode,
            );
            if (!result.ok) {
              await recordSecurityEvent(db, {
                event: "PASSWORD_RESET_REFUSED",
                actorId: person.id,
                targetUserId: person.id,
                detail: { reason: "SECOND_FACTOR_REJECTED", stage: "complete" },
              });
              throw invalidCode();
            }
            method = result.method;
            await clearFailures(mfaKey);
          }
          const passwordHash = await ctx.context.password.hash(input.password);
          const outcome = await db.transaction(async (tx) => {
            // Single use: whichever request deletes the row wins.
            const spent = await tx
              .delete(t.verification)
              .where(eq(t.verification.id, tokenId))
              .returning({ id: t.verification.id });
            if (!spent.length) return null;
            const replaced = await tx
              .update(t.account)
              .set({ password: passwordHash, updatedAt: now })
              .where(
                and(eq(t.account.userId, person.id), eq(t.account.providerId, "credential")),
              )
              .returning({ id: t.account.id });
            if (!replaced.length) return null;
            // A temporary password the owner issued is replaced by the person's own choice.
            const cleared = await tx
              .delete(t.temporaryCredential)
              .where(eq(t.temporaryCredential.userId, person.id))
              .returning({ userId: t.temporaryCredential.userId });
            // Every session ends: a stolen cookie must not survive a password reset.
            const revoked = await tx
              .delete(t.session)
              .where(eq(t.session.userId, person.id))
              .returning({ id: t.session.id });
            await tx
              .delete(t.verification)
              .where(eq(t.verification.identifier, resetIdentifier(person.id)));
            await supersedePendingEmails(tx, person.id, "PASSWORD_RESET_LINK");
            await tx
              .delete(t.signInThrottle)
              .where(
                inArray(t.signInThrottle.key, [
                  throttleKey(secret, "sign-in", person.email),
                  throttleKey(secret, "change-password", person.id),
                ]),
              );
            await recordSecurityEvent(tx, {
              event: "PASSWORD_RESET_COMPLETED",
              actorId: person.id,
              targetUserId: person.id,
              detail: {
                revokedSessions: revoked.length,
                wasTemporary: cleared.length > 0,
                secondFactor: method,
              },
            });
            return { revoked: revoked.length };
          });
          if (!outcome) throw invalidToken();
          await clearFailures(tokenKey);
          // Deliberately no session: the person signs in with the new password (and their authenticator).
          return ctx.json({ status: true, revokedSessions: outcome.revoked });
        },
      ),
    },
    rateLimit: [],
    $ERROR_CODES: {},
  } as unknown as BetterAuthPlugin;
}
