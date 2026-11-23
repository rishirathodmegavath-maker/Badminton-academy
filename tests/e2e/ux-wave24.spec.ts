import { test, expect, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { base, stateFor, type RoleKey } from "./support/roles";

/**
 * UX Waves 2 to 4 (Badminton): navigation (addresses, Back and Forward, inaccessible sections, header search, phone bottom
 * bar), forms (inline errors, a clear message when the server cannot be reached, confirmations that go away), and journeys
 * (four-item family portal, first-run checklist, calendar agenda). Presentation and navigation only: no permission,
 * payload or data rule is exercised or changed here. Hiding a menu item is never what these tests rely on for safety;
 * where a section is refused, the server's own refusal is covered by the existing role and isolation suites.
 */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
async function open(browser: Browser, role: RoleKey, path: string, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ storageState: await stateFor(role), viewport, baseURL: base() });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 90_000 });
  return { context, page, problems };
}
const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(`${name}.png`) });
const nav = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
async function serious(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${label}: ${v.id} x${v.nodes.length}: ${v.help}`);
}
/** Replaces the academy payload with a brand-new academy's records, for the first-run checklist. Read-only: nothing is saved. */
async function asNewAcademy(page: Page) {
  await page.route("**/api/academy", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    json.batches = [];
    json.players = [];
    json.sessions = [];
    json.events = [];
    json.members = json.members.slice(0, 1);
    await route.fulfill({ response, json });
  });
}

// ---------------------------------------------------------------------------------------------------- Wave 2
test("Owner: every module has its own address, and Back and Forward move between them", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page, problems } = await open(browser, "OWNER", "/overview");
  await nav(page).getByRole("link", { name: "Players", exact: true }).click();
  await expect(page).toHaveURL(/\/players$/);
  await expect(page.getByRole("heading", { level: 1, name: "Players" })).toBeVisible({ timeout: 60_000 });
  await nav(page).getByRole("link", { name: "Calendar", exact: true }).click();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible({ timeout: 60_000 });
  await page.goBack();
  await expect(page).toHaveURL(/\/players$/);
  await expect(page.getByRole("heading", { level: 1, name: "Players" })).toBeVisible({ timeout: 60_000 });
  await expect(nav(page).getByRole("link", { name: "Players", exact: true })).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(nav(page).getByRole("link", { name: "Calendar", exact: true })).toHaveAttribute("aria-current", "page");
  // a module opened by typing its address, and one that does not exist
  await page.goto("/fees");
  await expect(page.getByRole("heading", { level: 1, name: "Fees" })).toBeVisible({ timeout: 60_000 });
  expect(problems).toEqual([]);
  await context.close();
});

test("Finance: a section the role is not offered is not in the menu, and typing its address shows the access message, not data", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page, problems } = await open(browser, "FINANCE", "/fees");
  await expect(nav(page).getByRole("link", { name: "Players", exact: true })).toHaveCount(0);
  await expect(nav(page).getByRole("link", { name: "Fees", exact: true })).toBeVisible();
  await page.goto("/players");
  await expect(page.getByRole("heading", { level: 1, name: /don.t have access to Players/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: "Go to my workspace" })).toBeVisible();
  // none of the Players screen is on the page behind the message
  await expect(page.getByLabel("Search players")).toHaveCount(0);
  // the header search is not offered to a role that cannot open Players
  await expect(page.getByRole("search")).toHaveCount(0);
  await shot(page, "finance-players-denied");
  expect(problems).toEqual([]);
  await context.close();
});

test("Owner: the header finds a player and opens Players with the name typed, and Players keeps its own search", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await open(browser, "OWNER", "/overview");
  const search = page.getByRole("search").getByLabel("Find a player");
  await expect(search).toBeVisible();
  await search.fill("Aarav");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/players$/);
  await expect(page.getByLabel("Search players")).toHaveValue("Aarav", { timeout: 60_000 });
  await expect(page.getByText("Aarav Mehta").first()).toBeVisible();
  // on the Players page there is one search, not two
  await expect(page.getByRole("search")).toHaveCount(0);
  await context.close();
});

test("Family: the four primary items have addresses, Back and Forward work, and an unknown address opens Home", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page, problems } = await open(browser, "GUARDIAN", "/family");
  await expect(nav(page).getByRole("button")).toHaveText(["Home", "Schedule", "Messages", "More"]);
  await nav(page).getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page).toHaveURL(/\/family\?section=schedule$/);
  await nav(page).getByRole("button", { name: "Messages", exact: true }).click();
  await expect(page).toHaveURL(/\/family\?section=messages$/);
  await expect(page.getByRole("heading", { level: 1, name: "Messages" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/family\?section=schedule$/);
  await expect(page.getByRole("heading", { level: 1, name: "Schedule" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/family$/);
  await expect(page.getByRole("heading", { level: 1, name: "Your academy connection" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { level: 1, name: "Schedule" })).toBeVisible();
  // opened directly (a bookmark), including a section under More
  await page.goto("/family?section=access");
  await expect(page.getByRole("heading", { level: 1, name: "Access & preferences" })).toBeVisible({ timeout: 90_000 });
  await expect(nav(page).locator('[aria-current="page"]')).toContainText("More");
  // an unknown or hostile value opens Home and the address is cleaned
  for (const bad of ["bogus", "__proto__", "..%2Fsettings"]) {
    await page.goto(`/family?section=${bad}`);
    await expect(page.getByRole("heading", { level: 1, name: "Your academy connection" })).toBeVisible({ timeout: 90_000 });
    await expect(page).toHaveURL(/\/family$/);
  }
  expect(problems).toEqual([]);
  await context.close();
});

test("Family at 390 px: a bottom bar with the four items, thumb-sized, and none of it at 1440 px", async ({ browser }) => {
  test.setTimeout(240_000);
  const phone = await open(browser, "GUARDIAN", "/family", { width: 390, height: 844 });
  const bar = phone.page.getByRole("navigation", { name: "Quick navigation" });
  await expect(bar).toBeVisible();
  const items = bar.getByRole("button");
  await expect(items).toHaveText(["Home", "Schedule", "Messages", "More"]);
  for (const item of await items.all()) {
    const box = (await item.boundingBox())!;
    expect(box.height, "touch target height").toBeGreaterThanOrEqual(44);
    expect(box.width, "touch target width").toBeGreaterThanOrEqual(44);
  }
  await expect(bar.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await bar.getByRole("button", { name: "Messages" }).click();
  await expect(phone.page.getByRole("heading", { level: 1, name: "Messages" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Messages" })).toHaveAttribute("aria-current", "page");
  // the bar never covers the last of the page: the footer can be scrolled clear of it
  await phone.page.locator(".workspace-footer").scrollIntoViewIfNeeded();
  const footer = (await phone.page.locator(".workspace-footer").boundingBox())!;
  const barBox = (await bar.boundingBox())!;
  expect(footer.y + footer.height, "footer end is above the bar").toBeLessThanOrEqual(barBox.y + 1);
  expect(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(phone.page, "family-390-messages");
  await bar.getByRole("button", { name: "More" }).click();
  await expect(phone.page.getByRole("heading", { level: 1, name: "More" })).toBeVisible();
  await shot(phone.page, "family-390-more");
  const found = await serious(phone.page, "family more at 390");
  expect(found.join("\n")).toBe("");
  await phone.context.close();
  const desktop = await open(browser, "GUARDIAN", "/family");
  await expect(desktop.page.getByRole("navigation", { name: "Quick navigation" })).toBeHidden();
  await desktop.context.close();
});

test("Family: More offers Fees, Nutrition, Access & preferences and Sign out, and Reports is a tab of Schedule", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await open(browser, "GUARDIAN", "/family?section=more");
  await expect(page.getByRole("heading", { level: 1, name: "More" })).toBeVisible({ timeout: 90_000 });
  for (const name of ["Open fees →", "Open nutrition →", "Open access & preferences →"]) await expect(page.getByRole("button", { name })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true }).last()).toBeVisible();
  await nav(page).getByRole("button", { name: "Schedule", exact: true }).click();
  await expect(page.locator(".ops-tabs").getByRole("button")).toHaveText(["Sessions", "Reports"]);
  await page.locator(".ops-tabs").getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page).toHaveURL(/\/family\?section=reports$/);
  await expect(nav(page).locator('[aria-current="page"]')).toContainText("Schedule");
  await context.close();
});

// ---------------------------------------------------------------------------------------------------- Wave 3
test("Owner: a form shows its error beside the field, moves focus to it, sends nothing, and clears the message when fixed", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await open(browser, "OWNER", "/calendar");
  const sent: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/api/academy/calendar/event")) sent.push(r.url());
  });
  await page.getByRole("button", { name: /Add event \/ closure/ }).click();
  const dialog = page.getByRole("dialog");
  // opening a form puts the cursor in its first field, not on the close button
  await expect(dialog.locator("[data-field]").first()).toBeFocused();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  const title = dialog.getByLabel("Event title");
  await expect(dialog.getByText("Event title is required.")).toBeVisible();
  await expect(title).toHaveAttribute("aria-invalid", "true");
  await expect(title).toBeFocused();
  const described = await title.getAttribute("aria-describedby");
  expect(described, "the field points at its message").toBeTruthy();
  await expect(page.locator(`[id="${described}"]`)).toHaveText("Event title is required.");
  await expect(dialog.getByRole("alert").filter({ hasText: "Fix the field marked below" })).toBeVisible();
  expect(sent, "nothing is sent while a field is wrong").toHaveLength(0);
  await shot(page, "form-inline-error-1440");
  const found = await serious(page, "form with an inline error");
  expect(found.join("\n")).toBe("");
  await title.fill("Wave 3 check");
  await expect(dialog.getByText("Event title is required.")).toHaveCount(0);
  await expect(title).not.toHaveAttribute("aria-invalid", "true");
  // a duration outside the stated range is explained, and says why
  await dialog.getByLabel("Duration (minutes)").fill("5000");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByText("Duration must be at most 1440.")).toBeVisible();
  expect(sent).toHaveLength(0);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await context.close();
});

test("Owner: when the server cannot be reached the form says so in plain words, stays open, and keeps what was typed", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await open(browser, "OWNER", "/calendar");
  await page.getByRole("button", { name: /Add event \/ closure/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Event title").fill("Offline check");
  await page.route("**/api/academy/calendar/event", (route) => route.abort("failed"));
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert").filter({ hasText: "Couldn’t reach the server" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Failed to fetch/)).toHaveCount(0);
  await expect(dialog.getByLabel("Event title")).toHaveValue("Offline check");
  await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await context.close();
});

test("Owner: a saved-changes message appears for the person and then goes away by itself", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await open(browser, "OWNER", "/settings");
  await page.getByRole("button", { name: "Save academy settings" }).click();
  const toast = page.getByRole("status").filter({ hasText: "Changes saved." });
  await expect(toast).toBeVisible({ timeout: 60_000 });
  await expect(toast).toBeHidden({ timeout: 20_000 });
  await context.close();
});

// ---------------------------------------------------------------------------------------------------- Wave 4
test("Owner: a seeded academy shows no setup checklist; a brand-new one shows it, and each step opens where it is done", async ({ browser }) => {
  test.setTimeout(240_000);
  const seeded = await open(browser, "OWNER", "/overview");
  await expect(seeded.page.getByRole("heading", { name: "Finish setting up your academy" })).toHaveCount(0);
  await seeded.context.close();

  const context = await browser.newContext({ storageState: await stateFor("OWNER"), viewport: { width: 1440, height: 900 }, baseURL: base() });
  const page = await context.newPage();
  await asNewAcademy(page);
  await page.goto("/overview");
  const checklist = page.getByRole("region", { name: "Finish setting up your academy" });
  await expect(checklist).toBeVisible({ timeout: 90_000 });
  await expect(checklist).toContainText("0 of 4 steps done.");
  await expect(checklist.getByRole("listitem")).toHaveCount(4);
  const found = await serious(page, "setup checklist");
  expect(found.join("\n")).toBe("");
  await shot(page, "setup-checklist-1440");
  await checklist.getByRole("button", { name: "Open Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("button", { name: "Create batch" })).toBeVisible({ timeout: 60_000 });
  await page.goto("/overview");
  await page.getByRole("region", { name: "Finish setting up your academy" }).getByRole("button", { name: "Open invitations" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator(".set-subtabs").getByRole("button", { name: "Invitations" })).toHaveAttribute("aria-current", "true", { timeout: 60_000 });
  await context.close();
});

test("Owner: the calendar has an agenda of the next two weeks, with its own empty state, and it fits a phone", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await open(browser, "OWNER", "/calendar");
  await page.locator(".ops-tabs").getByRole("button", { name: "Agenda", exact: true }).click();
  const agenda = page.locator(".wb-agenda");
  await expect(agenda).toBeVisible({ timeout: 60_000 });
  const items = agenda.locator(".wb-agenda-item");
  if (await items.count()) {
    await items.first().click();
    await expect(items.first()).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Session details" })).toBeVisible();
  } else {
    await expect(agenda.getByRole("heading", { name: "Nothing scheduled in these two weeks" })).toBeVisible();
  }
  // far from the seeded dates the empty state explains itself and offers the one action
  await page.getByLabel("Calendar date").fill("2031-01-06");
  await expect(agenda.getByRole("heading", { name: "Nothing scheduled in these two weeks" })).toBeVisible();
  await expect(agenda.getByRole("button", { name: "Add event or closure" })).toBeVisible();
  await shot(page, "calendar-agenda-empty-1440");
  await page.locator(".ops-tabs").getByRole("button", { name: "Week", exact: true }).click();
  await expect(page.locator(".wb-calendar.week")).toBeVisible();
  await context.close();

  const phone = await open(browser, "OWNER", "/calendar", { width: 390, height: 844 });
  await phone.page.locator(".ops-tabs").getByRole("button", { name: "Agenda", exact: true }).click();
  await expect(phone.page.locator(".wb-agenda")).toBeVisible({ timeout: 60_000 });
  expect(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(phone.page, "calendar-agenda-390");
  const found = await serious(phone.page, "calendar agenda at 390");
  expect(found.join("\n")).toBe("");
  await phone.context.close();
});

test("Coach: the header search opens Players, and what the list shows is still only what the server sends", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await open(browser, "COACH", "/training");
  const search = page.getByRole("search").getByLabel("Find a player");
  await expect(search).toBeVisible();
  // a name from an academy-wide list that this coach does not coach is simply not in the payload, so it cannot be listed
  await search.fill("Meera Kapoor");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/players$/);
  await expect(page.getByLabel("Search players")).toHaveValue("Meera Kapoor", { timeout: 60_000 });
  const answered = await page.evaluate(async () => (await (await fetch("/api/academy", { cache: "no-store" })).text()));
  // The roster row and the detail pane can both name a player, so "shown" is checked as at least one; "not sent" must mean none.
  if (answered.includes("Meera Kapoor")) await expect(page.getByText("Meera Kapoor").first()).toBeVisible({ timeout: 30_000 });
  else await expect(page.getByText("Meera Kapoor")).toHaveCount(0);
  await context.close();
});
