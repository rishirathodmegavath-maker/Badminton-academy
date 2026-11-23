import { and, eq } from "drizzle-orm";
import { database } from "../../infrastructure/database/client";
import { memberships, user } from "../../infrastructure/database/schema";

/**
 * "Continue with Google": configuration and the account-matching policy (see GOOGLE_SIGN_IN.md).
 *
 * The policy, in one place:
 *   1. Google creates an account only from the sign-up screen (`disableImplicitSignUp` + `requestSignUp`), only
 *      with the terms accepted, and only when Google reports the email as verified. That account is UNASSIGNED:
 *      it has no academy membership and gains none. Academy access is still given only by an owner.
 *   2. Google is NEVER linked implicitly from an email address (`disableImplicitLinking`). A person links their
 *      own Google account while signed in with their password, in Account security; Google must report that
 *      email as verified and it must equal the account's email.
 *   3. Only an owner-provisioned account (an active membership) or one with a verified email may hold a link.
 *   4. An account that has an authenticator app enrolled cannot start a session through Google: the two-factor
 *      library applies its second step to password sign-in only, so a Google session would skip it. Those people
 *      sign in with password and code.
 *   5. Everything else is unchanged: expired temporary passwords, the forced password change and the MFA
 *      enrolment gate, rate limits, session lifetime, and the security-event log all apply to a Google session.
 */
export type Env = Readonly<Record<string, string | undefined>>;

export type GoogleConfig =
  | { enabled: false; problem: string | null }
  | { enabled: true; clientId: string; clientSecret: string };

const present = (v: string | undefined) => (v ?? "").trim();

/** Both variables set -> enabled. Neither -> off. Exactly one -> off and reported as a problem. */
export function googleConfig(env: Env = process.env): GoogleConfig {
  const clientId = present(env.GOOGLE_CLIENT_ID);
  const clientSecret = present(env.GOOGLE_CLIENT_SECRET);
  if (clientId && clientSecret) return { enabled: true, clientId, clientSecret };
  if (clientId || clientSecret)
    return {
      enabled: false,
      problem: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together.",
    };
  return { enabled: false, problem: null };
}

/** Where Google must be told to send people back (shown in setup documentation and the config check). */
export const googleRedirectUri = (baseUrl: string) =>
  `${baseUrl.replace(/\/+$/, "")}/api/auth/callback/google`;

export * from "./google-messages";

type Db = Pick<ReturnType<typeof database>, "select">;

/** People an owner has provisioned (an active membership). */
export async function isProvisioned(userId: string, db: Db = database()) {
  const rows = await db
    .select({ academyId: memberships.academyId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.active, true)));
  return rows.length > 0;
}

/** Rule 3: an owner-provisioned person, or one whose email address has been verified, may hold a Google link. */
export async function mayHoldGoogle(userId: string, db: Db = database()) {
  if (await isProvisioned(userId, db)) return true;
  const [row] = await db
    .select({ verified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId));
  return !!row?.verified;
}

/** Rule 4: true when this person has an authenticator app and so must use password + code. */
export async function hasAuthenticator(userId: string, db: Db = database()) {
  const [row] = await db
    .select({ enabled: user.twoFactorEnabled })
    .from(user)
    .where(eq(user.id, userId));
  return !!row?.enabled;
}

/** The request paths on which Better Auth starts a session from a social provider. */
export const isSocialSessionPath = (path: string | undefined) =>
  !!path && (path.startsWith("/callback/") || path === "/sign-in/social");
