import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { database, closeDatabase } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
if (
  process.env.NODE_ENV === "production" ||
  process.env.ALLOW_DEV_SEED !== "true"
)
  throw new Error("Explicit development seeding only.");
const password = process.env.DEV_SEED_PASSWORD;
if (!password || password.length < 12)
  throw new Error("Set the local fictional seed password.");
const db = database();
await db.transaction(async (tx) => {
  for (const academyId of ["academy-green", "academy-blue"]) {
    const suffix = academyId === "academy-green" ? "greenfield" : "bluebird";
    const [academy] = await tx
      .select()
      .from(t.academies)
      .where(eq(t.academies.id, academyId));
    if (!academy) throw new Error("Run the foundation seed first.");
    await tx
      .insert(t.academySettings)
      .values({
        academyId,
        data: {
          ...defaultSettings,
          country: suffix === "bluebird" ? "US" : "IN",
          currency: suffix === "bluebird" ? "USD" : "INR",
        },
      })
      .onConflictDoNothing();
    await tx
      .insert(t.entitlements)
      .values({
        academyId,
        data: {
          reports: true,
          nutrition: true,
          communications: true,
          manualVideo: true,
        },
      })
      .onConflictDoNothing();
    for (const [slug, name, email, role] of [
      ["owner", "Academy Administrator", `admin@${suffix}.example`, "OWNER"],
      ["head", "Head Coach", `headcoach@${suffix}.example`, "HEAD_COACH"],
      [
        "nutrition",
        "Neha Kapoor",
        `nutrition@${suffix}.example`,
        "NUTRITION_PRO",
      ],
      ["guardian", "Priya Mehta", `priya@${suffix}.example`, "GUARDIAN"],
      ["guardian-two", "Raj Mehta", `raj@${suffix}.example`, "GUARDIAN"],
    ]) {
      const id = `${academyId}-${slug}`;
      await tx
        .insert(t.user)
        .values({ id, name, email, emailVerified: true })
        .onConflictDoNothing();
      const [old] = await tx
        .select()
        .from(t.account)
        .where(eq(t.account.userId, id));
      if (!old)
        await tx
          .insert(t.account)
          .values({
            id: `account-${id}`,
            accountId: id,
            providerId: "credential",
            userId: id,
            password: await hashPassword(password),
          });
      await tx
        .insert(t.memberships)
        .values({ academyId, userId: id, role })
        .onConflictDoNothing();
    }
    const players = await tx
      .select()
      .from(t.players)
      .where(eq(t.players.academyId, academyId));
    for (const player of players) {
      // Players are under 18 and have no login of their own: no seeded profile is an adult or has an own account.
      await tx
        .insert(t.profiles)
        .values({
          academyId,
          playerId: player.id,
          data: {
            ...defaultProfile,
            adult: false,
            selfUserId: null,
          },
        })
        .onConflictDoNothing();
    }
    for (const [playerId, userId] of [
      [`${academyId}-junior-p1`, `${academyId}-guardian`],
      [`${academyId}-junior-p2`, `${academyId}-guardian`],
      [`${academyId}-junior-p1`, `${academyId}-guardian-two`],
    ])
      await tx
        .insert(t.guardianLinks)
        .values({
          academyId,
          playerId,
          userId,
          relationship: "Parent",
          active: true,
          consent: { portal: true, email: false, whatsapp: false },
        })
        .onConflictDoNothing();
  }
});
console.log(
  "Seeded fictional operational roles, guardian links and subscription capabilities. Existing records were preserved.",
);
await closeDatabase();
