import { createHash } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { database } from "../../src/infrastructure/database/client";
import { STORED_ROLES } from "../../src/modules/identity/authority";
import * as t from "../../src/infrastructure/database/schema";
import { defaultSettings } from "../../src/modules/academy/domain/types";
import { privateFiles } from "../../src/infrastructure/storage/private-files";
/**
 * Fictional role fixtures and deterministic canary data. Nothing here resembles real people:
 * every value is obviously synthetic and unique so that a substring search of any API response
 * proves, or disproves, a disclosure.
 *
 * Worlds:
 *   green  all eight roles, two families, an adult player, every record type populated
 *   blue   a second tenant with owner, coach, guardian and the same record types populated
 *   quiet  a brand-new academy with only an owner (empty-collection behaviour)
 */
export const ROLES = [
  "OWNER",
  "ADMIN",
  "HEAD_COACH",
  "COACH",
  "FINANCE",
  "NUTRITION_PRO",
  "GUARDIAN",
  "ADULT_PLAYER",
] as const;
export type Role = (typeof ROLES)[number];
export type AcademyId = "green" | "blue" | "quiet";
/** Throw-away password for fixture accounts that exist only in disposable test databases. */
export const FIXTURE_PASSWORD = "Fixture-Only-Pa55word-2468";
export type FixtureUserKey =
  | "owner"
  | "admin"
  | "headCoach"
  | "coach"
  | "finance"
  | "nutrition"
  | "nutrition2"
  | "guardian"
  | "guardian2"
  | "adult"
  | "blueOwner"
  | "blueCoach"
  | "blueGuardian"
  | "blueNutrition"
  | "quietOwner";
type FixtureUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  academyId: AcademyId;
};
const user = (
  key: string,
  role: Role,
  academyId: AcademyId = "green",
): FixtureUser => ({
  id: `fx-${key}`,
  name: `Fixture ${key}`,
  // `fx-` prefix keeps every address free of substring overlap (e.g. owner vs blue-owner).
  email: `fx-${key}.canary@example.test`,
  role,
  academyId,
});
export const USERS: Record<FixtureUserKey, FixtureUser> = {
  owner: user("owner", "OWNER"),
  admin: user("admin", "ADMIN"),
  headCoach: user("head-coach", "HEAD_COACH"),
  coach: user("coach", "COACH"),
  finance: user("finance", "FINANCE"),
  nutrition: user("nutrition", "NUTRITION_PRO"),
  // A second professional in the same academy, assigned only to the second child.
  nutrition2: user("nutrition-two", "NUTRITION_PRO"),
  guardian: user("guardian-one", "GUARDIAN"),
  guardian2: user("guardian-two", "GUARDIAN"),
  adult: user("adult-player", "ADULT_PLAYER"),
  blueOwner: user("blue-owner", "OWNER", "blue"),
  blueCoach: user("blue-coach", "COACH", "blue"),
  blueGuardian: user("blue-guardian", "GUARDIAN", "blue"),
  blueNutrition: user("blue-nutrition", "NUTRITION_PRO", "blue"),
  quietOwner: user("quiet-owner", "OWNER", "quiet"),
};
/** The primary green-academy account for each of the eight roles. */
export const ROLE_USER: Record<Role, FixtureUserKey> = {
  OWNER: "owner",
  ADMIN: "admin",
  HEAD_COACH: "headCoach",
  COACH: "coach",
  FINANCE: "finance",
  NUTRITION_PRO: "nutrition",
  GUARDIAN: "guardian",
  ADULT_PLAYER: "adult",
};
const FULL_KINDS = [
  "name",
  "notes",
  "phone",
  "email",
  "birthDate",
  "allergy",
  "question",
  "reportPublished",
  "reportDraft",
  "nutritionShared",
  "nutritionDraft",
  "conversation",
  "history",
  "invoice",
  "event",
  // sessions, reviews, goals
  "sessionObjective",
  "sessionNote",
  "sessionRecap",
  "reviewText",
  "goal",
  // communications
  "messageSubject",
  "messageBody",
  "template",
  // media
  "mediaShared",
  "mediaFeedback",
  "mediaPrivate",
  "mediaPrivateFeedback",
  // money
  "feePlan",
  "paymentRef",
  "refundReason",
  "creditReason",
  // operations
  "auditAction",
] as const;
type Kind = (typeof FULL_KINDS)[number];
const ADULT_KINDS: Kind[] = [
  "name",
  "notes",
  "phone",
  "email",
  "birthDate",
  "history",
];
function subject(
  tag: string,
  birthDate: string,
  kinds: readonly Kind[] = FULL_KINDS,
) {
  const all: Record<Kind, string> = {
    name: `Canary ${tag}`,
    notes: `CANARY-NOTES-${tag}`,
    phone: `+91-00000-${tag}`,
    email: `canary.${tag.toLowerCase()}@example.test`,
    birthDate,
    allergy: `CANARY-ALLERGY-${tag}`,
    question: `CANARY-QUESTION-${tag}`,
    reportPublished: `CANARY-REPORT-PUBLISHED-${tag}`,
    reportDraft: `CANARY-REPORT-DRAFT-${tag}`,
    nutritionShared: `CANARY-NUTRITION-SHARED-${tag}`,
    nutritionDraft: `CANARY-NUTRITION-DRAFT-${tag}`,
    conversation: `CANARY-CONVERSATION-${tag}`,
    history: `CANARY-HISTORY-${tag}`,
    invoice: `CANARY-INVOICE-${tag}`,
    event: `CANARY-EVENT-${tag}`,
    sessionObjective: `CANARY-SESSION-OBJECTIVE-${tag}`,
    sessionNote: `CANARY-SESSION-NOTE-${tag}`,
    sessionRecap: `CANARY-SESSION-RECAP-${tag}`,
    reviewText: `CANARY-REVIEW-${tag}`,
    goal: `CANARY-GOAL-${tag}`,
    messageSubject: `CANARY-MESSAGE-SUBJECT-${tag}`,
    messageBody: `CANARY-MESSAGE-BODY-${tag}`,
    template: `CANARY-TEMPLATE-${tag}`,
    mediaShared: `CANARY-MEDIA-SHARED-${tag}.png`,
    mediaFeedback: `CANARY-MEDIA-FEEDBACK-${tag}`,
    mediaPrivate: `CANARY-MEDIA-PRIVATE-${tag}.png`,
    mediaPrivateFeedback: `CANARY-MEDIA-PRIVATE-FEEDBACK-${tag}`,
    feePlan: `CANARY-FEEPLAN-${tag}`,
    paymentRef: `CANARY-PAYMENT-REF-${tag}`,
    refundReason: `CANARY-REFUND-${tag}`,
    creditReason: `CANARY-CREDIT-${tag}`,
    auditAction: `CANARY-AUDIT-${tag}`,
  };
  return Object.fromEntries(kinds.map((k) => [k, all[k]])) as Record<
    Kind,
    string
  >;
}
export const CANARY = {
  childA: subject("ALPHA", "2014-02-03"),
  // template and fee plan are academy-level records, seeded once per academy (with the first child)
  childB: subject(
    "BRAVO",
    "2013-07-09",
    FULL_KINDS.filter((k) => k !== "template" && k !== "feePlan"),
  ),
  adult: subject("ADULT", "1990-01-02", ADULT_KINDS),
  blue: subject("BLUE", "2012-12-12"),
  enquiry: {
    name: "Canary ENQUIRER",
    email: "canary.enquirer@example.test",
    phone: "+91-00000-ENQ",
    notes: "CANARY-ENQUIRY-NOTES",
  },
};
/** Every canary value belonging to a subject. */
export const canaryValues = (s: Record<string, string>) => Object.values(s);
export const SUBJECT_IDS = {
  childA: "fx-child-alpha",
  childB: "fx-child-bravo",
  adult: "fx-adult-player-record",
  blue: "fx-child-blue",
};
/** Deterministic ids for records whose id format is constrained (private media keys are UUIDs). */
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const MEDIA_IDS = {
  childA: { shared: uuid(101), private: uuid(102) },
  childB: { shared: uuid(201), private: uuid(202) },
  blue: { shared: uuid(301), private: uuid(302) },
};
/** Ids of the per-child records that tests address directly (cross-tenant ID tests). */
export const idsFor = (subjectKey: "childA" | "childB" | "blue") => {
  const pid = SUBJECT_IDS[subjectKey];
  return {
    playerId: pid,
    reportId: `report-${pid}`,
    nutritionPlanId: `nutrition-shared-${pid}`,
    invoiceId: `invoice-${pid}`,
    paymentId: `payment-${pid}`,
    sessionId: `session-${pid}`,
    conversationId: `conversation-${pid}`,
    media: MEDIA_IDS[subjectKey],
  };
};
const consent = (portal: boolean, email: boolean, whatsapp: boolean) => ({
  portal,
  email,
  whatsapp,
});
/**
 * Extra account for tests that change memberships (deactivate, re-role, no or several academies)
 * without disturbing the shared role fixtures.
 */
