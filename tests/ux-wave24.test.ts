import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldProblem } from "../src/modules/academy/ui/field-rules";
import { PRIMARY_ITEMS, PRIMARY_OF, SECTION_SLUGS, isSection, sectionOfSlug, urlOfSection, type Section } from "../src/modules/academy/ui/family-sections";
import { setupSteps } from "../src/modules/academy/ui/setup-steps";
import { NETWORK_MESSAGE, readJson, sendRequest } from "../src/shell/request";
import { STAFF_ROLES, canOpen, menuModulesForRole, modulesForRole, HIDDEN_FROM_MENU } from "../src/modules/academy/ui/navigation";
import type { AcademyPayload } from "../src/modules/academy/application/bootstrap";
import type { Field, Values } from "../src/modules/academy/ui/shared";

/**
 * UX Waves 2 to 4 (Badminton): the pure rules behind inline form errors, the family sections, the first-run checklist and
 * the way a failed request is worded. None of these rules is authority: the server validates and authorises every request.
 */

// ---- Wave 3: inline field errors ------------------------------------------------------------------------------
const f = (over: Partial<Field>): Field => ({ name: "x", label: "Event title", ...over });
const v = (values: Values) => values;

test("a required field with no value names itself, and a value that is only spaces counts as empty", () => {
  assert.equal(fieldProblem(f({ required: true }), v({ x: "" })), "Event title is required.");
  assert.equal(fieldProblem(f({ required: true }), v({ x: "   " })), "Event title is required.");
  assert.equal(fieldProblem(f({ required: true }), v({})), "Event title is required.");
  assert.equal(fieldProblem(f({ required: true }), v({ x: "Open day" })), "");
});

test("an optional field left empty is never a problem", () => {
  for (const kind of ["text", "textarea", "select", "date", "time", "number", "email"] as const)
    assert.equal(fieldProblem(f({ kind }), v({ x: "" })), "", kind);
});

test("a required select asks for a choice; a required tick box asks for a tick", () => {
  assert.equal(fieldProblem(f({ kind: "select", label: "Branch", required: true }), v({ x: "" })), "Choose an option for “Branch”.");
  assert.equal(fieldProblem(f({ kind: "select", label: "Branch", required: true }), v({ x: "b1" })), "");
  assert.equal(fieldProblem(f({ kind: "check", label: "I agree", required: true }), v({ x: false })), "Tick “I agree” to continue.");
  assert.equal(fieldProblem(f({ kind: "check", label: "I agree", required: true }), v({ x: true })), "");
  assert.equal(fieldProblem(f({ kind: "check", label: "Cancelled" }), v({ x: false })), "");
});

test("numbers must be numbers inside their stated range; the label's bracketed hint is left out of the sentence", () => {
  const n = f({ kind: "number", label: "Duration (minutes)", required: true, min: 1, max: 1440 });
  assert.equal(fieldProblem(n, v({ x: "abc" })), "Duration must be a number.");
  assert.equal(fieldProblem(n, v({ x: "0" })), "Duration must be at least 1.");
  assert.equal(fieldProblem(n, v({ x: "1441" })), "Duration must be at most 1440.");
  assert.equal(fieldProblem(n, v({ x: "60" })), "");
  assert.equal(fieldProblem(f({ kind: "number", min: 0 }), v({ x: "Infinity" })), "Event title must be a number.");
});

test("an email must look like an address when it is given; the server still decides what is accepted", () => {
  const e = f({ kind: "email", label: "Contact email" });
  assert.equal(fieldProblem(e, v({ x: "not-an-address" })), "Enter a valid email address for “Contact email”.");
  assert.equal(fieldProblem(e, v({ x: "a b@c.d" })), "Enter a valid email address for “Contact email”.");
  assert.equal(fieldProblem(e, v({ x: "coach@academy.example" })), "");
  assert.equal(fieldProblem(e, v({ x: "" })), "");
});

test("a group of tick boxes has no client rule of its own", () => {
  assert.equal(fieldProblem(f({ kind: "multi", required: true }), v({ x: [] })), "");
});

// ---- Wave 3: what a failed request says --------------------------------------------------------------------
test("a request that never reaches the server reads as a connection problem, not as the browser's own wording", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => sendRequest("/api/academy", {}),
      (e: Error & { code?: string }) => e.message === NETWORK_MESSAGE && e.code === "NETWORK" && !/Failed to fetch/.test(e.message),
    );
  } finally {
    globalThis.fetch = real;
  }
});

test("a reply that is not JSON reads as an unreadable reply with its status, and a JSON reply passes through untouched", async () => {
  await assert.rejects(
    () => readJson(new Response("<html>Bad gateway</html>", { status: 502 })),
    (e: Error & { code?: string; status?: number }) => e.code === "BAD_RESPONSE" && e.status === 502 && /status 502/.test(e.message) && !/Unexpected token/.test(e.message),
  );
  assert.deepEqual(await readJson(new Response(JSON.stringify({ error: "Nope", code: "X" }), { status: 422 })), { error: "Nope", code: "X" });
});

