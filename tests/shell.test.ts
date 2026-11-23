import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FAMILY_ROLES,
  MODULES,
  STAFF_ROLES,
  canOpen,
  defaultModule,
  hrefOf,
  isFamilyRole,
  labelOfSlug,
  modulesForRole,
  slugOfLabel,
  slugOfPath,
} from "../src/modules/academy/ui/navigation";
import { contrast, initials, monogramColours } from "../src/shell/brand";

/** Pure rules behind the Phase 9 shell. The expected lists are written out independently of the code. */
const SLUGS = ["overview", "admissions", "players", "calendar", "training", "reports", "nutrition", "video", "fees", "communications", "settings"];

test("the eleven modules keep their URLs and labels", () => {
  assert.deepEqual(MODULES.map((m) => m.slug), SLUGS);
  assert.equal(labelOfSlug("video"), "Video & AI Analysis");
  assert.equal(slugOfLabel("Video & AI Analysis"), "video");
  assert.equal(hrefOf("players"), "/players");
});

test("each role is offered exactly the modules it can use on the server", () => {
  assert.deepEqual(modulesForRole("OWNER"), SLUGS);
  assert.deepEqual(modulesForRole("ADMIN"), SLUGS);
  assert.deepEqual(modulesForRole("HEAD_COACH"), SLUGS.filter((s) => s !== "fees"));
  assert.deepEqual(modulesForRole("COACH"), ["overview", "players", "calendar", "training", "reports", "nutrition", "video", "communications"]);
  assert.deepEqual(modulesForRole("FINANCE"), ["overview", "fees"]);
  assert.deepEqual(modulesForRole("NUTRITION_PRO"), ["overview", "nutrition"]);
  // family roles use /family, and an unknown role gets nothing
  for (const role of [...FAMILY_ROLES, "INVENTED"]) assert.deepEqual(modulesForRole(role), []);
});

test("money, admissions and settings are never offered to roles the server refuses", () => {
  assert.equal(canOpen("COACH", "fees"), false);
  assert.equal(canOpen("COACH", "admissions"), false);
  assert.equal(canOpen("COACH", "settings"), false);
  assert.equal(canOpen("HEAD_COACH", "fees"), false);
  assert.equal(canOpen("FINANCE", "training"), false);
  assert.equal(canOpen("FINANCE", "players"), false);
  assert.equal(canOpen("NUTRITION_PRO", "fees"), false);
  assert.equal(canOpen("OWNER", "fees"), true);
});

test("every staff role has a landing page it is allowed to open", () => {
  assert.deepEqual(
    Object.fromEntries(STAFF_ROLES.map((r) => [r, defaultModule(r)])),
    { OWNER: "overview", ADMIN: "overview", HEAD_COACH: "overview", COACH: "training", FINANCE: "fees", NUTRITION_PRO: "nutrition" },
  );
  for (const role of STAFF_ROLES) assert.ok(canOpen(role, defaultModule(role)), role);
});

test("paths map to modules and everything else is not a module", () => {
  assert.equal(slugOfPath("/players"), "players");
  assert.equal(slugOfPath("/training"), "training");
  assert.equal(slugOfPath("/players/123"), "players");
  assert.equal(slugOfPath("/"), undefined);
  assert.equal(slugOfPath("/login"), undefined);
  assert.equal(slugOfPath("/family"), undefined);
  assert.equal(slugOfPath("/account"), undefined);
  assert.equal(isFamilyRole("GUARDIAN"), true);
  assert.equal(isFamilyRole("OWNER"), false);
});

test("monogram: initials come from the academy name, and a poor accent colour never makes unreadable text", () => {
  assert.equal(initials("Greenfield Badminton Academy"), "GB");
  assert.equal(initials("Bluebird Badminton Academy"), "BB");
  assert.equal(initials("The Smash Club"), "SC");
  assert.equal(initials("Ace"), "AC");
  assert.equal(initials("   "), "A");
  for (const accent of ["#17644e", "#087047", "#10273d", "#ffd400", "#ffffff", "#7f7f7f", "#f0f0f0"]) {
    const { background, color } = monogramColours(accent);
    assert.ok(contrast(background, color) >= 4.5, `${accent} -> ${background}/${color}`);
  }
  // invalid values fall back to the brand green with white text
  for (const bad of [null, undefined, "", "red", "#12", "javascript:alert(1)", "#12345g"]) assert.deepEqual(monogramColours(bad), { background: "#087047", color: "#ffffff" });
});
