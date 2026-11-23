import { test, expect, request, type Page } from "@playwright/test";
import { apiFor, base, stateFor, type RoleKey } from "./support/roles";

/**
 * Phase 9: URL navigation and role-aware navigation, for every staff role. The expected tables below are written
 * out independently of src/modules/academy/ui/navigation.ts on purpose, so a drift between what the code offers
 * and what each role is meant to see fails here. Nothing is trusted to the UI alone: direct API calls follow.
 */
// "Video & AI Analysis" is a module (and a URL) but is not offered in the menu (UX-D8); see the test for /video below.
const ALL = ["Overview", "Admissions", "Players", "Calendar", "Training", "Reports", "Nutrition", "Fees", "Communications", "Settings"];
const EXPECT: Record<string, { items: string[]; landing: string; forbidden: string[] }> = {
  OWNER: { items: ALL, landing: "/overview", forbidden: [] },
  ADMIN: { items: ALL, landing: "/overview", forbidden: [] },
  HEAD_COACH: { items: ALL.filter((i) => i !== "Fees"), landing: "/overview", forbidden: ["/fees"] },
  COACH: {
    items: ["Overview", "Players", "Calendar", "Training", "Reports", "Nutrition", "Communications"],
    landing: "/training",
    forbidden: ["/fees", "/admissions", "/settings"],
  },
  FINANCE: { items: ["Overview", "Fees"], landing: "/fees", forbidden: ["/training", "/players", "/settings"] },
  NUTRITION_PRO: { items: ["Overview", "Nutrition"], landing: "/nutrition", forbidden: ["/fees", "/players", "/training"] },
};
const SLUG: Record<string, string> = {
  Overview: "overview",
  Admissions: "admissions",
  Players: "players",
  Calendar: "calendar",
  Training: "training",
  Reports: "reports",
  Nutrition: "nutrition",
  "Video & AI Analysis": "video",
  Fees: "fees",
  Communications: "communications",
  Settings: "settings",
};

async function openRole(browser: import("@playwright/test").Browser, role: RoleKey, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ storageState: await stateFor(role), viewport, baseURL: base() });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith("/api/") && r.status() >= 400) problems.push(`${r.status()} ${url.pathname}`);
  });
  return { context, page, problems };
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });

for (const [role, spec] of Object.entries(EXPECT)) {
  test(`${role}: lands on ${spec.landing}, is offered exactly its modules, and every module opens without a server error`, async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page, problems } = await openRole(browser, role as RoleKey);
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`${spec.landing}$`), { timeout: 60_000 });
    await expect(nav(page).getByRole("link")).toHaveCount(spec.items.length, { timeout: 60_000 });
    expect(await nav(page).getByRole("link").allInnerTexts().then((t) => t.map((x) => x.trim()))).toEqual(spec.items);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
    for (const label of spec.items) {
      await nav(page).getByRole("link", { name: label, exact: false }).first().click();
      await expect(page).toHaveURL(new RegExp(`/${SLUG[label]}$`));
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
      await expect(nav(page).locator('[aria-current="page"]')).toContainText(label.split(" ")[0]);
      await expect(page.locator(".error[role='alert']")).toHaveCount(0);
    }
    for (const path of spec.forbidden) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: /don.t have access/i })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("link", { name: "Go to my workspace" })).toBeVisible();
      // the forbidden module is not in the sidebar either
      await expect(nav(page).locator(`a[href="${path}"]`)).toHaveCount(0);
    }
    expect(problems.filter((p) => !p.includes("/api/academy/media"))).toEqual([]);
    await context.close();
  });
}

test("URLs: back, forward, reload and deep links keep the page", async ({ browser }) => {
  const { context, page, problems } = await openRole(browser, "OWNER");
  await page.goto("/calendar");
  await expect(page).toHaveURL(/\/calendar$/);
  await expect(page).toHaveTitle(/Calendar · Sportozen/);
  await nav(page).getByRole("link", { name: "Players" }).click();
  await expect(page).toHaveURL(/\/players$/);
  await expect(page).toHaveTitle(/Players · Sportozen/);
  await nav(page).getByRole("link", { name: "Fees" }).click();
  await expect(page).toHaveURL(/\/fees$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/players$/);
  await expect(page.getByRole("heading", { level: 1 }).first()).toContainText("Players");
  await page.goForward();
  await expect(page).toHaveURL(/\/fees$/);
  await page.reload();
  await expect(page).toHaveURL(/\/fees$/);
  await expect(page.getByRole("heading", { level: 1 }).first()).toContainText("Fees");
  // an unknown address is a real 404 page, not the workspace
  const missing = await page.goto("/no-such-page");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: /couldn.t find that page/i })).toBeVisible();
  expect(problems).toEqual([]);
  await context.close();
});

test("Anonymous visitors to a module URL are sent to sign in", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: base() });
  const page = await context.newPage();
  await page.goto("/players");
  await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
  await context.close();
});

