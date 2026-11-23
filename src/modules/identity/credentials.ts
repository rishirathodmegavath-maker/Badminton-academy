import { and, eq, inArray } from "drizzle-orm";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { temporaryPasswordExpiry } from "./temporary-password";
import { throttleKey } from "./sign-in-throttle";
export type Tx = Parameters<
  Parameters<ReturnType<typeof database>["transaction"]>[0]
>[0];
export type TemporarySource =
  "OWNER_RESET" | "MEMBER_CREATED" | "OPERATOR_RECOVERY";
/**
 * Replaces an account's password with an already-hashed temporary one, in the caller's transaction:
 * the previous credential stops working, every session of the account is revoked, the temporary
 * marker (72 hours) is recorded, and the account's throttles are cleared so the person can use the new
 * password at once. Only the hash is stored; the plaintext never reaches this function.
 *
 * Returns how many sessions were revoked and when the credential expires.
 */
export async function installTemporaryCredential(
  tx: Tx,
  input: {
    userId: string;
    passwordHash: string;
    source: TemporarySource;
    issuedBy: string | null;
    secret: string;
    now?: Date;
    /** Create the credential account when none exists (new members only). */
    createAccount?: boolean;
  },
) {
  const now = input.now ?? new Date();
  const expiresAt = temporaryPasswordExpiry(now);
  const credential = and(
    eq(t.account.userId, input.userId),
    eq(t.account.providerId, "credential"),
  );
  const updated = await tx
    .update(t.account)
    .set({ password: input.passwordHash, updatedAt: now })
    .where(credential)
    .returning({ id: t.account.id });
  if (!updated.length) {
    if (!input.createAccount)
      throw new Error("The account has no password credential to replace.");
    await tx.insert(t.account).values({
      id: crypto.randomUUID(),
      accountId: input.userId,
      providerId: "credential",
      userId: input.userId,
      password: input.passwordHash,
    });
  }
  const revoked = await tx
    .delete(t.session)
    .where(eq(t.session.userId, input.userId))
    .returning({ id: t.session.id });
  await tx
    .insert(t.temporaryCredential)
    .values({
      userId: input.userId,
      issuedBy: input.issuedBy,
      source: input.source,
      issuedAt: now,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: t.temporaryCredential.userId,
      set: {
        issuedBy: input.issuedBy,
        source: input.source,
        issuedAt: now,
        expiresAt,
      },
    });
  // Every per-account counter that could keep this person from using the new credential: the
  // sign-in pause, and the pauses on the two re-authentication prompts. Without the latter, someone
  // locked out of "change password" by wrong guesses would receive a temporary password they must
  // replace and still be refused for up to 15 minutes.
  const [person] = await tx
    .select({ email: t.user.email })
    .from(t.user)
    .where(eq(t.user.id, input.userId));
  if (person)
    await tx
      .delete(t.signInThrottle)
      .where(
        inArray(t.signInThrottle.key, [
          throttleKey(input.secret, "sign-in", person.email),
          throttleKey(input.secret, "change-password", input.userId),
          throttleKey(input.secret, "owner-reauth", input.userId),
        ]),
      );
  return { expiresAt, revokedSessions: revoked.length };
}
/** Removes the authenticator (and its recovery codes) so the person can enrol a new one. */
export async function removeAuthenticator(tx: Tx, userId: string) {
  const removed = await tx
    .delete(t.twoFactor)
    .where(eq(t.twoFactor.userId, userId))
    .returning({ id: t.twoFactor.id });
  await tx
    .update(t.user)
    .set({ twoFactorEnabled: false, updatedAt: new Date() })
    .where(eq(t.user.id, userId));
  await tx.delete(t.totpUsed).where(eq(t.totpUsed.userId, userId));
  return removed.length > 0;
}
