import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { database } from "../src/infrastructure/database/client";
import {
  provisionTestDatabase,
  type TestDatabase,
} from "./helpers/test-database";
import * as t from "../src/infrastructure/database/schema";
import type { Actor } from "../src/modules/identity/access";
import { defaultSettings } from "../src/modules/academy/domain/types";
import { defaultProfile } from "../src/modules/academy/application/access";
import { bootstrapAcademy } from "../src/modules/academy/application/bootstrap";
import {
  saveEnquiry,
  scheduleTrial,
  convertEnquiry,
} from "../src/modules/admissions/application/service";
import {
  savePlayer,
  linkGuardian,
  saveConsent,
} from "../src/modules/players/application/service";
import {
  saveCalendarEvent,
  scheduleSession,
} from "../src/modules/calendar/application/service";
import {
  createSession,
  mutateSession,
} from "../src/modules/training/application/service";
import {
  saveFeePlan,
  issueInvoice,
  submitPayment,
  verifyPayment,
  recordRefund,
  adjustCredits,
} from "../src/modules/fees/application/service";
import { minorUnits } from "../src/modules/fees/domain/money";
import {
  createReport,
  reviewObservation,
  updateReport,
} from "../src/modules/reports/application/service";
import { reportPdf, receiptPdf } from "../src/modules/reports/application/pdf";
import {
  assignNutrition,
  saveNutrition,
  saveRestrictions,
  nutritionQuestion,
} from "../src/modules/nutrition/application/service";
import {
  saveMessage,
  previewMessage,
  processOutbox,
  saveConversation,
} from "../src/modules/communications/application/service";
import {
  uploadMedia,
  saveTimestampNote,
  reviewMedia,
  mediaLink,
  readMedia,
  validMedia,
} from "../src/modules/media/application/service";
import { saveSettings } from "../src/modules/settings/application/service";
process.env.BETTER_AUTH_SECRET =
  "isolated-operations-test-secret-123456789012345678";
process.env.BETTER_AUTH_URL = "http://127.0.0.1:3100";
// The database is provisioned in before(): embedded PGlite by default, or a fresh database on the
// disposable PostgreSQL server when TEST_POSTGRES_ADMIN_URL is set (npm run test:pg).
let testDb: TestDatabase | undefined;
const actor = (id: string, role: string, academyId = "green"): Actor => ({
  id,
  name: `Test ${id}`,
  role,
  academyId,
  timezone: "Asia/Kolkata",
  academyName: `Academy ${academyId}`,
});
const owner = actor("owner", "OWNER"),
  coach = actor("coach", "COACH"),
  pro = actor("pro", "NUTRITION_PRO"),
  guardian = actor("parent", "GUARDIAN"),
  secondGuardian = actor("other-parent", "GUARDIAN"),
  blue = actor("blue-owner", "OWNER", "blue");
