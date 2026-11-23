import { test, expect, type Browser } from "@playwright/test";
import { base, stateFor, type RoleKey } from "./support/roles";

/**
 * UX Wave 1 (Badminton): what a person reads on screen. Words, case, dates, stray controls and the menu. Presentation
 * only: no permission, payload or data rule is exercised or changed here. Each check is one the Wave 0 audit recorded
 * as failing (C-2, EV-16, N-3, P-1, T-2, X-1, X-2, X-6, UX-D8) and would fail again if the old behaviour came back.
 */
async function open(browser: Browser, role: RoleKey, path: string, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ storageState: await stateFor(role), viewport, baseURL: base() });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
  return { context, page, problems };
}
const RAW = /^[A-Z][A-Z_]{3,}$/;
/** Evidence: a screenshot kept in the run's output folder (never compared, never an assertion). */
const shot = (page: import("@playwright/test").Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });

test("Owner: every module has its own one-line subtitle (the old shared sentence is gone)", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page, problems } = await open(browser, "OWNER", "/overview");
  // The Overview has its own greeting header (the shared heading is hidden there), so it is not in this list.
  const paths = ["/admissions", "/players", "/calendar", "/training", "/reports", "/nutrition", "/fees", "/communications", "/settings"];
  const seen = new Map<string, string>();
  for (const path of paths) {
    await page.goto(path);
    const heading = page.locator(".page-heading").first();
    await expect(heading.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 60_000 });
    const subtitle = (await heading.locator("p").first().innerText()).trim();
    expect(subtitle.length, `${path} subtitle`).toBeGreaterThan(10);
    expect(subtitle, `${path} must not show the old shared sentence`).not.toMatch(/in one connected workspace/);
    expect(seen.get(subtitle), `${path} repeats the subtitle of ${seen.get(subtitle)}`).toBeUndefined();
    seen.set(subtitle, path);
    // Sentence case: the eyebrow above the title is not typed in capitals.
    const eyebrow = heading.locator(".eyebrow");
    if (await eyebrow.count()) expect((await eyebrow.first().innerText()).trim(), `${path} eyebrow`).not.toMatch(/^[^a-z]*[A-Z]{3,}[^a-z]*$/);
  }
  expect(seen.size).toBe(paths.length);
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
  expect(await page.getByText("in one connected workspace").count()).toBe(0);
  expect(problems).toEqual([]);
  await context.close();
});

test("Owner: the menu offers no unbuilt Video entry and shows at most one environment notice", async ({ browser }) => {
  const { context, page } = await open(browser, "OWNER", "/overview");
  await expect(page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: /Video/ })).toHaveCount(0);
  await expect(page.getByText("AI soon")).toHaveCount(0);
  expect(await page.getByText(/Local pilot/).count()).toBeLessThanOrEqual(1);
  // The signed-in role under the name is a word, not a raw stored value, and not re-cased by a stylesheet.
  await expect(page.locator(".ax-account-text small").first()).toHaveText(/^[A-Z][a-z]+( [a-z]+)* · Account security$/);
  await context.close();
});

test("Owner, Fees: the Outstanding only control is a labelled filter below the tabs, and statuses read as words", async ({ browser }) => {
  const { context, page } = await open(browser, "OWNER", "/fees");
  const tab = page.getByRole("button", { name: "Invoices", exact: true }).first();
  await expect(tab).toBeVisible();
  const box = page.getByRole("checkbox", { name: "Outstanding only" });
  await expect(box).toBeVisible();
  const tabBox = (await tab.boundingBox())!;
  const checkBox = (await box.boundingBox())!;
  // Not the stray control above the tab row (EV-16): it sits under the tabs, in the filter row, and is checkbox sized.
  expect(checkBox.y).toBeGreaterThan(tabBox.y + tabBox.height - 1);
  expect(checkBox.width).toBeLessThanOrEqual(24);
  expect(checkBox.height).toBeLessThanOrEqual(24);
  const statusOptions = page.getByLabel("Invoice status filter").locator("option");
  await expect(statusOptions).toHaveText(["All statuses", "Pending", "Part paid", "Paid", "Overdue", "Void"]);
  for (const text of await statusOptions.allInnerTexts()) expect(text).not.toMatch(RAW);
  await shot(page, "fees-1440");
  await context.close();
});

test("Owner, Admissions and Players: stage tabs and status filters are sentence case words", async ({ browser }) => {
  const { context, page } = await open(browser, "OWNER", "/admissions");
  // Retrying assertion: the stage tabs appear once the academy records have loaded.
  await expect(page.locator(".ops-tabs").first().locator("button")).toHaveText(["All", "Follow-up due", "Enquiry", "Trial", "Waitlist", "Enrolled", "Closed"], { timeout: 60_000 });
  // A stage tab still filters by the stored value.
  await page.locator(".ops-tabs").getByRole("button", { name: "Enquiry", exact: true }).click();
  await expect(page.locator(".ops-tabs").getByRole("button", { name: "Enquiry", exact: true })).toHaveAttribute("aria-current", "true");
  await page.goto("/players");
  await expect(page.getByLabel("Player status filter")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Player status filter").locator("option")).toHaveText(["All statuses", "Active", "Paused", "Archived"]);
  await shot(page, "players-1440");
  await context.close();
});

test("Owner, Communications: channels read Portal, Email and WhatsApp, and every control is checkbox sized", async ({ browser }) => {
  const { context, page } = await open(browser, "OWNER", "/communications");
  for (const name of [/^Portal/, /^Email/, /^WhatsApp/]) {
    const box = page.getByRole("checkbox", { name });
    await expect(box.first()).toBeVisible({ timeout: 60_000 });
    const b = (await box.first().boundingBox())!;
    expect(b.width).toBeLessThanOrEqual(24);
    expect(b.height).toBeLessThanOrEqual(24);
  }
  const channelTabs = page.locator(".ops-tabs").filter({ has: page.getByRole("button", { name: "WhatsApp", exact: true }) }).locator("button");
  await expect(channelTabs).toHaveText(["Portal", "Email", "WhatsApp"]);
  await shot(page, "communications-1440");
  await context.close();
});

test("Guardian: dates read like 21 Nov 2026, never year-first, and the Video tab is not offered", async ({ browser }) => {
  const { context, page } = await open(browser, "GUARDIAN", "/family");
  const menu = page.getByRole("navigation", { name: "Main navigation" });
  await expect(menu.getByRole("button", { name: /Video/ })).toHaveCount(0);
  await menu.getByRole("button", { name: "Schedule" }).click();
  const main = page.locator("main");
  await expect(main).toBeVisible();
  expect(await main.innerText()).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  await context.close();
});

test("Owner at 390 px: the main modules do not scroll sideways (Noto Sans and the new labels fit), screenshots kept", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await open(browser, "OWNER", "/overview", { width: 390, height: 844 });
  for (const path of ["/overview", "/admissions", "/players", "/calendar", "/reports", "/fees", "/communications", "/settings"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
    // Measure the loaded module, never the loading skeleton.
    await expect(page.locator(".ax-skeleton")).toHaveCount(0, { timeout: 60_000 });
    await expect(page.locator(".reference-view").first()).toBeVisible({ timeout: 60_000 });
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(widths.scroll, `${path} scrollWidth at 390 px`).toBeLessThanOrEqual(widths.inner);
    await shot(page, `mobile-${path.slice(1)}-390`);
  }
  await context.close();
});
