import { and, eq } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { config } from "../../shared/config";
import { DomainError } from "../training/domain/rules";
import { clearFailures, reserveOwnerReauth, throttleKey } from "./sign-in-throttle";
/**
 * Password re-authentication for sensitive actions outside the authentication endpoints (Phase 8:
 * approving an erasure, placing or releasing a legal hold, approving a retention rule). It uses the
 * same per-person counter as the other owner actions (`owner-reauth`), claimed BEFORE the password is
 * checked so parallel guesses cannot all pass, and cleared on success.
 */
export async function reauthenticate(userId: string, password: unknown) {
  const refuse = () =>
    new DomainError("Your password was not accepted. Nothing was changed.", 403, "REAUTHENTICATION_FAILED");
  if (typeof password !== "string" || !password || password.length > 512) throw refuse();
  const key = throttleKey(config().BETTER_AUTH_SECRET, "owner-reauth", userId);
  if (!(await reserveOwnerReauth(key)).allowed)
    throw new DomainError("Too many attempts. Try again later.", 429, "TOO_MANY_ATTEMPTS");
  const [account] = await database()
    .select({ password: t.account.password })
    .from(t.account)
    .where(and(eq(t.account.userId, userId), eq(t.account.providerId, "credential")));
  const ok = !!account?.password && (await verifyPassword({ hash: account.password, password }));
  if (!ok) throw refuse();
  await clearFailures(key);
}