before(async () => {
  testDb = await provisionTestDatabase("ops");
  const db = database();
  for (const id of ["green", "blue"]) {
    await db
      .insert(t.academies)
      .values({ id, name: `Academy ${id}`, timezone: "Asia/Kolkata" });
    await db
      .insert(t.academySettings)
      .values({ academyId: id, data: defaultSettings });
    await db.insert(t.entitlements).values({
      academyId: id,
      data: {
        reports: true,
        nutrition: true,
        communications: true,
        manualVideo: true,
      },
    });
    await db
      .insert(t.branches)
      .values({ id: `${id}-branch`, academyId: id, name: "Test branch" });
  }
  for (const a of [
    owner,
    coach,
    pro,
    guardian,
    secondGuardian,
    blue,
    actor("parallel-coach", "COACH"),
  ]) {
    await db
      .insert(t.user)
      .values({ id: a.id, name: a.name, email: `${a.id}@example.test` });
    await db
      .insert(t.memberships)
      .values({ academyId: a.academyId, userId: a.id, role: a.role });
  }
  for (const [id, academyId, coachId] of [
    ["green-batch", "green", "coach"],
    ["green-parallel", "green", "parallel-coach"],
    ["blue-batch", "blue", "blue-owner"],
  ])
    await db.insert(t.batches).values({
      id,
      academyId,
      coachId,
      branchId: `${academyId}-branch`,
      name: id,
    });
  for (const [id, academyId, batchId] of [
    ["child-a", "green", "green-batch"],
    ["child-b", "green", "green-batch"],
    ["child-c", "green", "green-parallel"],
    ["blue-child", "blue", "blue-batch"],
  ]) {
    await db.insert(t.players).values({ id, academyId, batchId, name: id });
    await db
      .insert(t.profiles)
      .values({ academyId, playerId: id, data: defaultProfile });
  }
  await linkGuardian(owner, {
    playerId: "child-a",
    userId: guardian.id,
    relationship: "Mother",
    active: true,
    consent: { portal: true, email: true, whatsapp: false },
    consentMethod: "STAFF_WRITTEN",
    evidenceRef: "Paper form (test fixture)",
  });
  await linkGuardian(owner, {
    playerId: "child-b",
    userId: guardian.id,
    relationship: "Mother",
    active: true,
    consent: { portal: true, email: true, whatsapp: false },
    consentMethod: "STAFF_WRITTEN",
    evidenceRef: "Paper form (test fixture)",
  });
  await linkGuardian(owner, {
    playerId: "child-c",
    userId: secondGuardian.id,
    relationship: "Parent",
    active: true,
    consent: { portal: true, email: false, whatsapp: false },
    consentMethod: "STAFF_WRITTEN",
    evidenceRef: "Paper form (test fixture)",
  });
});
after(async () => {
  await testDb?.cleanup();
});
let slotIndex = 0;
async function completedSession() {
  let s = await createSession(coach);
  s = await mutateSession(coach, s.id, {
    version: s.version,
    action: "save",
    payload: {
      ...s.data,
      title: "Recorded recovery session",
      batchId: "green-batch",
      branchId: "green-branch",
      coachId: coach.id,
      localDate: `2027-02-${String(++slotIndex).padStart(2, "0")}`,
      localTime: "17:00",
      duration: 10,
      objective: "Controlled movement.",
      activities: [
        {
          id: "activity",
          drillId: null,
          drillVersion: null,
          title: "Recovery exercise",
          minutes: 10,
          cues: "Stay balanced.",
        },
      ],
    },
  });
  s = await mutateSession(coach, s.id, {
    version: s.version,
    action: "publish",
  });
  s = await mutateSession(coach, s.id, { version: s.version, action: "start" });
  s = await mutateSession(coach, s.id, {
    version: s.version,
    action: "attendance",
    payload: { "child-a": "PRESENT", "child-b": "ABSENT" },
  });
  s = await mutateSession(coach, s.id, {
    version: s.version,
    action: "note",
    payload: {
      id: crypto.randomUUID(),
      playerId: "child-a",
      activityId: "activity",
      text: "PRIVATE ORIGINAL: balanced recovery during slow feeds.",
    },
  });
  return mutateSession(coach, s.id, {
    version: s.version,
    action: "complete",
    payload: {
      actuals: { activity: "MODIFIED" },
      recap: "Slower feeds used.",
      acknowledgeAttendance: true,
    },
  });
}
test("enquiry → trial → attendance/feedback → enrolled identity and history", async () => {
  const data = {
    name: "Prospect Example",
    email: "family@example.test",
    phone: "",
    adult: false,
    source: "Referral",
    followUpDate: "2027-01-01",
    notes: "Follow up after trial.",
    trialAttendance: "NOT_MARKED",
    feedback: "",
  };
  const e = await saveEnquiry(owner, { status: "ENQUIRY", data });
  await assert.rejects(
    () =>
      convertEnquiry(owner, { id: e.id, version: 1, batchId: "green-batch", birthDate: "2014-05-05" }),
    /attendance and feedback/,
  );
  await scheduleTrial(owner, {
    id: e.id,
    version: 1,
    event: {
      kind: "TRIAL",
      title: "Prospect trial",
      localDate: "2027-01-04",
      localTime: "12:00",
      duration: 30,
      branchId: "green-branch",
      coachId: "coach",
      batchId: "",
      playerIds: [],
      enquiryId: e.id,
      repeatWeeks: 1,
    },
  });
  const saved = await saveEnquiry(owner, {
    id: e.id,
    version: 2,
    status: "TRIAL",
    data: {
      ...data,
      trialAttendance: "PRESENT",
      feedback: "Suitable for foundations.",
    },
  });
  // Players are under 18: enrolment needs a date of birth, and an adult is refused.
  await assert.rejects(
    () => convertEnquiry(owner, { id: e.id, version: saved.version, batchId: "green-batch" }),
    /date of birth/,
  );
  await assert.rejects(
    () => convertEnquiry(owner, { id: e.id, version: saved.version, batchId: "green-batch", birthDate: "1990-01-01" }),
    /under 18/,
  );
  const enrolled = await convertEnquiry(owner, {
    id: e.id,
    version: saved.version,
    batchId: "green-batch",
    birthDate: "2014-05-05",
  });
  assert.equal(enrolled.id, e.id);
  assert.equal(
    (
      await convertEnquiry(owner, {
        id: e.id,
        version: saved.version,
        batchId: "green-batch",
      })
    ).id,
    e.id,
  );
  const snapshot = await bootstrapAcademy(owner);
  assert.equal(
    snapshot.enquiries.find((x) => x.id === e.id)?.status,
    "ENROLLED",
  );
  assert.ok(snapshot.players.some((p) => p.id === e.id));
  assert.ok(snapshot.versions.filter((v) => v.entityId === e.id).length >= 4);
});
test("calendar conflict detection includes coaches, players and closures; allows parallel batches", async () => {
  const base = {
    kind: "EVENT",
    title: "Group event",
    localDate: "2027-01-10",
    localTime: "10:00",
    duration: 60,
    branchId: "green-branch",
    coachId: "coach",
    batchId: "",
    playerIds: ["child-a"],
    enquiryId: null,
    repeatWeeks: 1,
  };
  await saveCalendarEvent(owner, base);
  await assert.rejects(
    () =>
      saveCalendarEvent(owner, {
        ...base,
        title: "Coach clash",
        playerIds: ["child-c"],
      }),
    /conflicts/,
  );
  await assert.rejects(
    () =>
      saveCalendarEvent(owner, {
        ...base,
        title: "Player clash",
        coachId: "parallel-coach",
      }),
    /conflicts/,
  );
  await saveCalendarEvent(owner, {
    ...base,
    title: "Valid parallel",
    coachId: "parallel-coach",
    playerIds: ["child-c"],
  });
  await assert.rejects(
    () =>
      saveCalendarEvent(owner, {
        ...base,
        kind: "CLOSURE",
        title: "Closure",
        coachId: "",
        playerIds: [],
      }),
    /conflicts/,
  );
});
test("calendar reschedule uses the same Training session and copies clear results", async () => {
  const s = await completedSession();
  const duplicated = await scheduleSession(owner, {
    id: s.id,
    version: s.version,
    localDate: "2027-04-01",
    localTime: "17:00",
    repeatWeeks: 2,
    duplicate: true,
  });
  assert.equal(duplicated.ids.length, 2);
  const data = await bootstrapAcademy(owner);
  for (const id of duplicated.ids) {
    const copy = data.sessions.find((s) => s.id === id)!;
    assert.equal(copy.status, "DRAFT");
    assert.deepEqual(copy.data.observations, []);
    assert.deepEqual(copy.data.attendance, {});
  }
  const copy = data.sessions.find((s) => s.id === duplicated.ids[0])!;
  await scheduleSession(owner, {
    id: copy.id,
    version: copy.version,
    localDate: "2027-05-01",
    localTime: "16:00",
    repeatWeeks: 1,
    duplicate: false,
  });
  assert.equal(
    (await bootstrapAcademy(owner)).sessions.find((s) => s.id === copy.id)?.data
      .localDate,
    "2027-05-01",
  );
});
test("fee plan → invoice → partial reference → verification → private receipt; idempotency and refunds", async () => {
  const plan = await saveFeePlan(owner, {
    name: "Monthly",
    amount: 300000,
    currency: "INR",
    archived: false,
  });
  const request = {
    id: crypto.randomUUID(),
    playerIds: ["child-a", "child-b"],
    familyUserId: guardian.id,
    planId: plan.id,
    description: "Monthly academy fees",
    subtotal: 300000,
    discount: 10000,
    currency: "INR",
    dueDate: "2027-02-01",
  };
  const invoice = await issueInvoice(owner, request);
  assert.equal(invoice.data.total, 290000);
  assert.equal((await issueInvoice(owner, request)).id, invoice.id);
  await assert.rejects(
    () => issueInvoice(owner, { ...request, discount: 20000 }),
    /already used/,
  );
  const paymentRequest = {
    invoiceId: invoice.id,
    idempotencyKey: crypto.randomUUID(),
    amount: 100000,
    reference: `REF-${crypto.randomUUID()}`,
    method: "BANK",
  };
  const pending = await submitPayment(guardian, paymentRequest);
  assert.equal((await submitPayment(guardian, paymentRequest)).id, pending.id);
  await assert.rejects(
    () =>
      submitPayment(guardian, {
        ...paymentRequest,
        idempotencyKey: crypto.randomUUID(),
      }),
    /already submitted/,
  );
  assert.equal(
    (await bootstrapAcademy(owner)).invoices.find((i) => i.id === invoice.id)
      ?.balance,
    290000,
  );
  await assert.rejects(() => receiptPdf(guardian, pending.id), /not found/);
  const verified = await verifyPayment(owner, {
    id: pending.id,
    version: 1,
    decision: "VERIFIED",
    reason: "Matched bank statement.",
  });
  assert.equal(verified.data.receiptNumber?.startsWith("RCT-"), true);
  assert.equal(
    (await bootstrapAcademy(owner)).invoices.find((i) => i.id === invoice.id)
      ?.balance,
    190000,
  );
  const pdf = await receiptPdf(guardian, verified.id);
  assert.equal((await PDFDocument.load(pdf.bytes)).getPageCount(), 1);
  await assert.rejects(
    () => receiptPdf(secondGuardian, verified.id),
    /not found/,
  );
  const refund = {
    paymentId: verified.id,
    amount: 20000,
    reason: "Recorded external partial refund.",
    idempotencyKey: crypto.randomUUID(),
    confirmedExternalRefund: true,
  };
  await recordRefund(owner, refund);
  await recordRefund(owner, refund);
  assert.equal(
    (await bootstrapAcademy(owner)).invoices.find((i) => i.id === invoice.id)
      ?.balance,
    210000,
  );
  await assert.rejects(
    () =>
      recordRefund(owner, {
        ...refund,
        idempotencyKey: crypto.randomUUID(),
        amount: 100000,
      }),
    /exceeds/,
  );
  const credit = {
    playerId: "child-a",
    units: 2,
    reason: "Make-up lessons",
    idempotencyKey: crypto.randomUUID(),
  };
  await adjustCredits(owner, credit);
  await adjustCredits(owner, credit);
  await assert.rejects(
    () =>
      adjustCredits(owner, {
        ...credit,
        units: -3,
        idempotencyKey: crypto.randomUUID(),
      }),
    /negative/,
  );
  assert.equal(minorUnits("10.05"), 1005);
  assert.throws(() => minorUnits("10.005"));
});
test("reviewed evidence → approved report → only linked family access; published revisions survive edits", async () => {
  const s = await completedSession();
  const r = await createReport(coach, {
    playerId: "child-a",
    periodStart: s.data.localDate,
    periodEnd: s.data.localDate,
    title: "Recorded development",
  });
  assert.equal(r.data.evidence[0].observations.length, 0);
  assert.deepEqual((await bootstrapAcademy(guardian)).reports, []);
  await reviewObservation(coach, {
    sessionId: s.id,
    observationId: s.data.observations[0].id,
    approvedText: "Recovered with balance during controlled feeds.",
  });
  let report = await createReport(coach, {
    playerId: "child-a",
    periodStart: s.data.localDate,
    periodEnd: s.data.localDate,
    title: "Reviewed development",
  });
  assert.equal(
    report.data.evidence[0].observations[0],
    "Recovered with balance during controlled feeds.",
  );
  report = await updateReport(coach, {
    id: report.id,
    version: 1,
    action: "submit",
    summary: "",
    reason: "",
  });
  await assert.rejects(
    () =>
      updateReport(coach, {
        id: report.id,
        version: report.version,
        action: "approve",
        summary: "",
        reason: "",
      }),
    /role/,
  );
  report = await updateReport(owner, {
    id: report.id,
    version: report.version,
    action: "approve",
    summary: "",
    reason: "",
  });
  report = await updateReport(owner, {
    id: report.id,
    version: report.version,
    action: "publish",
    summary: "",
    reason: "",
  });
  assert.ok(
    (await bootstrapAcademy(guardian)).reports.some((r) => r.id === report.id),
  );
  assert.ok(
    !(await bootstrapAcademy(secondGuardian)).reports.some(
      (r) => r.id === report.id,
    ),
  );
  await assert.rejects(() => reportPdf(secondGuardian, report.id), /not found/);
  const pdf = await reportPdf(guardian, report.id);
  assert.ok((await PDFDocument.load(pdf.bytes)).getPageCount() >= 1);
  await updateReport(owner, {
    id: report.id,
    version: report.version,
    action: "revise",
    summary: "",
    reason: "Clarify reviewed wording.",
  });
  assert.equal(
    (await bootstrapAcademy(guardian)).reports.find((r) => r.id === report.id)
      ?.version,
    report.version,
  );
  assert.ok((await reportPdf(guardian, report.id)).bytes.length > 1000);
  const parent = JSON.stringify(await bootstrapAcademy(guardian));
  assert.ok(!parent.includes("PRIVATE ORIGINAL"));
});
test("nutrition requires professional approval and keeps allergies away from ordinary coaches", async () => {
  await assignNutrition(owner, {
    playerId: "child-a",
    professionalId: pro.id,
    active: true,
  });
  await saveRestrictions(guardian, {
    playerId: "child-a",
    version: 1,
    allergies: "Fictional restricted allergy note",
    restrictions: "Family-reported restriction",
  });
  assert.equal((await bootstrapAcademy(coach)).restrictions.length, 0);
  assert.equal(
    (await bootstrapAcademy(pro)).restrictions[0].allergies,
    "Fictional restricted allergy note",
  );
  let n = await saveNutrition(coach, {
    playerId: "child-a",
    title: "Human-authored plan",
    guidance: "Draft prepared for qualified review.",
    sections: {
      beforeTraining: "Fictional reviewed preparation",
      afterTraining: "Fictional recovery guidance",
      dailyMeals: "Fictional daily guidance",
      hydration: "Fictional hydration guidance",
      trainingDay: "Fictional training-day guidance",
    },
    action: "save",
    reviewNote: "",
  });
  n = await saveNutrition(coach, {
    id: n.id,
    version: n.version,
    playerId: "child-a",
    title: n.data.title,
    guidance: n.data.guidance,
    action: "submit",
    reviewNote: "",
  });
  await assert.rejects(
    () =>
      saveNutrition(owner, {
        id: n.id,
        version: n.version,
        playerId: "child-a",
        title: n.data.title,
        guidance: n.data.guidance,
        action: "approve",
        reviewNote: "Owner is not a professional.",
      }),
    /role/,
  );
  n = await saveNutrition(pro, {
    id: n.id,
    version: n.version,
    playerId: "child-a",
    title: n.data.title,
    guidance: n.data.guidance,
    action: "approve",
    reviewNote: "Qualified professional reviewed this fictional text.",
  });
  assert.equal(n.data.sections?.hydration, "Fictional hydration guidance");
  assert.equal(n.data.guidance, "Draft prepared for qualified review.");
  assert.equal((await bootstrapAcademy(guardian)).nutrition.length, 0);
  n = await saveNutrition(owner, {
    id: n.id,
    version: n.version,
    playerId: "child-a",
    title: n.data.title,
    guidance: n.data.guidance,
    action: "share",
    reviewNote: "",
  });
  assert.ok(
    (await bootstrapAcademy(guardian)).nutrition.some((p) => p.id === n.id),
  );
  assert.ok(
    !(await bootstrapAcademy(secondGuardian)).nutrition.some(
      (p) => p.id === n.id,
    ),
  );
  await nutritionQuestion(guardian, {
    playerId: "child-a",
    question: "Private family question?",
    answer: "",
  });
  const q = (await bootstrapAcademy(pro)).questions[0];
  await nutritionQuestion(pro, {
    id: q.id,
    version: q.version,
    playerId: q.playerId,
    question: q.question,
    answer: "Professional response recorded.",
  });
  assert.equal(
    (await bootstrapAcademy(guardian)).questions[0].answer,
    "Professional response recorded.",
  );
  assert.equal((await bootstrapAcademy(coach)).questions.length, 0);
});
test("communication deduplicates guardians, needs no consent record, and never simulates provider success", async () => {
  const input = {
    subject: "Weekly plan",
    body: "Please review the published schedule.",
    playerIds: ["child-a", "child-b"],
    batchIds: [],
    allBatches: false,
    channels: ["PORTAL", "EMAIL"],
    templateId: null,
  };
  const preview = await previewMessage(owner, input);
  assert.equal(preview.recipients.length, 1);
  assert.equal(preview.recipients[0].playerIds.length, 2);
  let m = await saveMessage(owner, {
    action: "save",
    scheduledAt: null,
    data: input,
  });
  m = await saveMessage(owner, {
    id: m.id,
    version: m.version,
    action: "approve",
    scheduledAt: null,
    data: input,
  });
  m = await saveMessage(owner, {
    id: m.id,
    version: m.version,
    action: "schedule",
    scheduledAt: "2020-01-01T00:00:00Z",
    data: input,
  });
  await processOutbox(owner);
  await processOutbox(owner);
  const boot = await bootstrapAcademy(owner);
  const logs = boot.deliveries.filter((d) => d.messageId === m.id);
  assert.equal(logs.length, 2);
  assert.equal(
    logs.find((d) => d.channel === "EMAIL")?.status,
    "READY_TO_SHARE",
    "no consent record is needed: the e-mail waits for the sender to send it by hand",
  );
  assert.equal(
    logs.find((d) => d.channel === "PORTAL")?.status,
    "AVAILABLE_IN_PORTAL",
  );
  assert.ok(
    (await bootstrapAcademy(guardian)).messages.some((x) => x.id === m.id),
  );
  const external = { ...input, channels: ["EMAIL"] };
  let blocked = await saveMessage(owner, {
    action: "save",
    scheduledAt: null,
    data: external,
  });
  blocked = await saveMessage(owner, {
    id: blocked.id,
    version: blocked.version,
    action: "approve",
    scheduledAt: null,
    data: external,
  });
  await saveMessage(owner, {
    id: blocked.id,
    version: blocked.version,
    action: "schedule",
    scheduledAt: "2020-01-01T00:00:00Z",
    data: external,
  });
  await processOutbox(owner);
  const blockedLog = (await bootstrapAcademy(owner)).deliveries.find(
    (d) => d.messageId === blocked.id,
  );
  assert.equal(blockedLog?.status, "READY_TO_SHARE", "no e-mail service: the sender sends it by hand, for free");
  assert.equal(blockedLog?.attempts, 0);
});
test("private media is typed, signed, scoped and immediately revoked with guardian access", async () => {
  assert.equal(validMedia(new Uint8Array([1, 2, 3]), "video/mp4"), false);
  await assert.rejects(
    () =>
      uploadMedia(
        coach,
        "child-a",
        new File(["not a video"], "bad.mp4", { type: "video/mp4" }),
      ),
    /signature/,
  );
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfP8AAAAASUVORK5CYII=",
    "base64",
  );
  await uploadMedia(
    coach,
    "child-a",
    new File([bytes], "sample.png", { type: "image/png" }),
  );
  let m = (await bootstrapAcademy(coach)).media[0];
  await assert.rejects(() => mediaLink(guardian, m.id), /not found/);
  await reviewMedia(coach, {
    id: m.id,
    version: m.version,
    feedback: "Reviewed by coach.",
    share: true,
  });
  const { url } = await mediaLink(guardian, m.id);
  const read = await readMedia(
    guardian,
    m.id,
    new URL(url, "http://127.0.0.1:3100"),
  );
  assert.equal(read.bytes.length, bytes.length);
  await assert.rejects(
    () =>
      readMedia(secondGuardian, m.id, new URL(url, "http://127.0.0.1:3100")),
    /invalid/,
  );
  await linkGuardian(owner, {
    playerId: "child-a",
    userId: guardian.id,
    relationship: "Mother",
    active: false,
    consent: { portal: false, email: false, whatsapp: false },
    consentMethod: "STAFF_WRITTEN",
    evidenceRef: "Paper form (test fixture)",
  });
  await assert.rejects(
    () => readMedia(guardian, m.id, new URL(url, "http://127.0.0.1:3100")),
    /not found/,
  );
  await linkGuardian(owner, {
    playerId: "child-a",
    userId: guardian.id,
    relationship: "Mother",
    active: true,
    consent: { portal: true, email: false, whatsapp: false },
    consentMethod: "STAFF_WRITTEN",
    evidenceRef: "Paper form (test fixture)",
  });
});
test("timestamp notes persist once, require video and revoke prior family sharing", async () => {
  const image = (await bootstrapAcademy(coach)).media.find(
    (m) => m.mime === "image/png",
  )!;
  await assert.rejects(
    () =>
      saveTimestampNote(coach, {
        id: image.id,
        version: image.version,
        noteId: crypto.randomUUID(),
        seconds: 2,
        text: "Image timestamp",
      }),
    /require a video/,
  );
  const bytes = new Uint8Array([26, 69, 223, 163, 0, 0, 0, 0]);
  const upload = await uploadMedia(
    coach,
    "child-a",
    new File([bytes], "signature-only-test.webm", { type: "video/webm" }),
  );
  let media = (await bootstrapAcademy(coach)).media.find(
    (m) => m.id === upload.id,
  )!;
  await reviewMedia(coach, {
    id: media.id,
    version: media.version,
    feedback: "Fictional reviewed video feedback",
    share: true,
  });
  await mediaLink(guardian, media.id);
  media = (await bootstrapAcademy(coach)).media.find(
    (m) => m.id === upload.id,
  )!;
  const note = {
    id: media.id,
    version: media.version,
    noteId: crypto.randomUUID(),
    seconds: 3.5,
    text: "Fictional timestamp evidence",
  };
  await saveTimestampNote(coach, note);
  await saveTimestampNote(coach, note);
  const changed = (await bootstrapAcademy(coach)).media.find(
    (m) => m.id === media.id,
  )!;
  assert.equal(changed.timestampNotes.length, 1);
  assert.equal(changed.timestampNotes[0].seconds, 3.5);
  assert.equal(changed.status, "PRIVATE");
  await assert.rejects(() => mediaLink(guardian, media.id), /not found/);
  await assert.rejects(() => saveTimestampNote(guardian, note), /role/);
  await assert.rejects(() => saveTimestampNote(blue, note), /not found|role/);
  await assert.rejects(
    () => saveTimestampNote(coach, { ...note, noteId: crypto.randomUUID() }),
    /changed|reload|version/i,
  );
});

