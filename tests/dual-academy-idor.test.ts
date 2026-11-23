import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { CANARY, FIXTURE_PASSWORD, addFixtureUser, canaryValues, idsFor } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT, TEST_TIMEOUT } from "./helpers/paths";
import { assertNoLeak } from "./helpers/payload";
import { unique } from "./helpers/accounts";
import type { TestClient } from "./helpers/client";

/**
 * Overnight audit (regression): the strongest cross-academy case is not an outsider, it is a person who legitimately
 * holds the HIGHEST authority in BOTH academies. Phase 2 lets one account belong to several academies, so while they work
 * in one, every record id of the other must be as unreachable as it is for a stranger, for reads AND writes, and nothing
 * of the other academy may change. tests/cross-academy.test.ts proves this for single-membership users of every role;
 * this proves it for the account that is a member of both, with a positive control in each direction (the same request
 * works in the academy that owns the record), so a refusal can only mean "wrong academy".
 */
let app: Harness;
before(async () => {
  app = await startHarness("dual-academy-idor");
}, { timeout: HOOK_TIMEOUT });
after(async () => {
  await app.stop();
}, { timeout: HOOK_TIMEOUT });

const db = () => database();
const API = "/api/academy";
const green = idsFor("childA");
const blue = idsFor("blue");
const denied = (status: number) => status === 403 || status === 404;

async function dualOwner() {
  const id = `dual-${unique()}`;
  const { email } = await addFixtureUser(id, [
    { academyId: "green", role: "OWNER" },
    { academyId: "blue", role: "OWNER" },
  ]);
  const client = app.anonymous();
  const signedIn = await client.signIn(email, FIXTURE_PASSWORD);
  assert.equal(signedIn.status, 200, signedIn.text.slice(0, 120));
  return { id, client };
}
const choose = async (c: TestClient, academyId: "green" | "blue") =>
  assert.equal((await c.post("/api/auth/account/select-academy", { academyId })).status, 200);
const nameOf = async (c: TestClient) => ((await c.get(`${API}/identity`)).json as { academy: { name: string } }).academy.name;

/** A fingerprint of everything of one academy that these requests could possibly change. */
async function fingerprint(academyId: string) {
  const own = <T extends { academyId: unknown }>(rows: T[]) => JSON.stringify(rows.filter((r) => r.academyId === academyId));
  return JSON.stringify([
    own(await db().select().from(t.players)),
    own(await db().select().from(t.invoices)),
    own(await db().select().from(t.reports)),
    own(await db().select().from(t.memberships)),
    own(await db().select().from(t.academyInvitations)),
    own(await db().select().from(t.mediaAssets)),
    JSON.stringify(await db().select().from(t.refunds)),
  ]);
}

test("a person who owns BOTH academies, working in one, cannot read the other's records by id; the same ids work in the academy that owns them", { timeout: TEST_TIMEOUT }, async () => {
  const { client } = await dualOwner();
  const reads = (ids: ReturnType<typeof idsFor>) => [
    `${API}/reports/${ids.reportId}/pdf`,
    `${API}/fees/${ids.paymentId}/receipt`,
    `${API}/media/${ids.media.shared}/link`,
    `${API}/media/${ids.media.private}/link`,
    `${API}/consent/${ids.playerId}`,
  ];

  await choose(client, "green");
  assert.equal(await nameOf(client), "Fixture Green Academy");
  // Controls: green's own records are reachable from green.
  for (const path of reads(green)) assert.equal((await client.get(path)).status, 200, `own record: ${path}`);
  // The other academy's records are not, whoever the person is elsewhere, and nothing about them leaks.
  for (const path of reads(blue)) {
    const r = await client.get(path);
    assert.ok(denied(r.status), `${path} -> ${r.status}`);
    assertNoLeak(r.json ?? r.text, canaryValues(CANARY.blue), path);
    assert.ok(!r.text.includes("signature="), "a signed link was issued for another academy's media");
  }

  await choose(client, "blue");
  assert.equal(await nameOf(client), "Fixture Blue Academy");
  for (const path of reads(blue)) assert.equal((await client.get(path)).status, 200, `own record after switching: ${path}`);
  for (const path of reads(green)) {
    const r = await client.get(path);
    assert.ok(denied(r.status), `${path} -> ${r.status}`);
    assertNoLeak(r.json ?? r.text, canaryValues(CANARY.childA), path);
  }
});

test("the same person cannot WRITE to the other academy by id: reports, media, refunds and an invitation of the other academy are untouched", { timeout: TEST_TIMEOUT }, async () => {
  const { client } = await dualOwner();
  // An open invitation in BLUE (made by blue's own owner) whose id the dual owner will try to withdraw from GREEN.
  const blueOwner = await app.as("blueOwner");
  const made = await blueOwner.post(`${API}/invitations/create`, { email: `idor.${unique()}@example.test`, kind: "STAFF", role: "COACH" });
  assert.equal(made.status, 200, made.text);
  const blueInvitationId = (made.json as { id: string }).id;
  const greenInvitation = await (async () => {
    const owner = await app.as("owner");
    const r = await owner.post(`${API}/invitations/create`, { email: `idor.${unique()}@example.test`, kind: "STAFF", role: "COACH" });
    assert.equal(r.status, 200, r.text);
    return (r.json as { id: string }).id;
  })();

  await choose(client, "green");
  const post = (route: string, body: unknown) => client.post(`${API}/${route}`, body);
  // Request shapes are the ones tests/cross-academy.test.ts proves valid; each has a CONTROL against the academy being
  // worked in (it must succeed), so a refusal of the same shape against the other academy can only be about the academy.
  const report = (id: string) => ({ id, version: 3, action: "save", summary: "edited by test", reason: "" });
  const review = (id: string) => ({ id, version: 1, feedback: "Reviewed by test", share: false });
  const refund = (paymentId: string) => ({ paymentId, amount: 100, reason: "Refund by test", idempotencyKey: crypto.randomUUID(), confirmedExternalRefund: true });
  for (const [route, own] of [
    ["reports/update", report(green.reportId)],
    ["media/review", review(green.media.shared)],
    ["fees/refund", refund(green.paymentId)],
    ["invitations/revoke", { id: greenInvitation }],
  ] as const) {
    const control = await post(route, own);
    assert.equal(control.status, 200, `control ${route}: ${control.status} ${control.text.slice(0, 120)}`);
  }

  const before = await fingerprint("blue");
  const attempts: [string, unknown][] = [
    ["reports/update", report(blue.reportId)],
    ["media/review", review(blue.media.shared)],
    ["media/review", review(blue.media.private)],
    ["fees/refund", refund(blue.paymentId)],
    ["invitations/revoke", { id: blueInvitationId }],
  ];
  for (const [route, body] of attempts) {
    const r = await post(route, body);
    // fees/refund answers "not found" and "not verified" alike with 422; its control above proves the shape is valid.
    assert.ok(denied(r.status) || (route === "fees/refund" && r.status === 422), `${route} across academies -> ${r.status} ${r.text.slice(0, 100)}`);
  }
  assert.equal(await fingerprint("blue"), before, "blue changed although every request was made while working in green");

  // The invitation is still open and still withdrawable by the academy that owns it (control for the 4xx above).
  const stillOpen = await db().select().from(t.academyInvitations).where(eq(t.academyInvitations.id, blueInvitationId));
  assert.equal(stillOpen[0].status, "PENDING");
  // Finally the owner of blue can still withdraw their own invitation (nothing about it was disturbed).
  assert.equal((await blueOwner.post(`${API}/invitations/revoke`, { id: blueInvitationId })).status, 200);
});
