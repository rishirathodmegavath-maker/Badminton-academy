import { and, eq } from "drizzle-orm";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { DomainError } from "../training/domain/rules";
import { auth } from "./auth";
import { PASSWORD_MAX_LENGTH } from "./password-policy";
import { recordSecurityEvent } from "./security-events";
import { clearFailures, reserveOwnerReauth, throttleKey } from "./sign-in-throttle";
import { claimTotpCode } from "./totp-replay";
/**
 * RC-2 / TD-1 and TD-2: in-request password + second-factor confirmation for granting or removing
 * OWNER (FINAL_PERMISSION_MATRIX `members.grantOwner`, "Re-Auth").
 *
 * Why not Better Auth's /two-factor/verify-totp: from a signed-in session that endpoint skips its
 * lockout and attempt accounting (finding F-14) and leaves no proof the server could check later.
 * This routine performs the same verification itself, with the same primitives and key material
 * Better Auth uses (`symmetricDecrypt` with the context's `secretConfig`, `createOTP` with the
 * configured 6 digits / 30 s and its default +-1 step window), inside the request that makes the
 * change, and with this application's own controls:
 *
 *  1. enrolment: an owner without a verified authenticator is refused outright (403
 *     MFA_ENROLLMENT_REQUIRED_FOR_OWNER_CHANGE; PD-1 Option A, no password-only fallback);
 *  2. both credentials present and well formed, else 422 (no attempt is consumed);
 *  3. one attempt claimed on the shared `owner-reauth` counter BEFORE anything is checked
 *     (5 failures -> 15-minute lock, 429 TOO_MANY_ATTEMPTS);
 *  4. the code claimed for one use (`claimTotpCode`, atomic insert): a replay inside the
 *     verification window is refused even if the code is otherwise valid;
 *  5. password verified with Better Auth's configured hasher;
 *  6. a 6-digit code is checked as TOTP; anything else as a recovery code, which is consumed by a
 *     compare-and-set on the stored (encrypted) list, so two requests cannot both spend it;
 *  7. success clears the counter; every refusal is written to the security log
 *     (OWNER_CHANGE_REAUTH_FAILED, identifiers and a reason only, never a credential).
 *
 * Runs before the member change's transaction (slow hashing and decryption hold no locks).
 */
export type OwnerChange = "GRANT" | "REVOKE";
export type StepUpMethod = "password+totp" | "password+backup";
export const STEP_UP_REFUSED =
  "Your password or authenticator code was not accepted. Nothing was changed.";
export const MFA_ENROLLMENT_REQUIRED_MESSAGE =
  "Enrolling multi-factor authentication (MFA) is required before modifying owner memberships. Enroll MFA in your Account Settings.";
const TOTP = /^\d{6}$/;
// Better Auth recovery codes are 10 letters/digits shown as XXXXX-XXXXX; the hyphen is optional when typed.
const BACKUP = /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/;
type Failure =
  | "MFA_NOT_ENROLLED"
  | "CREDENTIALS_MISSING"
  | "TOO_MANY_ATTEMPTS"
  | "CODE_REPLAYED"
  | "PASSWORD_REJECTED"
  | "CODE_REJECTED";
