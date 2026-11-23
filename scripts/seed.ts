import { hashPassword } from "better-auth/crypto";
import { database, closeDatabase } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { eq } from "drizzle-orm";
if (
  process.env.NODE_ENV === "production" ||
  process.env.ALLOW_DEV_SEED !== "true"
)
  throw new Error(
    "Fictional seeding requires ALLOW_DEV_SEED=true outside production.",
  );
const password = process.env.DEV_SEED_PASSWORD;
if (!password || password.length < 12)
  throw new Error(
    "Set DEV_SEED_PASSWORD (12+ characters) in your local environment.",
  );
const db = database();
await db.transaction(async (tx) => {
  for (const [
    academyId,
    name,
    timezone,
    coachId,
    coachName,
    email,
    branchId,
    branchName,
  ] of [
    [
      "academy-green",
      "Greenfield Badminton Academy",
      "Asia/Kolkata",
      "coach-aman",
      "Aman Rao",
      "aman@greenfield.example",
      "branch-gurugram",
      "Gurugram",
    ],
    [
      "academy-blue",
      "Bluebird Badminton Academy",
      "America/New_York",
      "coach-maya",
      "Maya Chen",
      "maya@bluebird.example",
      "branch-brooklyn",
      "Brooklyn",
    ],
  ]) {
    await tx
      .insert(t.academies)
      .values({ id: academyId, name, timezone })
      .onConflictDoNothing();
    await tx
      .insert(t.user)
      .values({ id: coachId, name: coachName, email, emailVerified: true })
      .onConflictDoNothing();
    const [existing] = await tx
      .select()
      .from(t.account)
      .where(eq(t.account.userId, coachId));
    if (!existing)
      await tx
        .insert(t.account)
        .values({
          id: `account-${coachId}`,
          userId: coachId,
          accountId: coachId,
          providerId: "credential",
          password: await hashPassword(password),
        });
    await tx
      .insert(t.memberships)
      .values({ academyId, userId: coachId, role: "COACH" })
      .onConflictDoNothing();
    await tx
      .insert(t.branches)
      .values({ id: branchId, academyId, name: branchName })
      .onConflictDoNothing();
    for (const [slug, batchName] of [
      ["junior", "Junior Foundations"],
      ["intermediate", "Intermediate"],
    ]) {
      const batchId = `${academyId}-${slug}`;
      await tx
        .insert(t.batches)
        .values({ id: batchId, academyId, name: batchName, branchId, coachId })
        .onConflictDoNothing();
      const names =
        slug === "junior"
          ? [
              "Aarav Mehta",
              "Diya Sharma",
              "Kabir Singh",
              "Meera Kapoor",
              "Vihaan Nair",
              "Riya Patel",
            ]
          : ["Arjun Rao", "Isha Shah", "Dev Kumar", "Siya Verma"];
      for (let i = 0; i < names.length; i++)
        await tx
          .insert(t.players)
          .values({
            id: `${batchId}-p${i + 1}`,
            academyId,
            batchId,
            name: names[i],
          })
          .onConflictDoNothing();
    }
  }
  // The 50-drill library is built in (src/modules/training/domain/catalogue) and
  // is served by the training service, so it is not seeded into the database.
  await tx
    .insert(t.user)
    .values({
      id: "nonmember",
      name: "Unassigned Staff",
      email: "unassigned@example.test",
      emailVerified: true,
    })
    .onConflictDoNothing();
  const [nonmemberAccount] = await tx
    .select()
    .from(t.account)
    .where(eq(t.account.userId, "nonmember"));
  if (!nonmemberAccount)
    await tx
      .insert(t.account)
      .values({
        id: "account-nonmember",
        userId: "nonmember",
        accountId: "nonmember",
        providerId: "credential",
        password: await hashPassword(password),
      });
});
console.log(
  "Seeded two fictional academies, assigned staff, players and sample drills. Passwords were not printed.",
);
await closeDatabase();
await import('./seed-operations');
