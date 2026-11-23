import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import {
  CANARY,
  USERS,
  canaryValues,
  idsFor,
  type FixtureUserKey,
} from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";
import { assertNoLeak } from "./helpers/payload";
import type { TestClient } from "./helpers/client";
/**
 * Resources addressed BY ID must not cross academy boundaries. Every endpoint that takes a
 * resource id is exercised in both directions (green users with blue ids, blue users with green
 * ids), as every role that could plausibly reach it. Each denial is paired with a positive
 * control — the same request, same shape, against the actor's OWN academy — so a 404 can only
 * mean "wrong tenant", never "bad request". Targets are verified unchanged afterwards.
 *
 * Endpoints (from src/app/api/academy/[[...path]]/route.ts): GET reports/:id/pdf,
 * GET fees/:id/receipt, GET media/:id/link, GET media/:id/file, and the id-bearing POST actions
 * reports/update, nutrition/plan, media/review, fees/refund, players/save, admissions/save,
 * settings/batch, communications/conversation.
 */
let app: Harness;
before(
  async () => {
    app = await startHarness("cross-academy");
  },
  { timeout: HOOK_TIMEOUT },
);
after(
  async () => {
    await app.stop();
  },
  { timeout: HOOK_TIMEOUT },
);
const green = idsFor("childA");
const greenB = idsFor("childB");
const blue = idsFor("blue");
const GREEN_USERS: FixtureUserKey[] = [
  "owner",
  "admin",
  "headCoach",
  "coach",
  "finance",
  "nutrition",
  "guardian",
  "guardian2",
  "adult",
];
const BLUE_USERS: FixtureUserKey[] = ["blueOwner", "blueCoach", "blueGuardian"];
const text = (r: { text: string; json: unknown }) =>
  r.text || JSON.stringify(r.json);
