import { and, eq } from "drizzle-orm";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { createOTP } from "@better-auth/utils/otp";
import { database } from "../../infrastructure/database/client";
import * as t from "../../infrastructure/database/schema";
import { claimTotpCode } from "./totp-replay";

const TOTP = /^\d{6}$/;
// Better Auth recovery codes are 10 letters/digits shown as XXXXX-XXXXX; the hyphen is optional when typed.
const BACKUP = /^[A-Za-z0-9]{5}-?[A-Za-z0-9]{5}$/;

export const isWellFormedSecondFactorCode = (code: string) => {
  const value = code.trim();
  return TOTP.test(value) || BACKUP.test(value);
};

type SecretContext = { secretConfig: Parameters<typeof symmetricDecrypt>[0]["key"] };

/**
 * Checks an authenticator code (or one single-use recovery code) for one account, with the same primitives and
 * key material Better Auth's two-factor plugin uses. Used by the password-recovery flow so that email access
 * alone can never replace a second factor. Returns false for anything that is not accepted; the caller owns the
 * attempt counting (the shared throttle) and the audit trail.
 *
 * A code is claimed for one use first (RFC 6238 5.2), so a replay inside the verification window is refused
 * even when it is otherwise valid. A recovery code is spent by a compare-and-set on the stored (encrypted)
 * list, so two requests cannot both use it.
 */
export async function verifySecondFactorCode(
  context: SecretContext,
  userId: string,
  rawCode: string,
): Promise<{ ok: true; method: "totp" | "backup" } | { ok: false }> {
  const code = rawCode.trim();
  if (!TOTP.test(code) && !BACKUP.test(code)) return { ok: false };
  const presented = TOTP.test(code)
    ? code
    : code.includes("-")
      ? code
      : `${code.slice(0, 5)}-${code.slice(5)}`;
  if (!(await claimTotpCode(userId, presented))) return { ok: false };
  const db = database();
  const [factor] = await db
    .select()
    .from(t.twoFactor)
    .where(eq(t.twoFactor.userId, userId));
  if (!factor || factor.verified !== true) return { ok: false };
  try {
    if (TOTP.test(presented)) {
      const secret = await symmetricDecrypt({
        key: context.secretConfig,
        data: factor.secret,
      });
      return (await createOTP(secret, { period: 30, digits: 6 }).verify(presented))
        ? { ok: true, method: "totp" }
        : { ok: false };
    }
    const stored = JSON.parse(
      await symmetricDecrypt({ key: context.secretConfig, data: factor.backupCodes }),
    ) as unknown;
    const codes = Array.isArray(stored)
      ? stored.filter((c): c is string => typeof c === "string")
      : [];
    if (!codes.includes(presented)) return { ok: false };
    const remaining = codes.filter((c) => c !== presented);
    const spent = await db
      .update(t.twoFactor)
      .set({
        backupCodes: await symmetricEncrypt({
          key: context.secretConfig,
          data: JSON.stringify(remaining),
        }),
      })
      .where(
        and(
          eq(t.twoFactor.id, factor.id),
          eq(t.twoFactor.backupCodes, factor.backupCodes),
        ),
      )
      .returning({ id: t.twoFactor.id });
    return spent.length === 1 ? { ok: true, method: "backup" } : { ok: false };
  } catch {
    // A secret that cannot be decrypted (rotated key, corrupted row) proves nothing.
    return { ok: false };
  }
}
