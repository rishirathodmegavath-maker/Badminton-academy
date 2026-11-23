/**
 * Adds the two roles the development seed does not create (ADMIN and FINANCE) to a DISPOSABLE copy of the
 * development database, so the browser tests can exercise all eight roles. It never runs against the real
 * development database or production: it requires E2E_DISPOSABLE=true and refuses the default dev path.
 *
 *   E2E_DISPOSABLE=true LOCAL_DATABASE_PATH=<copy> ALLOW_DEV_SEED=true DEV_SEED_PASSWORD=<fictional> \
 *     npx tsx scripts/seed-e2e-roles.ts
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSeedTarget } from "./lib/e2e-seed-guard";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { database, closeDatabase } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";

// The target rules live in a pure, tested function (scripts/lib/e2e-seed-guard.ts): a copied embedded database or
// a loopback PostgreSQL database named sportozen_e2e, never the real development database (compared without
// regard to case, trailing separators or `..` segments) and never production.
const decision = checkSeedTarget(process.env, [process.cwd(), dirname(fileURLToPath(import.meta.url)) + "/.."]);
if (!decision.ok)
  throw new Error(
    `Refusing: this script only seeds a disposable copy (${decision.reason}). It needs E2E_DISPOSABLE=true, ALLOW_DEV_SEED=true and either a copied embedded database or a loopback PostgreSQL database named sportozen_e2e.`,
  );

const password = process.env.DEV_SEED_PASSWORD;
if (!password || password.length < 12) throw new Error("Set the fictional seed password.");

const db = database();
await db.transaction(async (tx) => {
  for (const [slug, name, email, role] of [
    ["admin", "Admin Person", "admin2@greenfield.example", "ADMIN"],
    ["finance", "Finance Person", "finance@greenfield.example", "FINANCE"],
  ] as const) {
    const id = `academy-green-${slug}`;
    await tx.insert(t.user).values({ id, name, email, emailVerified: true }).onConflictDoNothing();
    const [old] = await tx.select().from(t.account).where(eq(t.account.userId, id));
    if (!old)
      await tx.insert(t.account).values({
        id: `account-${id}`,
        accountId: id,
        providerId: "credential",
        userId: id,
        password: await hashPassword(password),
      });
    await tx
      .insert(t.memberships)
      .values({ academyId: "academy-green", userId: id, role })
      .onConflictDoNothing();
    const [m] = await tx
      .select()
      .from(t.memberships)
      .where(and(eq(t.memberships.academyId, "academy-green"), eq(t.memberships.userId, id)));
    console.log(`${email} -> ${m?.role}`);
  }
});
await closeDatabase();
