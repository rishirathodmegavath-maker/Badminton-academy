import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { database } from "../src/infrastructure/database/client";
import * as t from "../src/infrastructure/database/schema";
import { ownerConstraintError } from "../src/modules/settings/application/service";
import { coachConstraintError } from "../src/modules/settings/application/coach-assignments";
import { DomainError } from "../src/modules/training/domain/rules";
import { FIXTURE_PASSWORD, USERS, addFixtureUser } from "./helpers/fixtures";
import { startHarness, type Harness } from "./helpers/harness";
import { HOOK_TIMEOUT } from "./helpers/paths";
import { enroll, type Enrolled } from "./helpers/mfa";
import { totpAt } from "./helpers/totp";
import type { TestClient } from "./helpers/client";
/**
 * RC-3 finding F-03: the database refusal of migration 0013 (SQLSTATE 23514, "OWNER_REQUIRED: ...") is reported as
 * the application's own 409 LAST_OWNER, and nothing else is.
 *
 * The RC-2 precheck (assertAnotherActiveOwner, under the academy lock) normally refuses first, so the database
 * refusal cannot be reached through ordinary requests. The end-to-end test therefore injects a fault: a test-only
 * trigger that, inside the request's own transaction, deactivates the academy's other owners as soon as the target
 * membership is written, i.e. AFTER the precheck passed. Only the database can then refuse, at COMMIT.
 */