const denied = (status: number) => status === 403 || status === 404;
const db = () => database();
async function as(key: FixtureUserKey): Promise<TestClient> {
  return app.as(key);
}
test(
  "report PDFs: allowed within the academy, denied across it, in both directions",
  { timeout: TEST_TIMEOUT },
  async () => {
    const own = [
      ["owner", green.reportId],
      ["headCoach", green.reportId],
      ["guardian", green.reportId], // family: the published revision
      ["blueOwner", blue.reportId],
      ["blueGuardian", blue.reportId],
    ] as const;
    for (const [user, id] of own) {
      const r = await (await as(user)).get(`/api/academy/reports/${id}/pdf`);
      assert.equal(r.status, 200, `${user} own report`);
      assert.match(r.headers.get("content-type") ?? "", /application\/pdf/);
      assert.ok(r.headers.get("cache-control")?.includes("no-store"));
    }
    for (const [users, target, label] of [
      [GREEN_USERS, blue.reportId, "blue"],
      [BLUE_USERS, green.reportId, "green"],
      [BLUE_USERS, greenB.reportId, "green"],
    ] as const)
      for (const user of users) {
        const r = await (
          await as(user)
        ).get(`/api/academy/reports/${target}/pdf`);
        assert.ok(
          denied(r.status),
          `${user} fetched a ${label} report PDF: ${r.status}`,
        );
        assert.notEqual(r.headers.get("content-type"), "application/pdf");
      }
  },
);
test(
  "payment receipts: allowed within the academy, denied across it, in both directions",
  { timeout: TEST_TIMEOUT },
  async () => {
    for (const [user, id] of [
      ["owner", green.paymentId],
      ["finance", green.paymentId],
      ["guardian", green.paymentId],
      ["blueOwner", blue.paymentId],
      ["blueGuardian", blue.paymentId],
    ] as const) {
      const r = await (await as(user)).get(`/api/academy/fees/${id}/receipt`);
      assert.equal(r.status, 200, `${user} own receipt`);
      assert.match(r.headers.get("content-type") ?? "", /application\/pdf/);
    }
    for (const [users, target] of [
      [GREEN_USERS, blue.paymentId],
      [BLUE_USERS, green.paymentId],
      [BLUE_USERS, greenB.paymentId],
    ] as const)
      for (const user of users) {
        const r = await (
          await as(user)
        ).get(`/api/academy/fees/${target}/receipt`);
        assert.ok(
          denied(r.status),
          `${user} fetched a foreign receipt: ${r.status}`,
        );
      }
    // Within one academy, another family's receipt is also refused (same code path, tighter scope).
    const sibling = await (
      await as("guardian")
    ).get(`/api/academy/fees/${greenB.paymentId}/receipt`);
    assert.ok(
      denied(sibling.status),
      "a guardian read another family's receipt",
    );
  },
);
test(
  "private media: links and files are tenant-bound; private assets stay staff-only",
  { timeout: TEST_TIMEOUT },
  async () => {
    const link = async (user: FixtureUserKey, id: string) =>
      (await as(user)).get(`/api/academy/media/${id}/link`);
    // Positive controls.
    for (const [user, id] of [
      ["owner", green.media.shared],
      ["coach", green.media.private],
      ["guardian", green.media.shared],
      ["blueOwner", blue.media.shared],
      ["blueGuardian", blue.media.shared],
    ] as const) {
      const r = await link(user, id);
      assert.equal(r.status, 200, `${user} own media link`);
      assert.match(
        (r.json as { url: string }).url,
        /\/file\?expires=\d+&signature=[a-f0-9]{64}$/,
      );
    }
    // Within the academy a family still cannot reach staff-only media.
    assert.ok(
      denied((await link("guardian", green.media.private)).status),
      "guardian reached private media",
    );
    assert.ok(
      denied((await link("guardian", greenB.media.shared)).status),
      "guardian reached another family's media",
    );
    // Across academies, every role, both directions, shared and private alike.
    const blueIds = [blue.media.shared, blue.media.private];
    const greenIds = [
      green.media.shared,
      green.media.private,
      greenB.media.shared,
    ];
    for (const user of GREEN_USERS)
      for (const id of blueIds) {
        const r = await link(user, id);
        assert.ok(
          denied(r.status),
          `${user} got a link for blue media ${id}: ${r.status}`,
        );
        assert.ok(
          !text(r).includes("signature="),
          "a signed URL was issued across tenants",
        );
      }
    for (const user of BLUE_USERS)
      for (const id of greenIds) {
        const r = await link(user, id);
        assert.ok(
          denied(r.status),
          `${user} got a link for green media ${id}: ${r.status}`,
        );
        assert.ok(
          !text(r).includes("signature="),
          "a signed URL was issued across tenants",
        );
      }
    // The file itself: a legitimate link works once; every tampered or replayed form is refused.
    const guardian = await as("guardian");
    const url = (
      (await link("guardian", green.media.shared)).json as { url: string }
    ).url;
    const file = await guardian.get(url);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/png");
    const [path, query] = url.split("?");
    const swappedId = `${path.replace(green.media.shared, blue.media.shared)}?${query}`;
    assert.equal(
      (await guardian.get(swappedId)).status,
      403,
      "signature must be bound to the media id",
    );
    assert.equal((await guardian.get(path)).status, 403, "unsigned request");
    const forged = query.replace(
      /signature=[a-f0-9]{64}/,
      `signature=${"0".repeat(64)}`,
    );
    assert.equal(
      (await guardian.get(`${path}?${forged}`)).status,
      403,
      "forged signature",
    );
    // Replay from another account, in another academy and in the same one.
    assert.equal(
      (await (await as("blueGuardian")).get(url)).status,
      403,
      "blue guardian replayed a green link",
    );
    assert.equal(
      (await (await as("guardian2")).get(url)).status,
      403,
      "another family replayed the link",
    );
    const blueUrl = (
      (await link("blueGuardian", blue.media.shared)).json as { url: string }
    ).url;
    assert.equal(
      (await (await as("guardian")).get(blueUrl)).status,
      403,
      "green guardian replayed a blue link",
    );
    assert.equal(
      (await (await as("owner")).get(blueUrl)).status,
      403,
      "green owner replayed a blue link",
    );
  },
);
/** Same request shape against the actor's own academy (control) and then a foreign one. */
async function writeIsolation<T>(options: {
  name: string;
  route: string;
  own: { user: FixtureUserKey; body: unknown };
  foreign: { user: FixtureUserKey; body: unknown }[];
  snapshot: () => Promise<T>;
  /** Extra statuses that still mean "refused" for this action (default: only 403/404). */
  alsoDenied?: number[];
}) {
  const control = await (
    await as(options.own.user)
  ).post(`/api/academy/${options.route}`, options.own.body);
  assert.equal(
    control.status,
    200,
    `${options.name}: control request must succeed (${control.status} ${text(control).slice(0, 120)})`,
  );
  for (const f of options.foreign) {
    const before = await options.snapshot();
    const r = await (
      await as(f.user)
    ).post(`/api/academy/${options.route}`, f.body);
    assert.ok(
      denied(r.status) || options.alsoDenied?.includes(r.status),
      `${options.name}: ${f.user} succeeded across tenants (${r.status} ${text(r).slice(0, 120)})`,
    );
    assert.deepEqual(
      await options.snapshot(),
      before,
      `${options.name}: ${f.user} changed a foreign record`,
    );
  }
}
test(
  "report edits by id cannot cross academies",
  { timeout: TEST_TIMEOUT },
  async () => {
    const state = async (id: string) =>
      (await db().select().from(t.reports).where(eq(t.reports.id, id)))[0];
    const body = (id: string, version: number) => ({
      id,
      version,
      action: "save",
      summary: "edited by test",
      reason: "",
    });
    await writeIsolation({
      name: "reports/update green->blue",
      route: "reports/update",
      own: { user: "owner", body: body(green.reportId, 3) },
      foreign: [
        { user: "owner", body: body(blue.reportId, 3) },
        { user: "headCoach", body: body(blue.reportId, 3) },
      ],
      snapshot: () => state(blue.reportId),
    });
    await writeIsolation({
      name: "reports/update blue->green",
      route: "reports/update",
      own: { user: "blueOwner", body: body(blue.reportId, 3) },
      foreign: [
        { user: "blueOwner", body: body(greenB.reportId, 3) },
        { user: "blueCoach", body: body(greenB.reportId, 3) },
      ],
      snapshot: () => state(greenB.reportId),
    });
  },
);
test(
  "nutrition plan edits by id cannot cross academies",
  { timeout: TEST_TIMEOUT },
  async () => {
    const draftId = (pid: string) => `nutrition-draft-${pid}`;
    const state = async (id: string) =>
      (
        await db()
          .select()
          .from(t.nutritionPlans)
          .where(eq(t.nutritionPlans.id, id))
      )[0];
    const body = (pid: string) => ({
      id: draftId(pid),
      version: 1,
      playerId: pid,
      title: "Edited by test",
      guidance: "Edited by test guidance",
      action: "save",
      reviewNote: "",
    });
    await writeIsolation({
      name: "nutrition/plan green->blue",
      route: "nutrition/plan",
      own: { user: "nutrition", body: body(green.playerId) },
      foreign: [
        { user: "nutrition", body: body(blue.playerId) },
        { user: "owner", body: body(blue.playerId) },
      ],
      snapshot: () => state(draftId(blue.playerId)),
    });
    await writeIsolation({
      name: "nutrition/plan blue->green",
      route: "nutrition/plan",
      own: { user: "blueOwner", body: body(blue.playerId) },
      foreign: [{ user: "blueOwner", body: body(greenB.playerId) }],
      snapshot: () => state(draftId(greenB.playerId)),
    });
  },
);
test(
  "media reviews by id cannot cross academies",
  { timeout: TEST_TIMEOUT },
  async () => {
    const state = async (id: string) =>
      (
        await db().select().from(t.mediaAssets).where(eq(t.mediaAssets.id, id))
      )[0];
    const body = (id: string) => ({
      id,
      version: 1,
      feedback: "Reviewed by test",
      share: false,
    });
    await writeIsolation({
      name: "media/review green->blue",
      route: "media/review",
      own: { user: "coach", body: body(green.media.shared) },
      foreign: [
        { user: "owner", body: body(blue.media.shared) },
        { user: "headCoach", body: body(blue.media.private) },
      ],
      snapshot: async () => [
        await state(blue.media.shared),
        await state(blue.media.private),
      ],
    });
    await writeIsolation({
      name: "media/review blue->green",
      route: "media/review",
      own: { user: "blueCoach", body: body(blue.media.private) },
      foreign: [{ user: "blueOwner", body: body(greenB.media.shared) }],
      snapshot: () => state(greenB.media.shared),
    });
  },
);
test(
  "refunds by payment id cannot cross academies",
  { timeout: TEST_TIMEOUT },
  async () => {
    const count = async (id: string) =>
      (await db().select().from(t.refunds).where(eq(t.refunds.paymentId, id)))
        .length;
    const body = (paymentId: string) => ({
      paymentId,
      amount: 100,
      reason: "Refund by test",
      idempotencyKey: crypto.randomUUID(),
      confirmedExternalRefund: true,
    });
    await writeIsolation({
      name: "fees/refund green->blue",
      route: "fees/refund",
      own: { user: "finance", body: body(green.paymentId) },
      foreign: [
        { user: "finance", body: body(blue.paymentId) },
        { user: "owner", body: body(blue.paymentId) },
      ],
      snapshot: () => count(blue.paymentId),
      // This service answers "not found" and "not verified" with the same 422; the control above
      // proves the request shape is valid, so for a foreign id the refusal is about the tenant.
      alsoDenied: [422],
    });
    await writeIsolation({
      name: "fees/refund blue->green",
      route: "fees/refund",
      own: { user: "blueOwner", body: body(blue.paymentId) },
      foreign: [{ user: "blueOwner", body: body(greenB.paymentId) }],
      snapshot: () => count(greenB.paymentId),
      alsoDenied: [422],
    });
  },
);
test(
  "player, enquiry and batch edits by id cannot cross academies",
  { timeout: TEST_TIMEOUT },
  async () => {
    const profile = (notes: string) => ({
      adult: false,
      birthDate: "2015-07-07",
      email: "",
      phone: "",
      notes,
      status: "ACTIVE",
      selfUserId: null,
      preferences: "",
    });
    const player = async (id: string) =>
      (await db().select().from(t.players).where(eq(t.players.id, id)))[0];
    await writeIsolation({
      name: "players/save green->blue",
      route: "players/save",
      own: {
        user: "owner",
        body: {
          id: green.playerId,
          version: 1,
          name: "Renamed by test",
          batchId: "green-main",
          profile: profile("x"),
        },
      },
      foreign: [
        {
          user: "owner",
          body: {
            id: blue.playerId,
            version: 1,
            name: "Hijacked",
            batchId: "green-main",
            profile: profile("x"),
          },
        },
      ],
      snapshot: () => player(blue.playerId),
    });
    await writeIsolation({
      name: "players/save blue->green",
      route: "players/save",
      own: {
        user: "blueOwner",
        body: {
          id: blue.playerId,
          version: 1,
          name: "Renamed by test",
          batchId: "blue-batch",
          profile: profile("x"),
        },
      },
      foreign: [
        {
          user: "blueOwner",
          body: {
            id: green.playerId,
            version: 1,
            name: "Hijacked",
            batchId: "blue-batch",
            profile: profile("x"),
          },
        },
      ],
      snapshot: () => player(green.playerId),
    });
    const enquiry = async () =>
      (
        await db()
          .select()
          .from(t.enquiries)
          .where(eq(t.enquiries.id, "fx-enquiry"))
      )[0];
    const enquiryBody = (id: string) => ({
      id,
      version: 1,
      status: "ENQUIRY",
      data: {
        ...CANARY.enquiry,
        adult: false,
        source: "t",
        followUpDate: "",
        notes: "edited",
        trialAttendance: "NOT_MARKED",
        feedback: "",
      },
    });
    await writeIsolation({
      name: "admissions/save blue->green",
      route: "admissions/save",
      own: { user: "owner", body: enquiryBody("fx-enquiry") },
      foreign: [{ user: "blueOwner", body: enquiryBody("fx-enquiry") }],
      snapshot: enquiry,
    });
    const batch = async (id: string) =>
      (await db().select().from(t.batches).where(eq(t.batches.id, id))).map(
        (b) => b.name,
      );
    await writeIsolation({
      name: "settings/batch green->blue",
      route: "settings/batch",
      own: {
        user: "owner",
        body: {
          id: "green-main",
          name: "Renamed main",
          branchId: "green-branch",
          coachId: USERS.coach.id,
        },
      },
      foreign: [
        {
          user: "owner",
          body: {
            id: "blue-batch",
            name: "Hijacked",
            branchId: "green-branch",
            coachId: USERS.coach.id,
          },
        },
      ],
      snapshot: () => batch("blue-batch"),
    });
  },
);
test(
  "conversations cannot be opened or posted to across academies",
  { timeout: TEST_TIMEOUT },
  async () => {
    const entries = async (id: string) =>
      (
        await db()
          .select()
          .from(t.conversations)
          .where(eq(t.conversations.id, id))
      )[0]?.entries.length;
    const body = (id: string, playerId: string, guardianId: string) => ({
      id,
      version: 1,
      guardianId,
      playerId,
      subject: "Fixture conversation",
      text: "Posted by test",
      entryId: crypto.randomUUID(),
    });
    await writeIsolation({
      name: "communications/conversation green->blue",
      route: "communications/conversation",
      own: {
        user: "coach",
        body: body(green.conversationId, green.playerId, USERS.guardian.id),
      },
      foreign: [
        {
          user: "owner",
          body: body(blue.conversationId, blue.playerId, USERS.blueGuardian.id),
        },
        {
          user: "guardian",
          body: body(blue.conversationId, blue.playerId, USERS.guardian.id),
        },
      ],
      snapshot: () => entries(blue.conversationId),
    });
    await writeIsolation({
      name: "communications/conversation blue->green",
      route: "communications/conversation",
      own: {
        user: "blueCoach",
        body: body(blue.conversationId, blue.playerId, USERS.blueGuardian.id),
      },
      foreign: [
        {
          user: "blueOwner",
          body: body(green.conversationId, green.playerId, USERS.guardian.id),
        },
      ],
      snapshot: () => entries(green.conversationId),
    });
  },
);
test(
  "bulk payloads are tenant-clean: no id or canary from the other academy appears in any list",
  { timeout: TEST_TIMEOUT },
  async () => {
    const blueValues = [
      ...canaryValues(CANARY.blue),
      blue.playerId,
      blue.reportId,
      blue.paymentId,
      blue.media.shared,
      blue.media.private,
    ];
    const greenValues = [
      ...canaryValues(CANARY.childA),
      ...canaryValues(CANARY.childB),
      green.playerId,
      greenB.playerId,
      green.reportId,
      greenB.reportId,
      green.paymentId,
      greenB.paymentId,
      green.media.shared,
      green.media.private,
      greenB.media.shared,
    ];
    for (const user of GREEN_USERS)
      assertNoLeak(
        (await (await as(user)).get("/api/academy")).json,
        blueValues,
        `${user}`,
      );
    for (const user of BLUE_USERS)
      assertNoLeak(
        (await (await as(user)).get("/api/academy")).json,
        greenValues,
        `${user}`,
      );
  },
);
