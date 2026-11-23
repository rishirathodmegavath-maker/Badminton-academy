import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  ACCOUNT_TYPES,
  CAPABILITIES,
  OWNER_EXCLUSIVE_CAPABILITIES,
  STAFF_DESIGNATIONS,
  STORED_ROLES,
  authorityOf,
  can,
  isStoredRole,
  requireCapability,
  rolesWith,
  type Capability,
} from "../src/modules/identity/authority";
import {
  coachingRoles,
  family,
  financeRoles,
  narrowRoles,
  opsRoles,
  requireRole,
  staff,
} from "../src/modules/academy/application/access";
import { isManager, type Actor } from "../src/modules/identity/access";
import { CONSENT_ADMIN_ROLES, CONSENT_FAMILY_ROLES } from "../src/modules/consent/domain";
import { ACCESS_LOG_VIEWERS } from "../src/modules/audit/domain";
import { SECURITY_EVENT_VIEWERS } from "../src/modules/identity/security-event-log";
import { MFA_POLICY_EDITORS, MFA_POLICY_VIEWERS } from "../src/modules/identity/mfa-admin";
import { ROLE_NAMES } from "../src/modules/identity/mfa-policy";
import { resetDecision } from "../src/modules/identity/reset-policy";
import { DomainError } from "../src/modules/training/domain/rules";
import { ROLES as FIXTURE_ROLES } from "./helpers/fixtures";
import { LEGACY_LISTS, LEGACY_SITES } from "./helpers/legacy-authorization";
import { REPO_ROOT } from "./helpers/paths";
/**
 * Role consolidation RC-1, golden equivalence table T-EQ (acceptance tests AT-1, AT-2, AT-3, AT-4, AT-5, AT-6).
 *
 * Three independent descriptions of who may do what must agree, cell by cell, for every stored role and every
 * capability, and must deny every value that is not a stored role:
 *   GOLDEN   transcribed by hand from the verified current matrix
 *            (D:\Audit\Phase1\ROLE_CONSOLIDATION_BLUEPRINT\CURRENT_ROLE_PERMISSION_MATRIX.md);
 *   LEGACY   a frozen literal copy of every pre-RC-1 role check (tests/helpers/legacy-authorization.ts);
 *   can()    the new authority module.
 * RC-1 approves NO change: there is no CH row in this table. The five OWNER-only capabilities (D1) were
 * OWNER-only before RC-1 and stay so.
 */

// Columns: OWNER ADMIN HEAD_COACH COACH FINANCE NUTRITION_PRO GUARDIAN ADULT_PLAYER
const GOLDEN_TEXT = `
workspace.access          Y Y Y Y Y Y Y Y
training.studio           Y Y Y Y - - - -
training.allSessions      Y Y Y - - - - -
academy.settings          Y Y - - - - - -
academy.structure         Y Y Y - - - - -
members.manage            Y - - - - - - -
members.resetCredentials  Y - - - - - - -
security.mfa.view         Y Y - - - - - -
security.mfa.edit         Y - - - - - - -
logs.security             Y Y - - - - - -
logs.access               Y Y - - - - - -
logs.audit                Y Y Y - - - - -
admissions.manage         Y Y Y - - - - -
players.manage            Y Y Y - - - - -
guardians.link            Y Y Y - - - - -
consent.admin             Y Y - - - - - -
consent.self              - - - - - - Y Y
calendar.manage           Y Y Y - - - - -
sessions.schedule         Y Y Y Y - - - -
sessions.coach            Y Y Y Y - - - -
reports.author            Y Y Y Y - - - -
reports.approve           Y Y Y - - - - -
reports.read              Y Y Y Y - - Y Y
media.manage              Y Y Y Y - - - -
media.view                Y Y Y Y - - Y Y
nutrition.author          Y Y Y Y - Y - -
nutrition.approve         - - - - - Y - -
nutrition.share           Y Y Y - - Y - -
nutrition.restricted      - - - - - Y Y Y
nutrition.answer          - - - - - Y - -
nutrition.ask             - - - - - - Y Y
nutrition.assign          Y Y - - - - - -
comms.author              Y Y Y Y - - - -
comms.approve             Y Y Y - - - - -
comms.conversation        Y Y Y Y - - Y Y
finance.manage            Y Y - - Y - - -
finance.pay               Y Y - - Y - Y Y
privacy.manage            Y Y - - - - - -
privacy.retention         Y - - - - - - -
privacy.releaseHold       Y - - - - - - -
family.portal             - - - - - - Y Y
portal.staff              Y Y Y Y Y Y - -
`;
const COLUMNS = [
  "OWNER",
  "ADMIN",
  "HEAD_COACH",
  "COACH",
  "FINANCE",
  "NUTRITION_PRO",
  "GUARDIAN",
  "ADULT_PLAYER",
] as const;
const GOLDEN = new Map<string, Map<string, boolean>>(
  GOLDEN_TEXT.trim()
    .split("\n")
    .map((line) => {
      const [capability, ...cells] = line.trim().split(/\s+/);
      assert.equal(cells.length, 8, `golden row ${capability} has 8 cells`);
      for (const c of cells) assert.ok(c === "Y" || c === "-", `golden cell ${c}`);
      return [capability, new Map(COLUMNS.map((role, i) => [role, cells[i] === "Y"]))];
    }),
);