let app: Harness;
let owner: Enrolled & { client: TestClient };
before(
  async () => {
    app = await startHarness("rc3-owner-presence-translation");
    owner = await enroll(app, USERS.owner);
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
const API = "/api/academy";
type Err = { error?: string; code?: string };
const err = (r: { json: unknown }) => (r.json ?? {}) as Err;
const caught = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  assert.fail("expected the database to refuse");
};
const isLastOwner = (e: unknown) =>
  e instanceof DomainError && e.status === 409 && e.code === "LAST_OWNER" && e.message === "Cannot remove the last active owner of the academy.";
const greenOwners = () =>
  db()
    .select({ userId: t.memberships.userId, role: t.memberships.role, active: t.memberships.active })
    .from(t.memberships)
    .where(and(eq(t.memberships.academyId, "green"), eq(t.memberships.role, "OWNER")))
    .orderBy(t.memberships.userId);

test("ownerConstraintError translates the real OWNER_REQUIRED refusal, raw at COMMIT or wrapped as a query error's cause", async () => {
  // A deferred refusal surfaces when the transaction commits.
  const atCommit = await caught(
    db().transaction(async (tx) => {
      await tx.update(t.memberships).set({ active: false }).where(and(eq(t.memberships.academyId, "quiet"), eq(t.memberships.role, "OWNER")));
    }),
  );
  assert.ok(isLastOwner(ownerConstraintError(atCommit)), String(atCommit));
  // In autocommit the statement itself fails and drizzle wraps the driver error.
  const wrapped = await caught(db().execute(sql`delete from membership where academy_id = 'quiet' and role = 'OWNER'`));
  assert.ok(isLastOwner(ownerConstraintError(wrapped)), String(wrapped));
  assert.equal((await db().select().from(t.memberships).where(eq(t.memberships.userId, USERS.quietOwner.id)))[0].active, true, "nothing changed");
});

test("ownerConstraintError leaves every other error alone (role CHECK, coach triggers, other codes, look-alike messages)", async () => {
  // Another check_violation from the same table: the role CHECK of 0013.
  const roleCheck = await caught(db().execute(sql`update membership set role = 'SuperAdmin' where user_id = ${USERS.coach.id}`));
  assert.equal(ownerConstraintError(roleCheck), null);
  // Another trigger's check_violation: the coach-assignment trigger of 0011 (the coach still coaches batches).
  const coach = await caught(db().execute(sql`update membership set active = false where user_id = ${USERS.coach.id}`));
  assert.ok(coachConstraintError(coach), String(coach));
  assert.equal(ownerConstraintError(coach), null);
  // Synthetic look-alikes: the SQLSTATE and the message prefix must both match.
  for (const e of [
    { code: "23514", message: "COACH_REASSIGNMENT_REQUIRED: OWNER_REQUIRED: not this" },
    { code: "23514", message: "owner_required: lower case" },
    { code: "23505", message: "OWNER_REQUIRED: a unique violation is not the owner rule" },
    { code: "40001", message: "could not serialize access due to concurrent update" },
    { code: 23514, message: "OWNER_REQUIRED: numeric code" },
    new Error("OWNER_REQUIRED: no SQLSTATE"),
    "OWNER_REQUIRED: a string",
    null,
    undefined,
  ])
    assert.equal(ownerConstraintError(e), null, JSON.stringify(e));
});

/** A test-only fault: when `target`'s membership row is written, deactivate every other owner of its academy. */
async function injectConcurrentOwnerRemoval(target: string) {
  await db().execute(sql.raw(`
    CREATE FUNCTION rc3_test_remove_other_owners() RETURNS trigger AS $$
    BEGIN
      UPDATE membership SET active = false
       WHERE academy_id = NEW.academy_id AND role = 'OWNER' AND active AND user_id <> NEW.user_id;
      RETURN NULL;
    END $$ LANGUAGE plpgsql`));
  await db().execute(sql.raw(`
    CREATE TRIGGER rc3_test_remove_other_owners AFTER UPDATE ON membership
      FOR EACH ROW WHEN (NEW.user_id = '${target}') EXECUTE FUNCTION rc3_test_remove_other_owners()`));
}
/** A test-only fault: an unrelated check_violation raised when `target`'s membership row is written. */
async function injectUnrelatedCheckViolation(target: string) {
  await db().execute(sql.raw(`
    CREATE FUNCTION rc3_test_unrelated_check() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'UNRELATED_RULE: not the owner invariant' USING ERRCODE = 'check_violation';
    END $$ LANGUAGE plpgsql`));
  await db().execute(sql.raw(`
    CREATE TRIGGER rc3_test_unrelated_check AFTER UPDATE ON membership
      FOR EACH ROW WHEN (NEW.user_id = '${target}') EXECUTE FUNCTION rc3_test_unrelated_check()`));
}
const removeFault = async (name: string) => {
  await db().execute(sql.raw(`DROP TRIGGER ${name} ON membership`));
  await db().execute(sql.raw(`DROP FUNCTION ${name}()`));
};
const memberChange = (target: { id: string; email: string }, role: string, extra: Record<string, unknown> = {}) =>
  owner.client.post(`${API}/settings/member`, {
    id: target.id,
    name: `Fixture ${target.id}`,
    email: target.email,
    role,
    active: true,
    professionalAttestation: "",
    ...extra,
  });
const confirm = async () => {
  await db().delete(t.totpUsed).where(eq(t.totpUsed.userId, USERS.owner.id));
  return { ownerPassword: FIXTURE_PASSWORD, mfaCode: await totpAt(owner.uri.secret, 0) };
};

test("F-03 end to end: when only the database can refuse, POST settings/member answers 409 LAST_OWNER and nothing is saved", async () => {
  const second = await addFixtureUser("rc3-second-owner", [{ academyId: "green", role: "OWNER" }]);
  const ownersBefore = await greenOwners();
  const eventsBefore = (await db().select().from(t.securityEvent)).length;
  await injectConcurrentOwnerRemoval(second.id);
  try {
    // The precheck passes (fx-owner is another active owner); the injected fault then removes fx-owner too, so the
    // transaction would leave green ownerless; 0013 refuses at COMMIT.
    const r = await memberChange(second, "COACH", await confirm());
    assert.equal(r.status, 409, r.text);
    assert.deepEqual(err(r), { error: "Cannot remove the last active owner of the academy.", code: "LAST_OWNER" });
  } finally {
    await removeFault("rc3_test_remove_other_owners");
  }
  assert.deepEqual(await greenOwners(), ownersBefore, "the whole transaction was rolled back");
  assert.equal((await db().select().from(t.securityEvent)).length, eventsBefore, "no OWNER_REVOKED or other event was kept");
  // Without the fault the same change is an ordinary, permitted demotion: the translation blocks nothing else.
  const ok = await memberChange(second, "COACH", await confirm());
  assert.equal(ok.status, 200, ok.text);
});

test("F-03 negative control: an unrelated check_violation is NOT reported as LAST_OWNER (generic 500, nothing saved)", async () => {
  const other = await addFixtureUser("rc3-unrelated-target", [{ academyId: "green", role: "COACH" }]);
  await injectUnrelatedCheckViolation(other.id);
  try {
    const r = await memberChange(other, "FINANCE");
    assert.equal(r.status, 500, r.text);
    assert.notEqual(err(r).code, "LAST_OWNER");
  } finally {
    await removeFault("rc3_test_unrelated_check");
  }
  assert.equal((await db().select().from(t.memberships).where(eq(t.memberships.userId, other.id)))[0].role, "COACH");
});