export async function addFixtureUser(
  id: string,
  memberships: { academyId: AcademyId; role: Role; active?: boolean }[],
) {
  const db = database();
  const email = `${id}.canary@example.test`;
  await db
    .insert(t.user)
    .values({ id, name: `Fixture ${id}`, email, emailVerified: true });
  await db.insert(t.account).values({
    id: `account-${id}`,
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashPassword(FIXTURE_PASSWORD),
  });
  for (const m of memberships) {
    const row = { academyId: m.academyId, userId: id, role: m.role, active: m.active ?? true };
    if ((STORED_ROLES as readonly string[]).includes(m.role)) await db.insert(t.memberships).values(row);
    else await insertLegacyRoleMembership(row);
  }
  return { id, email };
}
/**
 * RC-3 (0013): membership_role_known makes an unknown role impossible to store. AT-6 still proves the application
 * refuses such a row, as one stored before 0013 or left after its rollback would be. To create that legacy row, one
 * transaction drops the constraint, inserts the row, and re-adds the identical constraint NOT VALID: every later
 * insert or update is checked exactly as before; only this pre-existing row is exempt.
 */
async function insertLegacyRoleMembership(row: typeof t.memberships.$inferInsert) {
  await database().transaction(async (tx) => {
    await tx.execute(sql`ALTER TABLE "membership" DROP CONSTRAINT "membership_role_known"`);
    await tx.insert(t.memberships).values(row);
    await tx.execute(
      sql`ALTER TABLE "membership" ADD CONSTRAINT "membership_role_known" CHECK ("membership"."role" IN ('OWNER','ADMIN','HEAD_COACH','COACH','FINANCE','NUTRITION_PRO','GUARDIAN','ADULT_PLAYER')) NOT VALID`,
    );
  });
}
const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.alloc(64, 1),
]);
const mediaKey = (academyId: string, id: string) =>
  `${createHash("sha256").update(academyId).digest("hex").slice(0, 16)}/${id}`;
type Family = {
  key: "childA" | "childB" | "blue";
  academyId: AcademyId;
  batchId: string;
  coach: FixtureUser;
  guardian: FixtureUser;
  finance: FixtureUser;
  portal: boolean;
};
/**
 * Inserts the complete fixture world into the already-migrated database. Child ALPHA belongs to
 * guardian one, BRAVO to guardian two, ADULT is a self-managed adult, BLUE lives in the other
 * academy. Direct inserts (not services) are deliberate: fixtures must not depend on the code
 * under test, and they place each record in exactly the shape the services persist.
 */