test("Sidebar collapses and the choice survives a reload; the academy monogram uses the academy name", async ({ browser }) => {
  const { context, page } = await openRole(browser, "OWNER");
  await page.goto("/overview");
  const toggle = page.getByRole("button", { name: /Collapse sidebar/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".ax-monogram")).not.toHaveText("G"); // no hard-coded G: initials of the academy name
  await toggle.click();
  await expect(page.locator(".ax-shell")).toHaveAttribute("data-collapsed", "true");
  await expect(nav(page).getByRole("link", { name: "Players" })).toBeVisible(); // still has an accessible name
  await page.reload();
  await expect(page.locator(".ax-shell")).toHaveAttribute("data-collapsed", "true");
  await page.getByRole("button", { name: /Expand sidebar/ }).click();
  await expect(page.locator(".ax-shell")).toHaveAttribute("data-collapsed", "false");
  await context.close();
});

test("Account menu: opens, reaches Account security, closes on Escape and returns focus", async ({ browser }) => {
  const { context, page } = await openRole(browser, "COACH");
  await page.goto("/training");
  const button = page.getByRole("button", { name: /Account menu/ });
  await button.click();
  await expect(page.getByRole("link", { name: "Account security" }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Account" })).toHaveCount(0);
  await expect(button).toBeFocused();
  await button.click();
  await page.getByRole("group", { name: "Account" }).getByRole("link", { name: "Account security" }).click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible();
  await context.close();
});

test("Mobile drawer: traps focus, closes on Escape, restores focus and navigates", async ({ browser }) => {
  const { context, page } = await openRole(browser, "OWNER", { width: 390, height: 844 });
  await page.goto("/overview");
  const menuButton = page.getByRole("button", { name: "Open navigation" });
  await expect(menuButton).toBeVisible();
  await expect(page.locator("#ax-sidebar")).toBeHidden(); // closed drawer is not exposed
  await menuButton.click();
  const drawer = page.getByRole("dialog", { name: "Navigation drawer" });
  await expect(drawer).toBeVisible();
  const inside = () => page.evaluate(() => document.getElementById("ax-sidebar")!.contains(document.activeElement));
  expect(await inside()).toBe(true);
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    expect(await inside()).toBe(true); // focus never leaves the drawer
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(menuButton).toBeFocused();
  await menuButton.click();
  await drawer.getByRole("link", { name: "Players" }).click();
  await expect(page).toHaveURL(/\/players$/);
  await expect(page.locator("#ax-sidebar")).toBeHidden();
  await context.close();
});

test("Direct API calls are refused for roles that must not make them (not just hidden in the UI)", async () => {
  const origin = { origin: base() };
  const cases: { role: RoleKey; method: "GET" | "POST"; path: string; status: number }[] = [
    { role: "COACH", method: "POST", path: "/api/academy/fees/plan", status: 403 },
    { role: "COACH", method: "POST", path: "/api/academy/settings/save", status: 403 },
    { role: "COACH", method: "POST", path: "/api/academy/privacy/policy", status: 403 },
    { role: "COACH", method: "GET", path: "/api/academy/security-events", status: 403 },
    { role: "COACH", method: "GET", path: "/api/academy/access-events", status: 403 },
    { role: "HEAD_COACH", method: "POST", path: "/api/academy/fees/invoice", status: 403 },
    { role: "FINANCE", method: "GET", path: "/api/training", status: 403 },
    { role: "FINANCE", method: "POST", path: "/api/academy/players/save", status: 403 },
    { role: "FINANCE", method: "GET", path: "/api/academy/consent/report", status: 403 },
    { role: "NUTRITION_PRO", method: "POST", path: "/api/academy/fees/invoice", status: 403 },
    { role: "NUTRITION_PRO", method: "POST", path: "/api/academy/players/save", status: 403 },
    { role: "GUARDIAN", method: "POST", path: "/api/academy/players/save", status: 403 },
    { role: "GUARDIAN", method: "GET", path: "/api/training", status: 403 },
    { role: "GUARDIAN", method: "GET", path: "/api/academy/privacy/overview", status: 403 },
    { role: "ADMIN", method: "POST", path: "/api/academy/settings/member", status: 403 }, // owner only
    { role: "ADMIN", method: "POST", path: "/api/academy/privacy/release", status: 403 }, // owner only
  ];
  for (const c of cases) {
    const api = await apiFor(c.role);
    const response = c.method === "GET" ? await api.get(c.path) : await api.post(c.path, { headers: origin, data: {} });
    expect(response.status(), `${c.role} ${c.method} ${c.path}`).toBe(c.status);
    await api.dispose();
  }
  // wrong origin on a write, and no session at all
  const owner = await apiFor("OWNER");
  expect((await owner.post("/api/academy/settings/save", { headers: { origin: "http://evil.example" }, data: {} })).status()).toBe(403);
  await owner.dispose();
  const anonymous = await request.newContext({ baseURL: base() });
  expect((await anonymous.get("/api/academy")).status()).toBe(401);
  expect((await anonymous.get("/api/training")).status()).toBe(401);
  await anonymous.dispose();
});

test("Video: not offered in the menu, still opens by address for the owner, and no soon badge appears", async ({ browser }) => {
  const { context, page, problems } = await openRole(browser, "OWNER");
  await page.goto("/overview");
  await expect(nav(page).getByRole("link", { name: /Video/ })).toHaveCount(0);
  await expect(page.getByText("AI soon")).toHaveCount(0);
  await page.goto("/video");
  await expect(page).toHaveURL(/\/video$/);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("heading", { name: /don.t have access/i })).toHaveCount(0);
  expect(problems.filter((p) => !p.includes("/api/academy/media"))).toEqual([]);
  await context.close();
});
