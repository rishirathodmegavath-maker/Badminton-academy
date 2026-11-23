import { createHash } from "node:crypto";
import { lt } from "drizzle-orm";
import { database } from "../../infrastructure/database/client";
import { totpUsed } from "../../infrastructure/database/schema";
// Better Auth accepts the current code and one step either side (about 90 seconds).
const CLAIM_MS = 120_000;
/**
 * Claims an authenticator code for one use. Returns false when this account has already presented
 * the same code recently (RFC 6238, section 5.2). The insert is atomic, so two simultaneous
 * requests carrying one code cannot both win. A wrong code is claimed too, which is harmless: it
 * would be rejected anyway.
 */
export async function claimTotpCode(
  userId: string,
  code: string,
  now = new Date(),
) {
  const db = database();
  await db.delete(totpUsed).where(lt(totpUsed.expiresAt, now));
  const rows = await db
    .insert(totpUsed)
    .values({
      userId,
      codeHash: createHash("sha256").update(code.trim()).digest("hex"),
      expiresAt: new Date(now.getTime() + CLAIM_MS),
    })
    .onConflictDoNothing()
    .returning({ userId: totpUsed.userId });
  return rows.length === 1;
}
