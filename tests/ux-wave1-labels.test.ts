import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CHANNELS,
  ENVIRONMENT_NOTICE,
  channelLabel,
  formatDate,
  formatDateTime,
  label,
  sentence,
} from "../src/modules/academy/ui/labels";
import {
  HIDDEN_FROM_MENU,
  MODULES,
  MODULE_SUBTITLES,
  STAFF_ROLES,
  canOpen,
  menuModulesForRole,
  modulesForRole,
} from "../src/modules/academy/ui/navigation";

/**
 * UX Wave 1 (Badminton), presentation rules. The expected values are written out here, independently of the code:
 * sentence case (UX-D5), "Email" (UX-D10), dates as "21 Nov 2026" (UX-D17), no unbuilt feature in the menu (UX-D8).
 * Nothing here touches what is stored or sent; labels only change what a person reads.
 */

test("sentence case: stored values read as plain words", () => {
  assert.equal(sentence("PART_PAID"), "Part paid");
  assert.equal(sentence("NOT_MARKED"), "Not marked");
  assert.equal(sentence("ACTIVE"), "Active");
  assert.equal(sentence("Already fine"), "Already fine");
  assert.equal(sentence(""), "");
  assert.equal(sentence("  "), "");
});

test("labels: statuses, stages and channels use the agreed words", () => {
  const expected: Record<string, string> = {
    ACTIVE: "Active",
    PAUSED: "Paused",
    ARCHIVED: "Archived",
    ENQUIRY: "Enquiry",
    TRIAL: "Trial",
    WAITLIST: "Waitlist",
    ENROLLED: "Enrolled",
    CLOSED: "Closed",
    PENDING: "Pending",
    PART_PAID: "Part paid",
    OVERDUE: "Overdue",
    VOID: "Void",
    NOT_MARKED: "Not marked",
    PORTAL: "Portal",
    EMAIL: "Email",
    WHATSAPP: "WhatsApp",
    PRIVATE_PORTAL: "Private portal",
    READY_TO_SHARE: "Ready to share",
    AVAILABLE_IN_PORTAL: "Available in portal",
  };
  for (const [stored, shown] of Object.entries(expected)) assert.equal(label(stored), shown, stored);
  assert.deepEqual(CHANNELS.map(channelLabel), ["Portal", "Email", "WhatsApp"]);
  // WhatsApp keeps its capitalisation and email is one word in both apps.
  assert.ok(!CHANNELS.map(channelLabel).some((c) => /e-mail/i.test(c)));
});

test("dates: '21 Nov 2026' from a calendar date or an ISO timestamp, and anything else is left alone", () => {
  assert.equal(formatDate("2026-11-21"), "21 Nov 2026");
  assert.equal(formatDate("2026-01-05"), "5 Jan 2026");
  assert.equal(formatDate("2026-09-30T18:30:00.000Z"), "30 Sep 2026");
  assert.equal(formatDate("2026-12-31"), "31 Dec 2026");
  assert.equal(formatDate(""), "");
  assert.equal(formatDate(null), "");
  assert.equal(formatDate(undefined), "");
  assert.equal(formatDate("Unscheduled"), "Unscheduled");
  assert.equal(formatDate("2026-13-01"), "2026-13-01"); // not a month: shown as stored, never mangled
  assert.equal(formatDateTime("2026-11-21", "17:00"), "21 Nov 2026 · 17:00");
  assert.equal(formatDateTime("2026-11-21", ""), "21 Nov 2026");
  assert.equal(formatDateTime("2026-11-21"), "21 Nov 2026");
});

test("environment notice: one wording", () => {
  assert.equal(ENVIRONMENT_NOTICE, "Local pilot · fictional data");
});

test("menu: Video is hidden from the menu only; the module, its URL and who may open it are unchanged", () => {
  assert.deepEqual([...HIDDEN_FROM_MENU], ["video"]);
  assert.ok(MODULES.some((m) => m.slug === "video"), "the module still exists");
  for (const role of STAFF_ROLES) {
    const menu = menuModulesForRole(role);
    assert.ok(!menu.includes("video"), `${role}: video is not in the menu`);
    // The menu is exactly what the role may open, less the hidden module, in the same order.
    assert.deepEqual(menu, modulesForRole(role).filter((s) => s !== "video"), role);
    // Access is untouched: whoever could open Video before still can (and nobody else).
    assert.equal(canOpen(role, "video"), modulesForRole(role).includes("video"), role);
  }
  assert.equal(canOpen("OWNER", "video"), true);
});

