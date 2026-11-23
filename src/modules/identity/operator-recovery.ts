import { eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { config } from "../../shared/config";
import { installTemporaryCredential, removeAuthenticator } from "./credentials";
import { activeMemberships } from "./membership";
import { recordSecurityEvent } from "./security-events";
import { generateTemporaryPassword } from "./temporary-password";
export class RecoveryError extends Error {}
/**
 * Out-of-band recovery for the cases the in-application workflow deliberately cannot cover: the
 * only owner is locked out, an owner's authenticator and recovery codes are both gone, or a
 * temporary password expired for the last person who could issue another.
 *
 * Authority here is operator access to the server's database credentials, which is already the
 * highest authority in the system; the application cannot grant it to anyone. The result is never
 * weaker than a normal sign-in: it issues a temporary password (72 hours, one use, must be
 * replaced immediately), revokes every session, and leaves any authenticator in place unless the
 * operator explicitly removes it.
 */
/**
 * What the operator is about to recover, shown before anything changes so a mistyped address is
 * caught. Operator-only (the CLI): no application endpoint calls this, so it cannot be used to
 * find out whether an address has an account.
 */
export async function describeRecoveryTarget(email: string) {
  const [person] = await database()
    .select()
    .from(t.user)
    .where(eq(t.user.email, email.trim().toLowerCase()));
  if (!person) return null;
  const memberships = await activeMemberships(person.id);
  return {
    name: person.name,
    roles: memberships.map((m) => `${m.role} @ ${m.academyName}`),
    authenticatorEnrolled: !!person.twoFactorEnabled,
  };
}
export async function recoverAccount(input: {
  email: string;
  reason: string;
  resetAuthenticator: boolean;
  operator: string;
}) {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 500)
    throw new RecoveryError("Give a reason of 10 to 500 characters.");
  const db = database();
  const [person] = await db
    .select()
    .from(t.user)
    .where(eq(t.user.email, input.email.trim().toLowerCase()));
  // Same message for every miss; the operator already knows which address they typed.
  if (!person)
    throw new RecoveryError("No account matches that email address.");
  const memberships = await activeMemberships(person.id);
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const result = await db.transaction(async (tx) => {
    const issued = await installTemporaryCredential(tx, {
      userId: person.id,
      passwordHash,
      source: "OPERATOR_RECOVERY",
      issuedBy: null,
      secret: config().BETTER_AUTH_SECRET,
    });
    const authenticatorRemoved = input.resetAuthenticator
      ? await removeAuthenticator(tx, person.id)
      : false;
    await recordSecurityEvent(tx, {
      event: "OPERATOR_RECOVERY",
      academyId: memberships.length === 1 ? memberships[0].academyId : null,
      targetUserId: person.id,
      detail: {
        reason,
        operator: input.operator.slice(0, 80),
        expiresAt: issued.expiresAt.toISOString(),
        revokedSessions: issued.revokedSessions,
        authenticatorRemoved,
      },
    });
    return { issued, authenticatorRemoved };
  });
  return {
    userId: person.id,
    temporaryPassword,
    expiresAt: result.issued.expiresAt,
    revokedSessions: result.issued.revokedSessions,
    authenticatorRemoved: result.authenticatorRemoved,
  };
}