// ---- Waves 2 and 4: family sections ---------------------------------------------------------------------------
test("the family portal has four primary items and every section belongs to one of them", () => {
  assert.deepEqual([...PRIMARY_ITEMS], ["Home", "Schedule", "Messages", "More"]);
  for (const section of Object.keys(SECTION_SLUGS) as Section[]) assert.ok((PRIMARY_ITEMS as readonly string[]).includes(PRIMARY_OF[section]), section);
  assert.deepEqual(
    Object.fromEntries((Object.keys(PRIMARY_OF) as Section[]).map((s) => [s, PRIMARY_OF[s]])),
    { Home: "Home", Schedule: "Schedule", Reports: "Schedule", Messages: "Messages", More: "More", Fees: "More", Nutrition: "More", "Access & preferences": "More" },
  );
});

test("a section's address round-trips, and anything unknown opens Home", () => {
  for (const section of Object.keys(SECTION_SLUGS) as Section[]) {
    const url = urlOfSection(section);
    const slug = new URL(url, "http://x").searchParams.get("section");
    assert.equal(sectionOfSlug(slug), section, section);
  }
  assert.equal(urlOfSection("Home"), "/family");
  assert.equal(urlOfSection("Messages"), "/family?section=messages");
  for (const bad of [null, "", "bogus", "HOME", "__proto__", "constructor", "../settings", "reports ", "<script>"]) assert.equal(sectionOfSlug(bad), "Home", String(bad));
  assert.equal(isSection("Reports"), true);
  for (const bad of ["Video", "constructor", "__proto__", "toString", ""]) assert.equal(isSection(bad), false, bad);
});

// ---- Wave 4: first-run checklist --------------------------------------------------------------------------------
const academy = (over: Record<string, unknown>) =>
  ({
    actor: { id: "a", name: "A", role: "OWNER" },
    permissions: { ops: true, finance: true, coaching: true, professional: false, family: false, owner: true },
    batches: [],
    members: [{ id: "a", active: true }],
    players: [],
    sessions: [],
    events: [],
    ...over,
  }) as unknown as AcademyPayload;

test("a new academy is offered the four first steps, each opening the module that holds it", () => {
  const steps = setupSteps(academy({}));
  assert.deepEqual(steps.map((s) => s.key), ["batch", "team", "players", "session"]);
  assert.ok(steps.every((s) => !s.done));
  assert.deepEqual(steps.map((s) => [s.module, s.focus]), [["Settings", "group:Sessions"], ["Settings", "group:Team"], ["Players", undefined], ["Training", "new-session"]]);
});

test("each step turns done from the records the academy already has, and the whole list disappears when all are done", () => {
  const some = setupSteps(academy({ batches: [{ id: "b" }], players: [{ id: "p" }] }));
  assert.deepEqual(some.map((s) => [s.key, s.done]), [["batch", true], ["team", false], ["players", true], ["session", false]]);
  // a session OR a calendar event counts; an inactive member does not count as a team member
  assert.equal(setupSteps(academy({ events: [{ id: "e" }] })).find((s) => s.key === "session")?.done, true);
  assert.equal(setupSteps(academy({ members: [{ id: "a", active: true }, { id: "b", active: false }] })).find((s) => s.key === "team")?.done, false);
  const all = academy({ batches: [{}], players: [{}], sessions: [{}], members: [{ active: true }, { active: true }] });
  assert.deepEqual(setupSteps(all), []);
});

test("a person is only offered the steps they may do", () => {
  const coach = academy({
    actor: { id: "c", name: "C", role: "COACH" },
    permissions: { ops: false, finance: false, coaching: true, professional: false, family: false, owner: false },
  });
  assert.deepEqual(setupSteps(coach).map((s) => s.key), ["session"]);
  const finance = academy({
    actor: { id: "f", name: "F", role: "FINANCE" },
    permissions: { ops: false, finance: true, coaching: false, professional: false, family: false, owner: false },
  });
  assert.deepEqual(setupSteps(finance), []);
});

// ---- Wave 2: the menu is a convenience, never the protection ---------------------------------------------------
test("for every staff role the menu lists only modules the role can open, and hiding a module never closes it", () => {
  for (const role of STAFF_ROLES) {
    const menu = menuModulesForRole(role);
    for (const slug of menu) assert.ok(canOpen(role, slug), `${role} is offered ${slug} but cannot open it`);
    assert.deepEqual(menu, modulesForRole(role).filter((s) => !HIDDEN_FROM_MENU.includes(s)), role);
    for (const slug of HIDDEN_FROM_MENU) assert.equal(canOpen(role, slug), modulesForRole(role).includes(slug), `${role} ${slug}: hidden is not the same as refused`);
  }
  assert.deepEqual(menuModulesForRole("OWNER"), ["overview", "admissions", "players", "calendar", "training", "reports", "nutrition", "fees", "communications", "settings"]);
  assert.deepEqual(menuModulesForRole("FINANCE"), ["overview", "fees"]);
  assert.deepEqual(menuModulesForRole("GUARDIAN"), []);
});