/** Values that are not stored roles. Every one must be denied everything. */
const NOT_ROLES: unknown[] = [
  "",
  " ",
  "owner",
  "Owner",
  "admin",
  " OWNER",
  "OWNER ",
  "OWNER\n",
  "OWNER\u0000",
  "\uFF2FWNER", // full-width O
  "OWNER\u200B", // zero-width space
  "STAFF",
  "PLAYER",
  "ADMINISTRATOR",
  "SUPER_ADMIN",
  "ROOT",
  "SYSTEM",
  "*",
  "COACH,FINANCE",
  "OWNER|ADMIN",
  "OWNER ADMIN",
  "constructor",
  "__proto__",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "null",
  "undefined",
  null,
  undefined,
  0,
  1,
  true,
  {},
  ["OWNER"],
  { toString: () => "OWNER" },
  new String("OWNER"),
];
const label = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(Object.prototype.toString.call(v)));

test("AT-1: each of the eight stored roles maps to its account type, designation and player scope", () => {
  const expected = {
    OWNER: ["OWNER", null, "ALL"],
    ADMIN: ["STAFF", "ADMINISTRATOR", "ALL"],
    HEAD_COACH: ["STAFF", "HEAD_COACH", "ALL"],
    COACH: ["STAFF", "COACH", "COACHED_BATCHES"],
    FINANCE: ["STAFF", "FINANCE", "NONE_BILLING_ROSTER"],
    NUTRITION_PRO: ["STAFF", "NUTRITION_PRO", "ASSIGNED"],
    GUARDIAN: ["GUARDIAN", null, "LINKED"],
    ADULT_PLAYER: ["PLAYER", null, "SELF"],
  } as const;
  assert.deepEqual([...STORED_ROLES], Object.keys(expected));
  for (const role of STORED_ROLES) {
    const a = authorityOf(role);
    assert.ok(a, role);
    assert.deepEqual([a.accountType, a.designation, a.scope], expected[role], role);
    assert.equal(a.role, role);
    assert.ok(isStoredRole(role));
  }
  // The four account types and five designations are exactly the target ones, and each is used.
  assert.deepEqual([...ACCOUNT_TYPES], ["OWNER", "STAFF", "GUARDIAN", "PLAYER"]);
  assert.deepEqual([...STAFF_DESIGNATIONS], ["ADMINISTRATOR", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO"]);
  for (const type of ACCOUNT_TYPES)
    assert.ok(STORED_ROLES.some((r) => authorityOf(r)!.accountType === type), type);
  // D3: exactly one designation per STAFF role, and only STAFF has one.
  for (const d of STAFF_DESIGNATIONS)
    assert.equal(STORED_ROLES.filter((r) => authorityOf(r)!.designation === d).length, 1, d);
  for (const role of STORED_ROLES) {
    const a = authorityOf(role)!;
    assert.equal(a.accountType === "STAFF", a.designation !== null, role);
  }
});

test("AT-1 / D1: ADMIN is STAFF · Administrator, never OWNER", () => {
  const admin = authorityOf("ADMIN")!;
  assert.equal(admin.accountType, "STAFF");
  assert.equal(admin.designation, "ADMINISTRATOR");
  assert.notEqual(admin.accountType, "OWNER");
  // Only the stored value OWNER yields the OWNER account type.
  assert.deepEqual(STORED_ROLES.filter((r) => authorityOf(r)!.accountType === "OWNER"), ["OWNER"]);
});

test("T-EQ (AT-2): golden table = authority, every capability × every stored role", () => {
  assert.deepEqual([...GOLDEN.keys()].sort(), [...CAPABILITIES].sort(), "golden rows = capabilities");
  let cells = 0;
  for (const capability of CAPABILITIES)
    for (const role of STORED_ROLES) {
      assert.equal(can({ role }, capability), GOLDEN.get(capability)!.get(role), `${capability} × ${role}`);
      cells++;
    }
  assert.equal(cells, CAPABILITIES.length * 8);
});

test("T-EQ (AT-2): every pre-RC-1 check = golden table = authority, per call site", () => {
  const covered = new Set<Capability>();
  for (const s of LEGACY_SITES) {
    covered.add(s.capability);
    for (const role of STORED_ROLES) {
      const before = s.legacy(role);
      const after = s.familyBypass ? can({ role }, "family.portal") || can({ role }, s.capability) : can({ role }, s.capability);
      assert.equal(after, before, `${s.site} × ${role}`);
      // The golden table agrees with the site, where the site is the whole capability.
      if (!s.familyBypass) assert.equal(GOLDEN.get(s.capability)!.get(role), before, `golden ${s.capability} × ${role} (${s.site})`);
    }
    for (const value of NOT_ROLES) {
      if (typeof value !== "string") continue;
      assert.equal(s.legacy(value), false, `legacy ${s.site} denies ${label(value)}`);
      assert.equal(can({ role: value }, s.capability), false, `${s.site} denies ${label(value)}`);
    }
  }
  // Every capability is tied to at least one real pre-RC-1 check: nothing in the model is invented.
  assert.deepEqual([...covered].sort(), [...CAPABILITIES].sort());
});

test("T-EQ: the legacy role lists that remain in src are derived from authority and equal to the frozen ones", () => {
  assert.deepEqual(opsRoles, LEGACY_LISTS.opsRoles);
  assert.deepEqual(coachingRoles, LEGACY_LISTS.coachingRoles);
  assert.deepEqual(financeRoles, LEGACY_LISTS.financeRoles);
  assert.deepEqual(narrowRoles, LEGACY_LISTS.narrowRoles);
  assert.deepEqual([...CONSENT_ADMIN_ROLES], LEGACY_LISTS.CONSENT_ADMIN_ROLES);
  assert.deepEqual([...CONSENT_FAMILY_ROLES], LEGACY_LISTS.CONSENT_FAMILY_ROLES);
  assert.deepEqual([...ACCESS_LOG_VIEWERS], LEGACY_LISTS.ACCESS_LOG_VIEWERS);
  assert.deepEqual([...SECURITY_EVENT_VIEWERS], LEGACY_LISTS.SECURITY_EVENT_VIEWERS);
  assert.deepEqual([...MFA_POLICY_VIEWERS], LEGACY_LISTS.MFA_POLICY_VIEWERS);
  assert.deepEqual([...MFA_POLICY_EDITORS], LEGACY_LISTS.MFA_POLICY_EDITORS);
  assert.deepEqual([...STORED_ROLES], LEGACY_LISTS.knownRoles);
  assert.deepEqual([...STORED_ROLES], LEGACY_LISTS.saveMemberRoleEnum);
  assert.deepEqual(rolesWith("workspace.access"), LEGACY_LISTS.knownRoles);
  assert.deepEqual(rolesWith("training.studio"), LEGACY_LISTS.trainingAudience);
  // Vocabularies that stay in stored names (D2): the MFA policy and the test fixtures name the same eight roles.
  assert.deepEqual([...ROLE_NAMES].sort(), [...STORED_ROLES].sort());
  assert.deepEqual([...FIXTURE_ROLES], [...STORED_ROLES]);
  const actor = (role: string) => ({ role }) as Actor;
  for (const role of [...STORED_ROLES, ...NOT_ROLES.filter((v): v is string => typeof v === "string")]) {
    assert.equal(family(actor(role)), LEGACY_LISTS.family.includes(role as never), `family ${label(role)}`);
    // RC-5: staff() is `portal.staff`: the pre-RC-5 staff workspace list, and false (fail closed) for anything that
    // is not a stored role. Before RC-5 it was !family(), which answered true for such values (never reachable:
    // resolveActor refuses them first).
    assert.equal(staff(actor(role)), LEGACY_LISTS.staffWorkspace.includes(role as never), `staff ${label(role)}`);
    assert.equal(isManager(actor(role)), LEGACY_LISTS.isManager.includes(role as never), `isManager ${label(role)}`);
  }
});

test("AT-3 / D1: the five OWNER-only capabilities belong to OWNER alone; OWNER minus Administrator is exactly them", () => {
  assert.deepEqual([...OWNER_EXCLUSIVE_CAPABILITIES].sort(), [
    "members.manage",
    "members.resetCredentials",
    "privacy.releaseHold",
    "privacy.retention",
    "security.mfa.edit",
  ]);
  for (const c of OWNER_EXCLUSIVE_CAPABILITIES) {
    assert.deepEqual(rolesWith(c), ["OWNER"], c);
    assert.equal(can({ role: "ADMIN" }, c), false, `ADMIN ${c}`);
    assert.throws(() => requireCapability({ role: "ADMIN" }, c), (e: unknown) => e instanceof DomainError && e.status === 403);
  }
  const owner = authorityOf("OWNER")!.capabilities;
  const admin = authorityOf("ADMIN")!.capabilities;
  assert.deepEqual([...owner].filter((c) => !admin.has(c)).sort(), [...OWNER_EXCLUSIVE_CAPABILITIES].sort());
  assert.deepEqual([...admin].filter((c) => !owner.has(c)), [], "Administrator has nothing OWNER lacks");
  // The pure reset decision agrees: an Administrator is refused as NOT_OWNER whatever the target.
  for (const targetRole of STORED_ROLES)
    assert.deepEqual(
      resetDecision({ id: "a", academyId: "x", role: "ADMIN" }, { id: "t", memberships: [{ academyId: "x", role: targetRole }] }),
      { allowed: false, reason: "NOT_OWNER" },
      targetRole,
    );
});

test("AT-3: no ADMIN-to-OWNER escalation through the authority API", () => {
  // Look-alike values, wrappers and objects never resolve to OWNER (or to anything).
  for (const v of ["OWNER ", " OWNER", "owner", "Owner", "OWNER\u0000", "\uFF2FWNER", "ADMIN,OWNER", "OWNER|ADMIN"])
    assert.equal(authorityOf(v), null, label(v));
  assert.equal(authorityOf(["OWNER"]), null);
  assert.equal(authorityOf(new String("OWNER")), null);
  assert.equal(authorityOf({ toString: () => "OWNER" }), null);
  // An object carrying extra fields is judged by its stored role only.
  const forged = { role: "ADMIN", accountType: "OWNER", designation: null, capabilities: new Set(CAPABILITIES) };
  for (const c of OWNER_EXCLUSIVE_CAPABILITIES) assert.equal(can(forged, c), false, c);
  // The derived authority cannot be altered at run time.
  const admin = authorityOf("ADMIN")!;
  assert.ok(Object.isFrozen(admin));
  assert.throws(() => (admin.capabilities as Set<Capability>).add("members.manage"));
  assert.throws(() => (admin.capabilities as Set<Capability>).delete("academy.settings"));
  assert.throws(() => (admin.capabilities as Set<Capability>).clear());
  assert.throws(() => {
    (admin as { accountType: string }).accountType = "OWNER";
  });
  assert.equal(can({ role: "ADMIN" }, "members.manage"), false);
  assert.equal(can({ role: "ADMIN" }, "academy.settings"), true, "Administrator keeps today's ADMIN permissions");
  assert.equal(authorityOf("ADMIN")!.accountType, "STAFF");
});

test("AT-4: staff designations stay distinct; no two stored roles share a capability set except GUARDIAN and ADULT_PLAYER", () => {
  const key = (r: string) => [...authorityOf(r)!.capabilities].sort().join(",");
  for (const a of STORED_ROLES)
    for (const b of STORED_ROLES) {
      if (a >= b) continue;
      const same = key(a) === key(b);
      // GUARDIAN and ADULT_PLAYER had the same function-level checks before RC-1 (family(a)); they differ in scope.
      const expectedSame = [a, b].sort().join() === "ADULT_PLAYER,GUARDIAN";
      assert.equal(same, expectedSame, `${a} vs ${b}`);
    }
  assert.notEqual(authorityOf("GUARDIAN")!.scope, authorityOf("ADULT_PLAYER")!.scope);
  // Sampled designation boundaries (AT-4 examples).
  assert.equal(can({ role: "FINANCE" }, "reports.approve"), false);
  assert.equal(can({ role: "COACH" }, "finance.manage"), false);
  assert.equal(can({ role: "NUTRITION_PRO" }, "sessions.schedule"), false);
  assert.equal(can({ role: "HEAD_COACH" }, "academy.settings"), false);
  assert.equal(can({ role: "FINANCE" }, "workspace.access"), true);
});

test("AT-5 / AT-6: combined, unknown and malformed roles are denied everything", () => {
  for (const value of NOT_ROLES) {
    assert.equal(authorityOf(value), null, label(value));
    assert.equal(isStoredRole(value), false, label(value));
    for (const c of CAPABILITIES) {
      assert.equal(can({ role: value as string }, c), false, `${label(value)} ${c}`);
      assert.throws(
        () => requireCapability({ role: value as string }, c),
        (e: unknown) => e instanceof DomainError && e.status === 403 && e.message === "Your role cannot perform this action.",
      );
    }
  }
  for (const c of CAPABILITIES) {
    assert.equal(can(null, c), false);
    assert.equal(can(undefined, c), false);
    for (const r of rolesWith(c)) assert.ok(isStoredRole(r), `${c} lists only stored roles`);
  }
});

test("requireCapability refuses exactly as requireRole did (status, message, no code)", () => {
  for (const site of LEGACY_SITES)
    for (const role of STORED_ROLES) {
      if (site.familyBypass && can({ role }, "family.portal")) continue;
      const old = (() => {
        try {
          requireRole({ role } as Actor, site.legacy(role) ? [role] : []);
          return null;
        } catch (e) {
          return e as DomainError;
        }
      })();
      const now = (() => {
        try {
          requireCapability({ role }, site.capability);
          return null;
        } catch (e) {
          return e as DomainError;
        }
      })();
      assert.equal(now === null, old === null, `${site.site} × ${role}`);
      if (old && now) {
        assert.equal(now.status, old.status);
        assert.equal(now.message, old.message);
        assert.equal(now.code, old.code);
      }
    }
});

// ------------------------------------------------------------------------------------------------------------------
// AT-17 (partial, RC-1 ratchet). Not the full static gate of the blueprint: RC-1 deliberately leaves the scope and
// read-model checks listed below in place. This test freezes today's inventory so that no NEW role list or role
// comparison appears outside the authority module without being reviewed here.
// ------------------------------------------------------------------------------------------------------------------
const ROOT = REPO_ROOT;
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const SERVER_FILES = sources(join(ROOT, "src")).filter((f) => !f.split(sep).includes("ui"));
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");

test("AT-17 ratchet: no requireRole call remains in server code", () => {
  const callers = SERVER_FILES.flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .map((line, i) => ({ f: rel(f), i: i + 1, line }))
      .filter(({ line }) => /\brequireRole\(/.test(line) && !/export function requireRole\(/.test(line)),
  );
  assert.deepEqual(callers, []);
});

test("AT-17 ratchet: role-name literals in server code appear only where reviewed", () => {
  const ROLE = "OWNER|ADMIN|HEAD_COACH|COACH|FINANCE|NUTRITION_PRO|GUARDIAN|ADULT_PLAYER";
  const literal = new RegExp(`(?:\\[\\s*"(?:${ROLE})"\\s*[,\\]])|(?:role\\s*[!=]==\\s*"(?:${ROLE})")|(?:case\\s+"(?:${ROLE})"\\s*:)|(?:"(?:${ROLE})"\\s*===\\s*\\w*\\.?role)`, "g");
  const found: Record<string, number> = {};
  for (const f of SERVER_FILES) {
    const n = (readFileSync(f, "utf8").match(literal) ?? []).length;
    if (n) found[rel(f)] = n;
  }
  // Reviewed inventory after RC-1 (every entry is a scope, read-model, data or vocabulary use; see
  // RC1_IMPLEMENTATION_REPORT.md §5). A change here needs the same review.
  assert.deepEqual(found, {
    // The eight stored values themselves.
    "src/modules/identity/authority.ts": 2,
    // Stage 5F scope code: accessiblePlayers cases (7), familyScope GUARDIAN branch, billablePlayers FINANCE roster,
    // scopedBatch COACH scope, linkedRecipients family filter (SQL), narrowRoles read-model list.
    // RC-4: 12 -> 10. accessiblePlayers lost its two unreachable family cases (GUARDIAN, ADULT_PLAYER): family
    // accounts have returned through familyScope before the switch since Stage 5F. No literal was added.
    "src/modules/academy/application/access.ts": 10,
    // Staff read model (unchanged file; byte-identical staff payloads): COACH/OWNER/ADMIN/NUTRITION_PRO/FINANCE flags.
    "src/modules/academy/application/bootstrap.ts": 12,
    // COACH own-record scope.
    "src/modules/calendar/application/service.ts": 1,
    "src/modules/communications/application/service.ts": 1,
    "src/modules/media/application/service.ts": 1,
    "src/modules/reports/application/service.ts": 2,
    // Consent rules that differ between GUARDIAN and ADULT_PLAYER (who may decide for whom).
    "src/modules/consent/application/service.ts": 4,
    // Data, not authority: owner count, target-is-owner, MFA vocabulary in stored names (D2).
    "src/modules/identity/mfa-admin.ts": 1,
    "src/modules/identity/reset-policy.ts": 1,
    "src/modules/identity/mfa-policy.ts": 2,
    // A privacy data category named FINANCE (not a role).
    "src/modules/privacy/application/categories.ts": 1,
    // Target-role rules of saveMember (attestation for NUTRITION_PRO; an owner cannot demote itself): 3.
    // RC-2 (+7, all data about the stored OWNER value of the TARGET membership, never the actor's authority):
    // ownerChangeKind (which changes grant or remove OWNER, TD-1) 5; the last-owner precondition (S-2) 2.
    "src/modules/settings/application/service.ts": 10,
    // RC-2 operator owner recovery (TD-5), all data about stored OWNER values: "is a deactivated OWNER membership",
    // "count active owners", "log a role change only if the role changed". Family and Administrator eligibility
    // are decided by the authority module.
    "src/modules/identity/owner-recovery.ts": 3,
    // Invitations (0018): data about the stored GUARDIAN value of the TARGET membership, never the actor's authority: a
    // guardian already in the academy may be invited for another child (create), and accepting then adds only the
    // link (accept). The owner step-up and the professional-authorisation rule go through the authority module
    // (accountType / designation), not through role names.
    "src/modules/invitations/application/service.ts": 2,
    // Access-audit operation label for a COACH listing.
    "src/modules/training/application/service.ts": 1,
  });
});
