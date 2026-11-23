import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./helpers/paths";
/**
 * RC-2 static gates (TEST_AND_ACCEPTANCE_SPECIFICATION AT-17, transaction rule; AUTHORIZATION_SECURITY_ARCHITECTURE
 * section 3.4 item 3):
 *
 *  1. every database transaction opened in src/modules re-validates its actor with lockActor (directly, or through
 *     unit()), except an explicit, justified allow-list that must match exactly, so a new unguarded transaction
 *     fails this test;
 *  2. the academy unit of work and the four Training Studio mutations call lockActor;
 *  3. no application code or script updates or deletes a security event (the log is append-only by
 *     construction; RC-2 changes no schema, so this is the enforcement available without a migration).
 */
function files(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (/\.(ts|tsx|mts)$/.test(name)) out.push(path);
  }
  return out;
}
const rel = (p: string) => relative(REPO_ROOT, p).replace(/\\/g, "/");
const SERVER = files(join(REPO_ROOT, "src/modules")).filter((p) => !rel(p).includes("/ui/"));
/** Transactions that legitimately do not call lockActor, with the reason. Counts must match exactly. */
const ALLOWED: Record<string, { count: number; why: string }> = {
  "src/modules/identity/account-security.ts": {
    count: 3,
    why: "self-service password change (no academy authority involved); MFA-policy change (changeMfaPolicy re-decides owner authority under the academy lock); owner credential reset (re-decides resetDecision under the academy lock)",
  },
  "src/modules/identity/academy-creation.ts": {
    count: 1,
    why: "createAcademyFor: a signed-in person starting an academy of their own. The academy does not exist yet, so there is no actor membership to re-validate; the person is always made its OWNER (never taken from the request), the same transaction locks their own account row so the 5-academy limit cannot be beaten by two requests at once, and the database refuses an academy that is left without an owner.",
  },
  "src/modules/identity/active-academy.ts": {
    count: 1,
    why: "selectAcademy (0017): the signed-in person choosing which of THEIR OWN academies this session works in. It confers no authority: it reads the caller's membership FOR SHARE in the same transaction (conflicting with the FOR UPDATE a member change takes), stores only a choice that the composite foreign keys tie to that membership, and every later request re-reads the membership and lockActor re-validates it before any write.",
  },
  "src/modules/invitations/application/service.ts": {
    count: 1,
    why: "acceptInvitation (0018): the signed-in invitee is NOT a member of the academy yet, so there is no actor membership to re-validate; the authority comes from the invitation. The transaction takes the academy lock first (the order unit() uses), locks the invitation row, and re-validates under that lock everything the grant depends on: the invitation is still pending and unexpired, it is addressed to this account's email, the INVITER still holds an active membership with members.manage (and guardians.link for a guardian), and the person holds no membership yet. Creating and revoking invitations use unit(), which does call lockActor.",
  },
  "src/modules/identity/onboarding.ts": {
    count: 5,
    why: "public onboarding (signup, verify, resend, forgot, reset): nobody is signed in, so there is no actor or academy authority to re-validate; each transaction touches only the requesting person's own account rows (the reset re-checks the owner exclusion inside its transaction)",
  },
  "src/modules/dispatch/application/worker.ts": {
    count: 2,
    why: "the delivery worker (a separate process, no request and no signed-in person): one transaction claims DUE items with FOR UPDATE SKIP LOCKED and leases them, the other records a permanent failure and its suppression. It acts ONLY on dispatch_item rows that an owner-level actor approved into an APPROVED batch (queueDispatch re-validates that actor with unit() at approval time), re-reads every report at send time so a withdrawn one is left out, and holds no authority of its own beyond sending what was approved.",
  },
  "src/modules/dispatch/application/events.ts": {
    count: 1,
    why: "applyProviderEvent: a provider's delivery receipt, called only by the webhook after the raw body's HMAC signature was verified. No person is signed in. It touches only the dispatch_item whose provider message id the event names, moves it forward only, records each provider event once, and may suppress an address for the people that message was for.",
  },
  "src/modules/identity/operator-recovery.ts": { count: 1, why: "operator CLI: no application actor" },
  "src/modules/identity/owner-recovery.ts": { count: 3, why: "operator CLI: no application actor; locks the academy row itself" },
  "src/modules/privacy/application/service.ts": { count: 2, why: "read-only (privacy overview, erasure detail)" },
  "src/modules/academy/application/access.ts": {
    count: 1,
    why: "systemUnit: the privacy worker's unit of work (no request, no membership; acts only on owner-approved requests)",
  },
};