export async function verifyOwnerMfaStepUp(input: {
  actorId: string;
  academyId: string;
  ownerPassword: unknown;
  mfaCode: unknown;
  change: OwnerChange;
  /** The member being changed, when already a member of this academy (null for a new account). */
  targetUserId: string | null;
}): Promise<{ method: StepUpMethod }> {
  const db = database();
  const refuse = async (reason: Failure, error: DomainError): Promise<never> => {
    await recordSecurityEvent(db, {
      event: "OWNER_CHANGE_REAUTH_FAILED",
      academyId: input.academyId,
      actorId: input.actorId,
      targetUserId: input.targetUserId,
      detail: { reason, change: input.change },
    });
    throw error;
  };
  const [person] = await db
    .select({ twoFactorEnabled: t.user.twoFactorEnabled })
    .from(t.user)
    .where(eq(t.user.id, input.actorId));
  const [factor] = await db
    .select()
    .from(t.twoFactor)
    .where(eq(t.twoFactor.userId, input.actorId));
  if (!person?.twoFactorEnabled || !factor || factor.verified !== true)
    return refuse(
      "MFA_NOT_ENROLLED",
      new DomainError(MFA_ENROLLMENT_REQUIRED_MESSAGE, 403, "MFA_ENROLLMENT_REQUIRED_FOR_OWNER_CHANGE"),
    );
  const password = input.ownerPassword;
  const code = typeof input.mfaCode === "string" ? input.mfaCode.trim() : "";
  if (
    typeof password !== "string" ||
    password.length < 1 ||
    password.length > PASSWORD_MAX_LENGTH ||
    !(TOTP.test(code) || BACKUP.test(code))
  )
    return refuse(
      "CREDENTIALS_MISSING",
      new DomainError(
        "Granting or removing owner access needs your password and a current authenticator code (or one recovery code).",
        422,
        "REAUTHENTICATION_REQUIRED",
      ),
    );
  const context = await auth().$context;
  const key = throttleKey(context.secret, "owner-reauth", input.actorId);
  if (!(await reserveOwnerReauth(key)).allowed)
    return refuse(
      "TOO_MANY_ATTEMPTS",
      new DomainError("Too many attempts. Try again later.", 429, "TOO_MANY_ATTEMPTS"),
    );
  const rejected = () => new DomainError(STEP_UP_REFUSED, 403, "REAUTHENTICATION_FAILED");
  const presented = TOTP.test(code) ? code : code.includes("-") ? code : `${code.slice(0, 5)}-${code.slice(5)}`;
  if (!(await claimTotpCode(input.actorId, presented))) return refuse("CODE_REPLAYED", rejected());
  const [account] = await db
    .select({ password: t.account.password })
    .from(t.account)
    .where(and(eq(t.account.userId, input.actorId), eq(t.account.providerId, "credential")));
  const passwordOk =
    !!account?.password && (await context.password.verify({ hash: account.password, password }));
  if (!passwordOk) return refuse("PASSWORD_REJECTED", rejected());
  let method: StepUpMethod | null = null;
  try {
    if (TOTP.test(presented)) {
      const secret = await symmetricDecrypt({ key: context.secretConfig, data: factor.secret });
      if (await createOTP(secret, { period: 30, digits: 6 }).verify(presented)) method = "password+totp";
    } else {
      const stored = JSON.parse(
        await symmetricDecrypt({ key: context.secretConfig, data: factor.backupCodes }),
      ) as unknown;
      const codes = Array.isArray(stored) ? stored.filter((c): c is string => typeof c === "string") : [];
      if (codes.includes(presented)) {
        const remaining = codes.filter((c) => c !== presented);
        const spent = await db
          .update(t.twoFactor)
          .set({
            backupCodes: await symmetricEncrypt({
              key: context.secretConfig,
              data: JSON.stringify(remaining),
            }),
          })
          // Compare-and-set on the list that was read: a concurrent use of the same code updates
          // nothing here and is refused.
          .where(and(eq(t.twoFactor.id, factor.id), eq(t.twoFactor.backupCodes, factor.backupCodes)))
          .returning({ id: t.twoFactor.id });
        if (spent.length === 1) {
          method = "password+backup";
          await recordSecurityEvent(db, {
            event: "MFA_RECOVERY_CODE_USED",
            academyId: input.academyId,
            actorId: input.actorId,
            targetUserId: input.actorId,
            detail: { purpose: "OWNER_CHANGE", remaining: remaining.length },
          });
        }
      }
    }
  } catch {
    // A secret that cannot be decrypted (rotated key, corrupted row) proves nothing.
    method = null;
  }
  if (!method) return refuse("CODE_REJECTED", rejected());
  await clearFailures(key);
  return { method };
}
