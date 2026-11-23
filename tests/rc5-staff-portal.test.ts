import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  CAPABILITIES,
  OWNER_EXCLUSIVE_CAPABILITIES,
  STAFF_DESIGNATIONS,
  STORED_ROLES,
  authorityOf,
  can,
  rolesWith,
  type Capability,
} from "../src/modules/identity/authority";
import {
  FAMILY_ROLES,
  MODULES,
  STAFF_ROLES,
  accountLabel,
  canOpen,
  defaultModule,
  isFamilyAccount,
  isStaffAccount,
  modulesForRole,
  seesAcademyOverview,
} from "../src/modules/academy/ui/navigation";
import { staff, family } from "../src/modules/academy/application/access";
import type { Actor } from "../src/modules/identity/access";
import { REPO_ROOT } from "./helpers/paths";
/**
 * RC-5 staff portal authorization, pure part (no database, no server).
 *
 *   AT-22  the navigation derived from the authority module equals the pre-RC-5 BY_ROLE table, role by role
 *          (frozen literal copy below, NOT imported from src);
 *   matrix every staff designation × every staff-portal capability, written out by hand;
 *   fail closed: unknown, look-alike and family values open nothing in the staff workspace;
 *   UI ratchet: role-name literals in UI code appear only where reviewed (target data and vocabulary, never the
 *          viewer's own authority).
 */

// FROZEN: academy/ui/navigation.ts before RC-5 (BY_ROLE, defaultModule), verbatim.
const ALL = ["overview", "admissions", "players", "calendar", "training", "reports", "nutrition", "video", "fees", "communications", "settings"];
const PRE_RC5_BY_ROLE: Record<string, string[]> = {
  OWNER: ALL,
  ADMIN: ALL,
  HEAD_COACH: ["overview", "admissions", "players", "calendar", "training", "reports", "nutrition", "video", "communications", "settings"],
  COACH: ["overview", "players", "calendar", "training", "reports", "nutrition", "video", "communications"],
  FINANCE: ["overview", "fees"],
  NUTRITION_PRO: ["overview", "nutrition"],
};
const PRE_RC5_DEFAULT = (role: string) =>
  role === "FINANCE" ? "fees" : role === "NUTRITION_PRO" ? "nutrition" : ["OWNER", "ADMIN", "HEAD_COACH"].includes(role) ? "overview" : "training";