test("cross-academy records and locked entitlements cannot be accessed or self-granted", async () => {
  await assert.rejects(
    () =>
      savePlayer(owner, {
        id: "blue-child",
        version: 1,
        name: "Bad",
        batchId: "green-batch",
        profile: defaultProfile,
      }),
    /not found/,
  );
  assert.ok(
    !(await bootstrapAcademy(guardian)).players.some((p) => p.id === "child-c"),
  );
  assert.ok(
    !(await bootstrapAcademy(blue)).players.some((p) => p.id === "child-a"),
  );
  await database()
    .update(t.entitlements)
    .set({
      data: {
        reports: false,
        nutrition: true,
        communications: true,
        manualVideo: true,
      },
    })
    .where(eq(t.entitlements.academyId, "green"));
  await assert.rejects(
    () =>
      saveSettings(owner, {
        version: 1,
        name: "Academy green",
        timezone: "Asia/Kolkata",
        ...defaultSettings,
      }),
    /locked/,
  );
  await assert.rejects(
    () =>
      createReport(owner, {
        playerId: "child-a",
        periodStart: "2027-01-01",
        periodEnd: "2027-12-31",
        title: "Blocked",
      }),
    /unavailable/,
  );
  await database()
    .update(t.entitlements)
    .set({
      data: {
        reports: true,
        nutrition: true,
        communications: true,
        manualVideo: true,
      },
    })
    .where(eq(t.entitlements.academyId, "green"));
});
test("private conversations use a single authorised player context and idempotent entries", async () => {
  const request = {
    guardianId: guardian.id,
    playerId: "child-a",
    subject: "Private check-in",
    text: "Can we discuss the next session?",
    entryId: crypto.randomUUID(),
  };
  const conversation = await saveConversation(guardian, request);
  assert.equal(
    (
      await saveConversation(guardian, {
        ...request,
        id: conversation.id,
        version: conversation.version,
      })
    ).entries.length,
    1,
  );
  await assert.rejects(
    () =>
      saveConversation(secondGuardian, {
        ...request,
        id: conversation.id,
        version: 1,
        entryId: crypto.randomUUID(),
      }),
    /not found/,
  );
  await assert.rejects(
    () =>
      saveConversation(guardian, {
        ...request,
        playerId: "child-c",
        entryId: crypto.randomUUID(),
      }),
    /not found/,
  );
});