test("AT-17 (transactions): every transaction in src/modules re-validates its actor, or is an allow-listed exception", () => {
  const unguarded: Record<string, number> = {};
  let guarded = 0;
  for (const path of SERVER) {
    const text = readFileSync(path, "utf8");
    for (let at = text.indexOf(".transaction("); at >= 0; at = text.indexOf(".transaction(", at + 1)) {
      // The callback's opening statements: lockActor must come before any write.
      if (/lockActor\(/.test(text.slice(at, at + 700))) guarded++;
      else unguarded[rel(path)] = (unguarded[rel(path)] ?? 0) + 1;
    }
  }
  const expected = Object.fromEntries(Object.entries(ALLOWED).map(([file, v]) => [file, v.count]));
  assert.deepEqual(unguarded, expected, "unguarded transactions differ from the reviewed allow-list");
  assert.equal(guarded, 5, "unit() plus the four Training Studio mutations");
});

test("lockActor is called by unit() and by createSession, mutateSession, createDrill (private drill) and saveGoal", () => {
  const access = readFileSync(join(REPO_ROOT, "src/modules/academy/application/access.ts"), "utf8");
  const unit = access.slice(access.indexOf("export async function unit"), access.indexOf("type Reader"));
  assert.match(unit, /\.for\("update"\);\s*\/\/[^\n]*\n\s*await lockActor\(tx, a\);\s*return fn\(tx\);/, "academy lock, then lockActor, then the work");
  const training = readFileSync(join(REPO_ROOT, "src/modules/training/application/service.ts"), "utf8");
  for (const name of ["createSession", "mutateSession", "createDrill", "saveGoal"]) {
    const start = training.indexOf(`export async function ${name}(`);
    assert.ok(start >= 0, name);
    const next = training.indexOf("export async function", start + 10);
    const body = training.slice(start, next < 0 ? undefined : next);
    const tx = body.indexOf(".transaction(");
    assert.ok(tx >= 0, `${name} opens a transaction`);
    assert.match(body.slice(tx, tx + 400), /lockActor\(tx, actor\)/, `${name} re-validates inside its transaction`);
  }
});

test("no code path updates or deletes a security event", () => {
  const all = [...files(join(REPO_ROOT, "src")), ...files(join(REPO_ROOT, "scripts"))];
  const offenders: string[] = [];
  for (const path of all) {
    const text = readFileSync(path, "utf8");
    if (/\.(update|delete)\(\s*(t\.)?securityEvent\b/.test(text)) offenders.push(`${rel(path)}: drizzle update/delete`);
    if (/(update\s+"?security_event"?\s+set|delete\s+from\s+"?security_event"?)/i.test(text)) offenders.push(`${rel(path)}: SQL`);
  }
  assert.deepEqual(offenders, []);
});

test("systemUnit (no lockActor) is used only by the privacy worker", () => {
  const callers = [...files(join(REPO_ROOT, "src")), ...files(join(REPO_ROOT, "scripts"))]
    .filter((p) => /\bsystemUnit\(/.test(readFileSync(p, "utf8")))
    .map(rel)
    .sort();
  // The definition is `systemUnit<T>(`, so only call sites match.
  assert.deepEqual(callers, ["src/modules/privacy/application/process.ts"]);
});