test("menu order follows the approved staff model", () => {
  const order = menuModulesForRole("OWNER");
  assert.deepEqual(order, [
    "overview",
    "admissions",
    "players",
    "calendar",
    "training",
    "reports",
    "nutrition",
    "fees",
    "communications",
    "settings",
  ]);
});

test("page subtitles: one specific sentence per module, none reused, none the old placeholder", () => {
  assert.deepEqual(Object.keys(MODULE_SUBTITLES).sort(), MODULES.map((m) => m.slug).sort());
  const values = Object.values(MODULE_SUBTITLES);
  assert.equal(new Set(values).size, values.length, "no two modules share a subtitle");
  for (const text of values) {
    assert.ok(text.length > 10 && text.length < 90, text);
    assert.ok(!/connected workspace/i.test(text), text);
    assert.ok(/[.]$/.test(text), `${text} ends as a sentence`);
  }
});

/** Source gates: the old presentation must not come back in the workspace screens. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx$/.test(name)) out.push(path);
  }
  return out;
}
const workspaceScreens = [...sources("src/modules/academy/ui"), ...sources("src/modules/training/ui")];

test("source gate: no eyebrow or product name is typed in capitals in the workspace screens", () => {
  const offenders: string[] = [];
  for (const file of workspaceScreens) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:className="eyebrow">|eyebrow=|product=)\{?"?([^"<{}]+)/g)) {
      const value = m[1].trim();
      if (/[A-Z]{3,}/.test(value) && !/[a-z]/.test(value)) offenders.push(`${file}: ${value}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("source gate: the workspace screens spell Email (not E-mail), keep one environment wording and no Save record button", () => {
  const offenders: string[] = [];
  for (const file of workspaceScreens) {
    const text = readFileSync(file, "utf8");
    if (/"E-mail"|>E-mail</.test(text)) offenders.push(`${file}: E-mail`);
    if (/Local pilot, fictional|Local pilot · Fictional academy/.test(text)) offenders.push(`${file}: second environment wording`);
    if (/Save record/.test(text)) offenders.push(`${file}: Save record`);
    if (/in one connected workspace/.test(text)) offenders.push(`${file}: placeholder subtitle`);
  }
  assert.deepEqual(offenders, []);
});

test("source gate: no stylesheet forces capitals on workspace text, and status badges and shell labels are not re-cased", () => {
  const css = readFileSync("src/app/redesign.css", "utf8");
  assert.ok(!/text-transform:\s*uppercase/.test(css));
  // Labels arrive in sentence case; `capitalize` would turn "Part paid" into "Part Paid" and "Academy workspace" into "Academy Workspace".
  const recased = (file: string, selector: string) => {
    const text = readFileSync(file, "utf8");
    const at = text.indexOf(selector + " {");
    assert.ok(at >= 0, `${selector} exists in ${file}`);
    return /text-transform:\s*capitalize/.test(text.slice(at, text.indexOf("}", at)));
  };
  assert.equal(recased("src/app/operations.css", ".ops-status"), false);
  assert.equal(recased("src/app/globals.css", ".badge"), false);
  assert.equal(recased("src/app/globals.css", ".account small"), false);
  assert.equal(recased("src/app/shell.css", ".ax-account-panel small"), false);
  const shell = readFileSync("src/app/shell.css", "utf8");
  const small = shell.indexOf(".ax-account-text small {");
  assert.ok(small >= 0 && !/text-transform:\s*capitalize/.test(shell.slice(small, shell.indexOf("}", small))));
});

test("source gate: the UI font is Noto Sans and is served from the app itself", () => {
  const tokens = readFileSync("src/app/tokens.css", "utf8");
  assert.match(tokens, /--font:\s*"Noto Sans Variable"/);
  assert.match(tokens, /--heading:\s*var\(--font\)/);
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  assert.ok(!/dm-sans|manrope/i.test(layout), "the old font packages are no longer imported");
  for (const file of ["noto-sans-latin-wght-normal-v1.woff2", "noto-sans-latin-ext-wght-normal-v1.woff2", "noto-sans-devanagari-wght-normal-v1.woff2", "OFL.txt"])
    assert.ok(statSync(join("public/fonts", file)).size > 1000, file);
});