export async function seedFixtures() {
  const db = database();
  const password = await hashPassword(FIXTURE_PASSWORD);
  await db.transaction(async (tx) => {
    await tx.insert(t.academies).values([
      { id: "green", name: "Fixture Green Academy", timezone: "Asia/Kolkata" },
      {
        id: "blue",
        name: "Fixture Blue Academy",
        timezone: "America/New_York",
      },
      { id: "quiet", name: "Fixture Quiet Academy", timezone: "Asia/Kolkata" },
    ]);
    for (const u of Object.values(USERS)) {
      await tx.insert(t.user).values({
        id: u.id,
        name: u.name,
        email: u.email,
        emailVerified: true,
      });
      await tx.insert(t.account).values({
        id: `account-${u.id}`,
        accountId: u.id,
        providerId: "credential",
        userId: u.id,
        password,
      });
      await tx
        .insert(t.memberships)
        .values({ academyId: u.academyId, userId: u.id, role: u.role });
    }
    for (const academyId of ["green", "blue", "quiet"] as const) {
      await tx
        .insert(t.academySettings)
        .values({ academyId, data: defaultSettings });
      await tx.insert(t.entitlements).values({
        academyId,
        data: {
          reports: true,
          nutrition: true,
          communications: true,
          manualVideo: true,
        },
      });
    }
    for (const academyId of ["green", "blue"] as const)
      await tx.insert(t.branches).values({
        id: `${academyId}-branch`,
        academyId,
        name: "Fixture branch",
      });
    await tx.insert(t.batches).values([
      {
        id: "green-main",
        academyId: "green",
        name: "Main batch",
        branchId: "green-branch",
        coachId: USERS.coach.id,
      },
      {
        id: "green-other",
        academyId: "green",
        name: "Other batch",
        branchId: "green-branch",
        coachId: USERS.headCoach.id,
      },
      {
        id: "blue-batch",
        academyId: "blue",
        name: "Blue batch",
        branchId: "blue-branch",
        coachId: USERS.blueCoach.id,
      },
    ]);
    const people = [
      ["childA", "green", "green-main", false, null],
      ["childB", "green", "green-other", false, null],
      ["adult", "green", "green-main", true, USERS.adult.id],
      ["blue", "blue", "blue-batch", false, null],
    ] as const;
    for (const [key, academyId, batchId, adult, selfUserId] of people) {
      const c = CANARY[key];
      const id = SUBJECT_IDS[key];
      await tx
        .insert(t.players)
        .values({ id, academyId, batchId, name: c.name });
      const profile = {
        adult,
        birthDate: c.birthDate,
        email: c.email,
        phone: c.phone,
        notes: c.notes,
        status: "ACTIVE" as const,
        selfUserId,
        preferences: "",
      };
      await tx
        .insert(t.profiles)
        .values({ academyId, playerId: id, data: profile });
      await tx.insert(t.recordRevisions).values({
        id: `rev-profile-${id}`,
        academyId,
        entityId: id,
        kind: "player-profile",
        version: 1,
        data: { name: c.name, batchId, ...profile },
      });
      await tx.insert(t.playerHistory).values({
        id: `hist-${id}`,
        academyId,
        playerId: id,
        kind: "PROFILE_UPDATED",
        detail: { note: c.history },
      });
    }
    await tx.insert(t.guardianLinks).values([
      {
        academyId: "green",
        playerId: SUBJECT_IDS.childA,
        userId: USERS.guardian.id,
        relationship: "Mother",
        consent: consent(true, true, false),
      },
      {
        academyId: "green",
        playerId: SUBJECT_IDS.childB,
        userId: USERS.guardian2.id,
        relationship: "Father",
        consent: consent(true, false, true),
      },
      {
        academyId: "blue",
        playerId: SUBJECT_IDS.blue,
        userId: USERS.blueGuardian.id,
        relationship: "Guardian",
        consent: consent(true, true, true),
      },
    ]);
    // Nutrition assignments: the only thing that gives a Nutrition Pro access to a player.
    //   nutrition   -> ALPHA (active); BRAVO was assigned and then withdrawn (inactive row)
    //   nutrition2  -> BRAVO
    //   blueNutrition -> BLUE.   ADULT and every other pairing: no assignment.
    await tx.insert(t.nutritionAssignments).values([
      {
        academyId: "green",
        playerId: SUBJECT_IDS.childA,
        professionalId: USERS.nutrition.id,
      },
      {
        academyId: "green",
        playerId: SUBJECT_IDS.childB,
        professionalId: USERS.nutrition.id,
        active: false,
      },
      {
        academyId: "green",
        playerId: SUBJECT_IDS.childB,
        professionalId: USERS.nutrition2.id,
      },
      {
        academyId: "blue",
        playerId: SUBJECT_IDS.blue,
        professionalId: USERS.blueNutrition.id,
      },
    ]);
    const families: Family[] = [
      {
        key: "childA",
        academyId: "green",
        batchId: "green-main",
        coach: USERS.coach,
        guardian: USERS.guardian,
        finance: USERS.finance,
        portal: true,
      },
      {
        key: "childB",
        academyId: "green",
        batchId: "green-other",
        coach: USERS.headCoach,
        guardian: USERS.guardian2,
        finance: USERS.finance,
        portal: true,
      },
      {
        key: "blue",
        academyId: "blue",
        batchId: "blue-batch",
        coach: USERS.blueCoach,
        guardian: USERS.blueGuardian,
        finance: USERS.blueOwner,
        portal: true,
      },
    ];
    for (const f of families) await seedFamily(tx, f);
    // One message template and fee plan per academy, carrying that academy's first canaries.
    for (const [academyId, key] of [
      ["green", "childA"],
      ["blue", "blue"],
    ] as const) {
      const c = CANARY[key];
      await tx.insert(t.messageTemplates).values({
        id: `template-${academyId}`,
        academyId,
        name: c.template,
        subject: c.template,
        body: c.template,
      });
      await tx.insert(t.feePlans).values({
        id: `feeplan-${academyId}`,
        academyId,
        name: c.feePlan,
        amount: 1000,
        currency: "INR",
      });
    }
    await tx.insert(t.enquiries).values({
      id: "fx-enquiry",
      academyId: "green",
      data: {
        ...CANARY.enquiry,
        adult: false,
        source: "fixture",
        followUpDate: "",
        trialEventId: null,
        trialAttendance: "NOT_MARKED",
        feedback: "",
        playerId: null,
      },
    });
  });
  // Private media bytes live on disk (the PRIVATE_MEDIA_PATH of this disposable instance).
  for (const [key, ids] of Object.entries(MEDIA_IDS)) {
    const academyId = key === "blue" ? "blue" : "green";
    for (const id of Object.values(ids))
      await privateFiles.put(mediaKey(academyId, id), PNG);
  }
  return { users: USERS, subjects: SUBJECT_IDS };
}
type Tx = Parameters<
  Parameters<ReturnType<typeof database>["transaction"]>[0]
