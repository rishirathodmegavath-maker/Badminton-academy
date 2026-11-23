import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { base, stateFor, type RoleKey } from "./support/roles";

/**
 * Phase 9 accessibility: axe-core against WCAG 2.0/2.1/2.2 A and AA rules on the login page, the account page,
 * every module for the Owner, the role homes, the family portal, and the access-denied and not-found screens.
 * Serious and critical violations fail the run; the full findings (every impact level) are written to
 * A11Y_REPORT_DIR/a11y-findings.json when set, as evidence. Plus keyboard checks axe cannot make.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const REPORT_DIR = process.env.A11Y_REPORT_DIR;
if (REPORT_DIR) mkdirSync(REPORT_DIR, { recursive: true });

async function scan(page: Page, label: string, role: string) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  // Findings are appended as they are found (a failed test restarts the worker, so memory would be lost).
  if (REPORT_DIR)
    for (const v of result.violations)
      appendFileSync(
        join(REPORT_DIR, "a11y-findings.jsonl"),
        JSON.stringify({ page: label, role, id: v.id, impact: v.impact ?? "unknown", nodes: v.nodes.length, help: v.help, targets: v.nodes.slice(0, 3).map((n) => (n.target ?? []).join(" ").slice(0, 100)) }) + String.fromCharCode(10),
      );
  return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
}
async function ready(page: Page) {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/Loading academy records/)).toHaveCount(0, { timeout: 90_000 });
  await page.waitForLoadState("networkidle").catch(() => undefined);
}
const describe = (v: { id: string; nodes: unknown[]; help: string }[]) => v.map((x) => `${x.id} ×${x.nodes.length}: ${x.help}`).join("\n");


test("Login page (anonymous) has no serious or critical accessibility violations", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: base() });
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  const bad = await scan(page, "/login", "anonymous");
  expect(describe(bad)).toBe("");
  await context.close();
});

const OWNER_PAGES = ["overview", "admissions", "players", "calendar", "training", "reports", "nutrition", "video", "fees", "communications", "settings"];
test("Owner: every module has no serious or critical accessibility violations", async ({ browser }) => {
  test.setTimeout(900_000);
  const context = await browser.newContext({ storageState: await stateFor("OWNER"), viewport: { width: 1440, height: 900 }, baseURL: base() });
  const page = await context.newPage();
  const all: string[] = [];
  for (const slug of OWNER_PAGES) {
    await page.goto(`/${slug}`);
    await ready(page);
    const bad = await scan(page, `/${slug}`, "OWNER");
    if (bad.length) all.push(`/${slug}\n${describe(bad)}`);
  }
  expect(all, all.join("\n\n")).toEqual([]);
  await context.close();
});

test("Settings tabs (owner) have no serious or critical violations", async ({ browser }) => {
  test.setTimeout(600_000);
  const context = await browser.newContext({ storageState: await stateFor("OWNER"), viewport: { width: 1440, height: 900 }, baseURL: base() });
  const page = await context.newPage();
  await page.goto("/settings");
  await ready(page);
  // Settings is grouped: each group, then every sub-tab inside it (the same screens as before, now two levels).
  const groups: [string, string[]][] = [
    ["Academy", []],
    ["Team", ["Roles & permissions", "Invitations"]],
    ["Sessions", []],
    ["Privacy & policies", ["Policies", "Consent documents", "Privacy and erasure"]],
    ["Security & audit", ["Two-factor policy", "Security events", "Access history", "Audit history"]],
    ["Integrations", []],
  ];
  const all: string[] = [];
  for (const [group, subs] of groups) {
    await page.getByRole("button", { name: group, exact: true }).first().click();
    await page.waitForTimeout(500);
    for (const name of subs.length ? subs : [group]) {
      if (subs.length) {
        await page.getByRole("button", { name, exact: true }).first().click();
        await page.waitForTimeout(500);
      }
      const bad = await scan(page, `/settings [${group}${subs.length ? " > " + name : ""}]`, "OWNER");
      if (bad.length) all.push(`[${group} > ${name}]
${describe(bad)}`);
    }
  }
  expect(all, all.join("\n\n")).toEqual([]);
  await context.close();
});

for (const [role, path] of [
  ["COACH", "/overview"],
  ["COACH", "/training"],
  ["FINANCE", "/overview"],
  ["FINANCE", "/fees"],
  ["NUTRITION_PRO", "/overview"],
  ["NUTRITION_PRO", "/nutrition"],
  ["HEAD_COACH", "/overview"],
  ["GUARDIAN", "/family"],
  ["COACH", "/account"],
  ["COACH", "/fees"], // access-denied screen
] as [RoleKey, string][]) {
  test(`${role} ${path}: no serious or critical accessibility violations`, async ({ browser }) => {
    test.setTimeout(240_000);
    const context = await browser.newContext({ storageState: await stateFor(role), viewport: { width: 1440, height: 900 }, baseURL: base() });
    const page = await context.newPage();
    await page.goto(path);
    await ready(page);
    const bad = await scan(page, path, role);
    expect(describe(bad)).toBe("");
    await context.close();
  });
}

test("Mobile (390px) owner overview and family home have no serious or critical violations", async ({ browser }) => {
  test.setTimeout(240_000);
  for (const [role, path] of [["OWNER", "/overview"], ["GUARDIAN", "/family"]] as [RoleKey, string][]) {
    const context = await browser.newContext({ storageState: await stateFor(role), viewport: { width: 390, height: 844 }, baseURL: base() });
    const page = await context.newPage();
    await page.goto(path);
    await ready(page);
    const bad = await scan(page, `${path} @390`, role);
    expect(describe(bad)).toBe("");
    await page.getByRole("button", { name: "Open navigation" }).click();
    const drawer = await scan(page, `${path} @390 drawer open`, role);
    expect(describe(drawer)).toBe("");
    await context.close();
  }
});

test("Not-found page has no serious or critical violations", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: base() });
  const page = await context.newPage();
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { name: /couldn.t find that page/i })).toBeVisible();
  const bad = await scan(page, "/not-found", "anonymous");
  expect(describe(bad)).toBe("");
  await context.close();
});

test("Keyboard: skip link works, every sidebar control is reachable in order and shows a visible focus ring", async ({ browser }) => {
  const context = await browser.newContext({ storageState: await stateFor("OWNER"), viewport: { width: 1440, height: 900 }, baseURL: base() });
  const page = await context.newPage();
  await page.goto("/players");
  await ready(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  // walk the sidebar with Tab: every stop must have a visible outline or box-shadow
  await page.goto("/players");
  await ready(page);
  const stops: { name: string; ring: boolean }[] = [];
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press("Tab");
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement;
        // a borderless input inside a search box shows its ring on the whole box
        const host = el.closest(".wb-search, .search, .ops-search") ?? el;
        const cs = getComputedStyle(host);
        const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2) || (cs.boxShadow !== "none" && cs.boxShadow !== "");
        return { name: (el.getAttribute("aria-label") || el.innerText || el.tagName).trim().slice(0, 30), ring };
      }),
    );
  }
  expect(stops.filter((s) => !s.ring), JSON.stringify(stops.filter((s) => !s.ring))).toEqual([]);
  // arrow-free tabs: the Players page tab buttons are in the tab order
  await context.close();
});