const PRE_RC5_STAFF = ["OWNER", "ADMIN", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO"];
const PRE_RC5_FAMILY = ["GUARDIAN", "ADULT_PLAYER"];
// Pre-RC-5 overview split (operations.tsx): COACH, FINANCE, NUTRITION_PRO got their role home.
const PRE_RC5_ROLE_HOME = ["COACH", "FINANCE", "NUTRITION_PRO"];

const NOT_ROLES = ["", "owner", "Owner", " OWNER", "OWNER ", "STAFF", "ADMINISTRATOR", "SUPER_ADMIN", "SYSTEM", "*",
  "OWNER,ADMIN", "COACH|FINANCE", "constructor", "__proto__", "toString", "hasOwnProperty", "ＯWNER", "OWNER​"];

test("AT-22: derived navigation equals the pre-RC-5 BY_ROLE table for every stored role", () => {
  for (const role of STORED_ROLES) {
    assert.deepEqual(modulesForRole(role), PRE_RC5_BY_ROLE[role] ?? [], role);
    for (const slug of ALL) assert.equal(canOpen(role, slug), (PRE_RC5_BY_ROLE[role] ?? []).includes(slug), `${role} ${slug}`);
  }
  for (const role of PRE_RC5_STAFF) {
    assert.equal(defaultModule(role), PRE_RC5_DEFAULT(role), role);
    assert.ok(canOpen(role, defaultModule(role)), `${role} can open its landing module`);
    assert.equal(seesAcademyOverview(role), !PRE_RC5_ROLE_HOME.includes(role), `overview ${role}`);
  }
  assert.deepEqual([...STAFF_ROLES], PRE_RC5_STAFF);
  assert.deepEqual([...FAMILY_ROLES], PRE_RC5_FAMILY);
  assert.deepEqual(MODULES.map((m) => m.slug), ALL);
});

test("portal.staff: the six OWNER/STAFF roles, never a family account; Owner-exclusive powers unchanged", () => {
  assert.deepEqual(rolesWith("portal.staff"), PRE_RC5_STAFF);
  for (const role of STORED_ROLES) {
    const a = authorityOf(role)!;
    assert.equal(can({ role }, "portal.staff"), a.accountType === "OWNER" || a.accountType === "STAFF", role);
    assert.equal(isStaffAccount({ role }) && isFamilyAccount({ role }), false, `${role} is never both`);
    assert.equal(isStaffAccount({ role }) || isFamilyAccount({ role }), true, `${role} has one portal`);
    assert.equal(staff({ role } as Actor), PRE_RC5_STAFF.includes(role), `staff() ${role}`);
    assert.equal(family({ role } as Actor), PRE_RC5_FAMILY.includes(role), `family() ${role}`);
  }
  // Every staff designation holds portal.staff (D3: one designation per STAFF role).
  for (const d of STAFF_DESIGNATIONS) {
    const role = STORED_ROLES.find((r) => authorityOf(r)!.designation === d)!;
    assert.ok(can({ role }, "portal.staff"), d);
  }
  assert.ok(!(OWNER_EXCLUSIVE_CAPABILITIES as readonly string[]).includes("portal.staff"));
  for (const c of OWNER_EXCLUSIVE_CAPABILITIES) assert.deepEqual(rolesWith(c), ["OWNER"], c);
});

// Columns: ADMINISTRATOR HEAD_COACH COACH FINANCE NUTRITION_PRO. Written out by hand from the approved matrix as
// implemented (RC-1 golden table + portal.staff); D9-a (Head Coach has no consent.admin), D9-b (Coach authors
// nutrition), D9-c (only Nutrition Pro among staff reads restrictions) included.
const STAFF_MATRIX = `
portal.staff              Y Y Y Y Y
academy.settings          Y - - - -
academy.structure         Y Y - - -
members.manage            - - - - -
members.resetCredentials  - - - - -
security.mfa.view         Y - - - -
security.mfa.edit         - - - - -
logs.security             Y - - - -
logs.access               Y - - - -
logs.audit                Y Y - - -
admissions.manage         Y Y - - -
players.manage            Y Y - - -
guardians.link            Y Y - - -
consent.admin             Y - - - -
calendar.manage           Y Y - - -
sessions.schedule         Y Y Y - -
training.studio           Y Y Y - -
training.allSessions      Y Y - - -
reports.author            Y Y Y - -
reports.approve           Y Y - - -
reports.read              Y Y Y - -
media.manage              Y Y Y - -
media.view                Y Y Y - -
nutrition.author          Y Y Y - Y
nutrition.approve         - - - - Y
nutrition.share           Y Y - - Y
nutrition.restricted      - - - - Y
nutrition.answer          - - - - Y
nutrition.assign          Y - - - -
comms.author              Y Y Y - -
comms.approve             Y Y - - -
finance.manage            Y - - Y -
privacy.manage            Y - - - -
privacy.retention         - - - - -
privacy.releaseHold       - - - - -
family.portal             - - - - -
`;
const DESIGNATION_ROLE = ["ADMIN", "HEAD_COACH", "COACH", "FINANCE", "NUTRITION_PRO"];

test("staff designation matrix: each designation holds exactly the expected staff-portal capabilities", () => {
  const rows = STAFF_MATRIX.trim().split("\n").map((l) => l.trim().split(/\s+/));
  for (const [capability, ...cells] of rows) {
    assert.ok((CAPABILITIES as readonly string[]).includes(capability), `known capability ${capability}`);
    DESIGNATION_ROLE.forEach((role, i) =>
      assert.equal(can({ role }, capability as Capability), cells[i] === "Y", `${authorityOf(role)!.designation} ${capability}`),
    );
  }
  // Specific approved rules, stated directly.
  assert.equal(can({ role: "HEAD_COACH" }, "consent.admin"), false, "D9-a: Head Coach sees consent flags only");
  assert.equal(can({ role: "COACH" }, "nutrition.author"), true, "D9-b: Coach authors nutrition");
  for (const role of ["OWNER", "ADMIN", "HEAD_COACH", "COACH", "FINANCE"])
    assert.equal(can({ role }, "nutrition.restricted"), false, `D9-c: ${role} never reads allergies`);
});

test("fail closed: unknown, look-alike and family values open no staff module and hold no staff portal", () => {
  for (const role of [...NOT_ROLES, ...PRE_RC5_FAMILY]) {
    assert.deepEqual(modulesForRole(role), [], JSON.stringify(role));
    assert.equal(isStaffAccount({ role }), false, JSON.stringify(role));
    assert.equal(seesAcademyOverview(role), false, JSON.stringify(role));
    for (const slug of [...ALL, "constructor", "__proto__", "toString", ""]) assert.equal(canOpen(role, slug), false);
  }
  for (const role of NOT_ROLES) {
    assert.equal(staff({ role } as Actor), false, `staff() ${JSON.stringify(role)}`);
    assert.equal(isFamilyAccount({ role }), false, JSON.stringify(role));
  }
  // A module name that is not a module (including prototype keys) never opens, even for an OWNER.
  for (const slug of ["constructor", "__proto__", "toString", "hasOwnProperty", "family", "login", "Settings"])
    assert.equal(canOpen("OWNER", slug), false, slug);
  assert.equal(isStaffAccount(null), false);
  assert.equal(isStaffAccount(undefined), false);
  // Extra fields on the object never matter: only the stored role is read.
  const forged = { role: "FINANCE", accountType: "OWNER", designation: "ADMINISTRATOR", capabilities: ["academy.settings"] };
  assert.equal(can(forged, "academy.settings"), false);
  assert.deepEqual(modulesForRole(forged.role), ["overview", "fees"]);
});

test("account labels: account type and single designation, display only", () => {
  assert.deepEqual(
    Object.fromEntries(STORED_ROLES.map((r) => [r, accountLabel(r)])),
    {
      OWNER: "Owner",
      ADMIN: "Staff · Administrator",
      HEAD_COACH: "Staff · Head Coach",
      COACH: "Staff · Coach",
      FINANCE: "Staff · Finance",
      NUTRITION_PRO: "Staff · Nutrition Pro",
      GUARDIAN: "Guardian",
      ADULT_PLAYER: "Player",
    },
  );
  for (const v of NOT_ROLES) assert.equal(accountLabel(v), "Unsupported role", JSON.stringify(v));
});

// ------------------------------------------------------------------------------------------------------------------
// UI ratchet (AT-17 for UI code): role-name literals in src/**/ui appear only where reviewed. None of the entries
// decides what the viewer may do; that is always can() / the navigation module.
// ------------------------------------------------------------------------------------------------------------------
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const rel = (f: string) => relative(REPO_ROOT, f).split(sep).join("/");

test("UI ratchet: role-name literals in UI code appear only where reviewed", () => {
  const ROLE = "OWNER|ADMIN|HEAD_COACH|COACH|FINANCE|NUTRITION_PRO|GUARDIAN|ADULT_PLAYER";
  const literal = new RegExp(`"(?:${ROLE})"`, "g");
  const found: Record<string, number> = {};
  for (const f of sources(join(REPO_ROOT, "src")).filter((f) => f.split(sep).includes("ui") || rel(f).startsWith("src/shell/"))) {
    const n = (readFileSync(f, "utf8").match(literal) ?? []).length;
    if (n) found[rel(f)] = n;
  }
  assert.deepEqual(found, {
    // Target data: the default coach of a new session, and the guardian accounts offered when linking a player
    // (who a record is about, not what the viewer may do). Players are under 18: the adult-player option is gone (3 -> 2).
    "src/modules/academy/ui/operations.tsx": 2,
    // Target data: guardian accounts offered when linking an invoice recipient.
    "src/modules/academy/ui/reviews-finance.tsx": 1,
    // Target data: the default stored role of a new login, and guardian accounts offered for a conversation.
    "src/modules/academy/ui/settings-communications.tsx": 2,
    // Derived designation (authorityOf(role).designation), not a stored role: which role home to show.
    "src/modules/academy/ui/views/role-home.tsx": 2,
    // Target data: "Assign players" only on a Nutrition Pro member; "Reset password" never offered on an Owner
    // member (the server decides, resetDecision).
    "src/modules/academy/ui/views/settings-view.tsx": 2,
    // MFA policy vocabulary in stored names (D2; RC-5 does not change MFA policy), unchanged.
    "src/modules/identity/ui/mfa-policy-panel.tsx": 10,
  });
});
