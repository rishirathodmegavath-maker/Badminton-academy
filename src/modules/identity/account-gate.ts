import { eq } from "drizzle-orm";
import { database } from "../../infrastructure/database/client";
import { temporaryCredential } from "../../infrastructure/database/schema";
import { mfaStanding } from "./mfa-policy-store";
export type GateCode =
  | "PASSWORD_CHANGE_REQUIRED"
  | "TEMPORARY_PASSWORD_EXPIRED"
  | "MFA_ENROLLMENT_REQUIRED";
export type Gate = { code: GateCode; message: string };
export const GATE_MESSAGES: Record<GateCode, string> = {
  PASSWORD_CHANGE_REQUIRED:
    "You must replace your temporary password before continuing.",
  TEMPORARY_PASSWORD_EXPIRED:
    "This temporary password has expired. Ask your academy owner to issue a new one.",
  MFA_ENROLLMENT_REQUIRED:
    "Two-factor authentication is required for your role. Set it up before continuing.",
};
/**
 * The single answer to "may this signed-in account use the application right now?". It is applied
 * both to the application APIs (resolveActor) and to every Better Auth endpoint (account-security
 * plugin), so a gated account cannot reach protected functionality through either door.
 *
 * Order matters: a temporary password is replaced first, then a required enrolment follows.
 * Absent rows mean a normal account: accounts that existed before this feature are unaffected.
 */
export async function accountGate(
  account: {
    userId: string;
    twoFactorEnabled: boolean;
    /** The person's ACTIVE memberships (every one counts; the strictest requirement applies). */
    memberships: readonly { academyId: string; role: string }[];
  },
  options: { now?: Date } = {},
): Promise<Gate | null> {
  const now = options.now ?? new Date();
  const [temporary] = await database()
    .select()
    .from(temporaryCredential)
    .where(eq(temporaryCredential.userId, account.userId));
  if (temporary) {
    const code: GateCode =
      temporary.expiresAt.getTime() <= now.getTime()
        ? "TEMPORARY_PASSWORD_EXPIRED"
        : "PASSWORD_CHANGE_REQUIRED";
    return { code, message: GATE_MESSAGES[code] };
  }
  // Two-factor policy: deployment setting and academy policy, strictest wins (mfa-policy.ts). The
  // one place this is decided, for application APIs and authentication endpoints alike.
  if (
    !account.twoFactorEnabled &&
    (await mfaStanding(account.memberships)).level === "required"
  )
    return {
      code: "MFA_ENROLLMENT_REQUIRED",
      message: GATE_MESSAGES.MFA_ENROLLMENT_REQUIRED,
    };
  return null;
}
/** Better Auth endpoints a gated session may still call (everything else is refused). */
const ALLOWED: Record<GateCode, readonly string[]> = {
  TEMPORARY_PASSWORD_EXPIRED: [
    "/get-session",
    "/sign-out",
    "/account/security-state",
  ],
  PASSWORD_CHANGE_REQUIRED: [
    "/get-session",
    "/sign-out",
    "/account/security-state",
    "/account/change-password",
  ],
  MFA_ENROLLMENT_REQUIRED: [
    "/get-session",
    "/sign-out",
    "/account/security-state",
    "/account/change-password",
    "/two-factor/enable",
    "/two-factor/verify-totp",
  ],
};
export const gateAllowsPath = (code: GateCode, path: string) =>
  ALLOWED[code].includes(path);
