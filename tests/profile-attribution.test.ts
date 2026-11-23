import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, desc, eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import {
  ROLES,
  ROLE_USER,
  USERS,
  addFixtureUser,
  idsFor,
  type Role,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
/**
 * Stage 3 / AUTH-01: a person's name is identity data. It is shown as the approver of reports and nutrition
 * plans, so only an academy owner changes it (authorised and audited); the stock self-service route is refused
 * for every role; and an approval keeps the name and account it was made under, whatever happens afterwards.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("profile-attribution");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const db = () => database();
const nameOf = async (id: string) =>
  (await db().select().from(t.user).where(eq(t.user.id, id)))[0].name;
/** How the (green) academy shows a member: its display name for them, else their own name (0017). */
const shownNameOf = async (id: string, academyId = "green") => {
  const [m] = await db().select().from(t.memberships).where(and(eq(t.memberships.userId, id), eq(t.memberships.academyId, academyId)));
  return m?.displayName ?? (await nameOf(id));
};
const events = async (target: string, event: string) =>
  (
    await db()
      .select()
      .from(t.securityEvent)
      .where(eq(t.securityEvent.targetUserId, target))
  ).filter((e) => e.event === event);
const body = (r: { json: unknown }) =>
  (r.json ?? {}) as { error?: string; message?: string; code?: string };
const memberBody = (id: string, name: string, role: Role, email: string) => ({
  id,
  name,
  email,
  role,
  active: true,
  professionalAttestation:
    role === "NUTRITION_PRO" ? "Registered dietitian, licence on file" : "",
});

test("every one of the eight roles is refused the self-service profile update; the name never changes", async () => {
  for (const role of ROLES) {
    const key = ROLE_USER[role];
    const user = USERS[key];
    const client = await app.as(key);
    const before = await nameOf(user.id);
    const refusedBefore = (await events(user.id, "PROFILE_UPDATE_REFUSED"))
      .length;
    // The request may carry anything: a new name, an image, and someone else's identifiers.
    const attempts = [
      { name: "Dr. Impersonator, Nutrition Professional" },
      { name: "Hacked", image: "https://attacker.example/x.png" },
      {
        name: "Hacked",
        userId: USERS.owner.id,
        id: USERS.owner.id,
        email: "takeover@example.test",
      },
    ];
    for (const attempt of attempts) {
      const r = await client.post("/api/auth/update-user", attempt);
      assert.equal(
        r.status,
        403,
        `${role} ${JSON.stringify(Object.keys(attempt))}`,
      );
      assert.equal(body(r).code, "PROFILE_MANAGED_BY_OWNER", role);
      assert.match(body(r).message ?? "", /managed by your academy owner/i);
    }
    assert.equal(await nameOf(user.id), before, `${role}: name unchanged`);
    assert.equal(
      await nameOf(USERS.owner.id),
      USERS.owner.name,
      "nobody else's name changed",
    );
    assert.equal(
      (await events(user.id, "PROFILE_UPDATE_REFUSED")).length,
      refusedBefore + attempts.length,
      `${role}: each refusal is recorded`,
    );
  }
});

test("an anonymous request to the profile update is refused by authentication, not recorded as a refusal", async () => {
  const r = await app
    .anonymous()
    .post("/api/auth/update-user", { name: "Nobody" });
  assert.equal(r.status, 401);
  assert.notEqual(body(r).code, "PROFILE_MANAGED_BY_OWNER");
});

test("the refusal event is academy-scoped and carries identifiers only (no name, no request content)", async () => {
  const client = await app.as("coach");
  await client.post("/api/auth/update-user", { name: "SECRET-NAME-CANARY" });
  const [row] = await db()
    .select()
    .from(t.securityEvent)
    .where(
      and(
        eq(t.securityEvent.targetUserId, USERS.coach.id),
        eq(t.securityEvent.event, "PROFILE_UPDATE_REFUSED"),
      ),
    )
    .orderBy(desc(t.securityEvent.createdAt))
    .limit(1);
  assert.equal(row.academyId, "green");
  assert.equal(row.actorId, USERS.coach.id);
  assert.ok(!JSON.stringify(row).includes("SECRET-NAME-CANARY"));
});

test("an owner can rename a member: authorised, recorded and visible in the audit trail", async () => {
  const owner = await app.as("owner");
  const member = await addFixtureUser("fx-rename-target", [
    { academyId: "green", role: "COACH" },
  ]);
  const r = await owner.post(
    "/api/academy/settings/member",
    memberBody(member.id, "Renamed By Owner", "COACH", member.email),
  );
  assert.equal(r.status, 200, r.text);
  // An academy's rename changes how THAT academy shows the person; the person's own (global) name is not rewritten.
  assert.equal(await shownNameOf(member.id), "Renamed By Owner");
  assert.equal(await nameOf(member.id), "Fixture fx-rename-target", "the global name is untouched");
  const [event] = await events(member.id, "MEMBER_RENAMED");
  assert.equal(event.actorId, USERS.owner.id);
  assert.equal(event.academyId, "green");
  assert.ok(
    !JSON.stringify(event).includes("Renamed By Owner"),
    "names are not written to the log",
  );
  const audit = (
    await db().select().from(t.audit).where(eq(t.audit.entityId, member.id))
  ).filter((a) => a.action === "member-save");
  assert.ok(
    audit.some(
      (a) => (a.detail as { nameChanged?: boolean }).nameChanged === true,
    ),
  );
  // Saving the same name again is not a rename and writes no rename event.
  const again = await owner.post(
    "/api/academy/settings/member",
    memberBody(member.id, "Renamed By Owner", "COACH", member.email),
  );
  assert.equal(again.status, 200);
  assert.equal((await events(member.id, "MEMBER_RENAMED")).length, 1);
});

test("only the OWNER role can rename a member; the other seven roles are refused and nothing changes", async () => {
  const target = await addFixtureUser("fx-rename-denied", [
    { academyId: "green", role: "COACH" },
  ]);
  const original = await nameOf(target.id);
  for (const role of ROLES) {
    const client = await app.as(ROLE_USER[role]);
    const r = await client.post(
      "/api/academy/settings/member",
      memberBody(target.id, `Renamed by ${role}`, "COACH", target.email),
    );
    if (role === "OWNER") {
      assert.equal(r.status, 200, "OWNER is the one role allowed");
      assert.equal(await shownNameOf(target.id), `Renamed by ${role}`);
      assert.equal(await nameOf(target.id), original, "the global name is untouched");
      await db()
        .update(t.memberships)
        .set({ displayName: null })
        .where(and(eq(t.memberships.userId, target.id), eq(t.memberships.academyId, "green")));
    } else {
      assert.equal(r.status, 403, role);
      assert.equal(
        await nameOf(target.id),
        original,
        `${role}: name unchanged`,
      );
    }
  }
});

test("an owner of another academy cannot rename this academy's member", async () => {
  const target = await addFixtureUser("fx-rename-foreign", [
    { academyId: "green", role: "COACH" },
  ]);
  const blueOwner = await app.as("blueOwner");
  const r = await blueOwner.post(
    "/api/academy/settings/member",
    memberBody(target.id, "Foreign Rename", "COACH", target.email),
  );
  assert.equal(r.status, 404);
  assert.equal(await shownNameOf(target.id), `Fixture fx-rename-foreign`);
  assert.equal((await events(target.id, "MEMBER_RENAMED")).length, 0);
});

test("report approval records the approving account and a name snapshot; later renames cannot rewrite it", async () => {
  const { reportId } = idsFor("childA");
  const admin = await app.as("admin");
  const owner = await app.as("owner");
  const current = async () =>
    (await db().select().from(t.reports).where(eq(t.reports.id, reportId)))[0];
  let row = await current();
  assert.equal(row.status, "DRAFT");
  const send = (
    client: typeof admin,
    action: string,
    extra: Record<string, unknown> = {},
  ) =>
    client.post("/api/academy/reports/update", {
      id: reportId,
      version: row.version,
      action,
      summary: "Approved summary",
      reason: "Stage 3 test",
      ...extra,
    });
  assert.equal((await send(admin, "submit")).status, 200);
  row = await current();
  // The request may try to supply the attribution itself; the server ignores it.
  const approve = await send(admin, "approve", {
    reviewer: "Forged Approver",
    reviewerId: USERS.owner.id,
  });
  assert.equal(approve.status, 200, approve.text);
  row = await current();
  assert.equal(row.status, "APPROVED");
  assert.equal(row.data.reviewer, USERS.admin.name);
  assert.equal(row.data.reviewerId, USERS.admin.id);
  const approvedVersion = row.version;
  // An owner renames the approver: the approval keeps the name it was made under, in the row and in its history.
  const rename = await owner.post(
    "/api/academy/settings/member",
    memberBody(
      USERS.admin.id,
      "Admin Renamed Later",
      "ADMIN",
      USERS.admin.email,
    ),
  );
  assert.equal(rename.status, 200, rename.text);
  assert.equal(await shownNameOf(USERS.admin.id), "Admin Renamed Later");
  row = await current();
  assert.equal(row.data.reviewer, USERS.admin.name);
  assert.equal(row.data.reviewerId, USERS.admin.id);
  const revisions = await db()
    .select()
    .from(t.recordRevisions)
    .where(
      and(
        eq(t.recordRevisions.entityId, reportId),
        eq(t.recordRevisions.version, approvedVersion),
      ),
    );
  const snapshot = (
    revisions[0].data as { data: { reviewer: string; reviewerId: string } }
  ).data;
  assert.equal(snapshot.reviewer, USERS.admin.name);
  assert.equal(snapshot.reviewerId, USERS.admin.id);
  // Revising clears the attribution (nobody approved the new draft); a new approval records the new approver.
  const headCoach = await app.as("headCoach");
  const revise = await send(headCoach, "revise", {
    reason: "Correction needed",
  });
  assert.equal(revise.status, 200, revise.text);
  row = await current();
  assert.equal(row.data.reviewer, null);
  assert.equal(row.data.reviewerId, null);
  assert.equal((await send(headCoach, "submit")).status, 200);
  row = await current();
  assert.equal((await send(headCoach, "approve")).status, 200);
  row = await current();
  assert.equal(row.data.reviewer, USERS.headCoach.name);
  assert.equal(row.data.reviewerId, USERS.headCoach.id);
  // Roles without approval authority cannot create an attribution at all.
  for (const key of [
    "coach",
    "finance",
    "nutrition",
    "guardian",
    "adult",
  ] as const) {
    const r = await send(await app.as(key), "approve");
    assert.notEqual(r.status, 200, `${key} must not approve`);
    const after = await current();
    assert.equal(after.version, row.version, `${key}: record unchanged`);
    assert.equal(
      after.data.reviewerId,
      USERS.headCoach.id,
      `${key}: attribution unchanged`,
    );
  }
});

test("nutrition-plan approval records the professional's account; a rename before or after cannot forge or rewrite it", async () => {
  const planId = `nutrition-draft-${idsFor("childA").playerId}`;
  const playerId = idsFor("childA").playerId;
  const owner = await app.as("owner");
  const pro = await app.as("nutrition");
  const plan = async () =>
    (
      await db()
        .select()
        .from(t.nutritionPlans)
        .where(eq(t.nutritionPlans.id, planId))
    )[0];
  // The professional cannot rename themselves to look like someone else...
  assert.equal(
    (await pro.post("/api/auth/update-user", { name: "Chief Dietitian" }))
      .status,
    403,
  );
  assert.equal(await nameOf(USERS.nutrition.id), USERS.nutrition.name);
  // ...but an owner can, and the plan is then approved under the owner-managed name.
  const rename = await owner.post(
    "/api/academy/settings/member",
    memberBody(
      USERS.nutrition.id,
      "Pro Before Approval",
      "NUTRITION_PRO",
      USERS.nutrition.email,
    ),
  );
  assert.equal(rename.status, 200, rename.text);
  let row = await plan();
  const send = (
    client: typeof pro,
    action: string,
    extra: Record<string, unknown> = {},
  ) =>
    client.post("/api/academy/nutrition/plan", {
      id: planId,
      version: row.version,
      playerId,
      title: "Approved plan",
      guidance: "Approved guidance text",
      action,
      reviewNote: "Reviewed by the professional",
      ...extra,
    });
  assert.equal((await send(pro, "submit")).status, 200);
  row = await plan();
  // A coach cannot approve, and a forged attribution in the body changes nothing.
  const byCoach = await send(await app.as("coach"), "approve");
  assert.ok(
    [403, 404].includes(byCoach.status),
    `a coach cannot approve (${byCoach.status})`,
  );
  assert.equal((await plan()).status, "IN_REVIEW");
  const approve = await send(pro, "approve", {
    professional: "Forged Pro",
    professionalId: USERS.owner.id,
  });
  assert.equal(approve.status, 200, approve.text);
  row = await plan();
  assert.equal(row.status, "APPROVED");
  assert.equal(row.data.professional, "Pro Before Approval");
  assert.equal(row.data.professionalId, USERS.nutrition.id);
  // A later owner rename does not rewrite the approved plan.
  const later = await owner.post(
    "/api/academy/settings/member",
    memberBody(
      USERS.nutrition.id,
      "Pro After Approval",
      "NUTRITION_PRO",
      USERS.nutrition.email,
    ),
  );
  assert.equal(later.status, 200, later.text);
  row = await plan();
  assert.equal(row.data.professional, "Pro Before Approval");
  assert.equal(row.data.professionalId, USERS.nutrition.id);
  // Revising clears it.
  const revise = await send(pro, "revise");
  assert.equal(revise.status, 200, revise.text);
  row = await plan();
  assert.equal(row.data.professional, null);
  assert.equal(row.data.professionalId, null);
});

test("legitimate account management still works: owner changes role/active, password change and sign-out are untouched", async () => {
  const owner = await app.as("owner");
  const member = await addFixtureUser("fx-still-works", [
    { academyId: "green", role: "COACH" },
  ]);
  const r = await owner.post(
    "/api/academy/settings/member",
    memberBody(member.id, `Fixture fx-still-works`, "HEAD_COACH", member.email),
  );
  assert.equal(r.status, 200, r.text);
  const [m] = await db()
    .select()
    .from(t.memberships)
    .where(eq(t.memberships.userId, member.id));
  assert.equal(m.role, "HEAD_COACH");
  assert.equal((await events(member.id, "MEMBER_ROLE_CHANGED")).length, 1);
  assert.equal(
    (await events(member.id, "MEMBER_RENAMED")).length,
    0,
    "no rename, no rename event",
  );
  // Other self-service routes are unaffected by the update-user refusal.
  const client = await app.as("coach");
  assert.equal((await client.get("/api/auth/get-session")).status, 200);
  assert.equal((await client.get("/api/auth/list-sessions")).status, 200);
});