>[0];
async function seedFamily(tx: Tx, f: Family) {
  const c = CANARY[f.key];
  const ids = idsFor(f.key);
  const { academyId, guardian, coach } = f;
  const playerId = ids.playerId;
  const branchId = `${academyId}-branch`;
  const stamp = "2027-01-02T10:00:00.000Z";
  await tx.insert(t.restrictedNutrition).values({
    academyId,
    playerId,
    allergies: c.allergy,
    restrictions: "",
  });
  await tx.insert(t.nutritionQuestions).values({
    id: `q-${playerId}`,
    academyId,
    playerId,
    authorId: guardian.id,
    question: c.question,
  });
  const plan = (title: string) => ({
    playerId,
    title,
    guidance: title,
    professional: USERS.nutrition.name,
    reviewNote: "Reviewed",
    approvedAt: stamp,
  });
  await tx.insert(t.nutritionPlans).values({
    id: ids.nutritionPlanId,
    academyId,
    playerId,
    status: "SHARED",
    data: plan(c.nutritionShared),
  });
  await tx.insert(t.recordRevisions).values({
    id: `rev-${ids.nutritionPlanId}`,
    academyId,
    entityId: ids.nutritionPlanId,
    kind: "nutrition-plan",
    version: 1,
    data: { status: "SHARED", data: plan(c.nutritionShared) },
  });
  // A later, unshared draft that families must never receive.
  const draft = `nutrition-draft-${playerId}`;
  await tx.insert(t.nutritionPlans).values({
    id: draft,
    academyId,
    playerId,
    status: "DRAFT",
    data: plan(c.nutritionDraft),
  });
  await tx.insert(t.recordRevisions).values({
    id: `rev-${draft}`,
    academyId,
    entityId: draft,
    kind: "nutrition-plan",
    version: 1,
    data: { status: "DRAFT", data: plan(c.nutritionDraft) },
  });
  // Report: published once, then revised into a draft carrying the draft canary.
  const report = (summary: string) => ({
    playerId,
    periodStart: "2027-01-01",
    periodEnd: "2027-01-31",
    title: "Fixture report",
    summary,
    evidence: [],
    academyName: `Fixture ${academyId} Academy`,
    playerName: c.name,
    reviewer: coach.name,
    approvedAt: null,
  });
  await tx.insert(t.reports).values({
    id: ids.reportId,
    academyId,
    playerId,
    version: 3,
    status: "DRAFT",
    data: report(c.reportDraft),
  });
  for (const [version, status, summary] of [
    [1, "DRAFT", "first draft"],
    [2, "PUBLISHED", c.reportPublished],
    [3, "DRAFT", c.reportDraft],
  ] as const)
    await tx.insert(t.recordRevisions).values({
      id: `rev-${ids.reportId}-${version}`,
      academyId,
      entityId: ids.reportId,
      kind: "report",
      version,
      data: { status, data: report(summary), reason: "" },
    });
  await tx.insert(t.conversations).values({
    id: ids.conversationId,
    academyId,
    playerId,
    guardianId: guardian.id,
    subject: "Fixture conversation",
    entries: [
      {
        id: `entry-${playerId}`,
        authorId: guardian.id,
        name: guardian.name,
        text: c.conversation,
        at: stamp,
      },
    ],
  });
  await tx.insert(t.invoices).values({
    id: ids.invoiceId,
    academyId,
    data: {
      number: `INV-${playerId}`,
      playerIds: [playerId],
      familyUserId: guardian.id,
      planId: null,
      description: c.invoice,
      currency: "INR",
      subtotal: 1000,
      discount: 0,
      total: 1000,
      dueDate: "2027-02-01",
      issuedAt: stamp,
      voidReason: "",
    },
  });
  await tx.insert(t.payments).values({
    id: ids.paymentId,
    academyId,
    invoiceId: ids.invoiceId,
    status: "VERIFIED",
    idempotencyKey: `idem-${ids.paymentId}`,
    reference: c.paymentRef,
    data: {
      invoiceId: ids.invoiceId,
      amount: 500,
      currency: "INR",
      reference: c.paymentRef,
      method: "UPI",
      submittedBy: guardian.id,
      verifiedBy: f.finance.id,
      reason: "Matched statement",
      receiptNumber: `RCT-${ids.paymentId.slice(0, 8).toUpperCase()}`,
    },
  });
  await tx.insert(t.refunds).values({
    id: `refund-${playerId}`,
    academyId,
    paymentId: ids.paymentId,
    amount: 100,
    reason: c.refundReason,
    idempotencyKey: `idem-refund-${playerId}`,
  });
  await tx.insert(t.lessonCredits).values({
    id: `credit-${playerId}`,
    academyId,
    playerId,
    units: 2,
    reason: c.creditReason,
    idempotencyKey: `idem-credit-${playerId}`,
  });
  // Stage 5E: the event is an occurrence of a (one-occurrence) weekly series that was changed individually,
  // so the staff payload carries the series fields and the family payload proves they are withheld.
  await tx.insert(t.calendarSeries).values({
    id: `series-${playerId}`,
    academyId,
    kind: "EVENT",
    data: { origin: "CREATED", firstDate: "2027-03-01", count: 1, interval: 1 },
  });
  await tx.insert(t.calendarEvents).values({
    id: `event-${playerId}`,
    academyId,
    kind: "EVENT",
    seriesId: `series-${playerId}`,
    occurrenceDate: "2027-03-01",
    data: {
      title: c.event,
      localDate: "2027-03-01",
      localTime: "17:00",
      duration: 60,
      startsAt: "2027-03-01T11:30:00.000Z",
      endsAt: "2027-03-01T12:30:00.000Z",
      timezone: academyId === "blue" ? "America/New_York" : "Asia/Kolkata",
      branchId,
      coachId: coach.id,
      batchId: f.batchId,
      playerIds: [playerId],
      enquiryId: null,
      seriesId: `series-${playerId}`,
      overrides: ["title"],
    },
  });
  // Training session with a private coach observation, its reviewed text, a recap and a goal.
  const observationId = `obs-${playerId}`;
  await tx.insert(t.trainingSessions).values({
    id: ids.sessionId,
    academyId,
    coachId: coach.id,
    batchId: f.batchId,
    status: "PUBLISHED",
    data: {
      title: "Fixture session",
      batchId: f.batchId,
      branchId,
      coachId: coach.id,
      localDate: "2027-04-01",
      localTime: "17:00",
      startsAt: "2027-04-01T11:30:00.000Z",
      timezone: academyId === "blue" ? "America/New_York" : "Asia/Kolkata",
      duration: 10,
      objective: c.sessionObjective,
      activities: [
        {
          id: `act-${playerId}`,
          drillId: null,
          drillVersion: null,
          title: "Footwork",
          minutes: 10,
          cues: "",
          snapshot: null,
        },
      ],
      roster: [{ id: playerId, name: c.name }],
      attendance: { [playerId]: "PRESENT" },
      observations: [
        {
          id: observationId,
          playerId,
          activityId: null,
          text: c.sessionNote,
          author: coach.name,
          at: stamp,
          visibility: "PRIVATE_DRAFT",
        },
      ],
      adjustments: [],
      progress: { index: 0, elapsed: 0, runningSince: null },
      actuals: {},
      recap: c.sessionRecap,
    },
  });
  await tx.insert(t.observationReviews).values({
    academyId,
    sessionId: ids.sessionId,
    observationId,
    approvedText: c.reviewText,
    reviewerId: coach.id,
  });
  await tx.insert(t.goals).values({
    id: `goal-${playerId}`,
    academyId,
    playerId,
    data: {
      id: `goal-${playerId}`,
      playerId,
      title: c.goal,
      method: "Weekly drills",
      status: "ACTIVE",
      createdAt: stamp,
      author: coach.name,
    },
  });
  // A portal message to the guardian, with its delivery.
  const messageId = `message-${playerId}`;
  await tx.insert(t.messages).values({
    id: messageId,
    authorId: coach.id,
    academyId,
    status: "SENT",
    data: {
      subject: c.messageSubject,
      body: c.messageBody,
      playerIds: [playerId],
      batchIds: [],
      allBatches: false,
      channels: ["PORTAL"],
      recipients: [
        {
          userId: guardian.id,
          name: guardian.name,
          email: guardian.email,
          playerIds: [playerId],
          channels: ["PORTAL"],
        },
      ],
      scheduledAt: null,
      approvedBy: coach.id,
      approvalHash: "fixture-hash",
      templateId: null,
    },
  });
  await tx.insert(t.deliveries).values({
    id: `delivery-${playerId}`,
    academyId,
    messageId,
    userId: guardian.id,
    channel: "PORTAL",
    status: "AVAILABLE_IN_PORTAL",
    detail: "Available in the family portal",
  });
  // Media: one shared with the family (with feedback), one private to staff.
  const future = new Date("2099-01-01T00:00:00.000Z");
  const media = (
    id: string,
    name: string,
    status: string,
    feedback: string,
  ) => ({
    id,
    academyId,
    playerId,
    ownerId: coach.id,
    name,
    mime: "image/png",
    size: PNG.length,
    storageKey: mediaKey(academyId, id),
    status,
    feedback,
    reviewerId: coach.id,
    expiresAt: future,
  });
  await tx
    .insert(t.mediaAssets)
    .values([
      media(ids.media.shared, c.mediaShared, "SHARED", c.mediaFeedback),
      media(
        ids.media.private,
        c.mediaPrivate,
        "PRIVATE",
        c.mediaPrivateFeedback,
      ),
    ]);
  await tx.insert(t.audit).values({
    id: `audit-${playerId}`,
    academyId,
    actorId: coach.id,
    entityId: playerId,
    action: c.auditAction,
    version: 1,
    detail: {},
  });
}
