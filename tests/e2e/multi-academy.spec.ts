import { test, expect, type Page } from "@playwright/test";
import { configured } from "./support/profile";

/**
 * One login, several academies, in a real browser. Runs against a DISPOSABLE seeded server (npm run db:seed) in which the
 * seeded owner of Greenfield, admin@greenfield.example, has also been given a HEAD_COACH membership at Bluebird.
 * E2E_SEED_PASSWORD is the DEV_SEED_PASSWORD that server was seeded with.
 */
const PASSWORD = process.env.E2E_SEED_PASSWORD ?? "";
const DUAL = "admin@greenfield.example";
const GREEN = "Greenfield Badminton Academy";
const BLUE = "Bluebird Badminton Academy";

test.beforeEach(async ({ request }) => {
  configured(!!PASSWORD, "E2E_SEED_PASSWORD is not set");
  const r = await request.get("/api/auth/account/sign-in-methods");
  configured(r.ok(), "no server");
});

/**
 * Signs in through the real form. The sign-in endpoint is rate limited (5 a minute per client address, and a test server
 * has no trusted proxy so every client shares one bucket): when this suite signs in more often than that, wait out the
 * window and try again instead of treating the correct "Too many attempts" answer as a failure.
 */
async function signIn(page: Page, email: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto("/login");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    const limited = await Promise.race([
      page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }).then(() => false),
      page.getByText(/Too many attempts/).waitFor({ timeout: 30_000 }).then(() => true),
    ]).catch(() => false);
    if (!limited) return;
    await page.waitForTimeout(62_000);
  }
  throw new Error("sign-in stayed rate limited");
}
const sidebarAcademy = (page: Page) => page.locator(".ax-academy strong");
const apiText = async (page: Page, path: string) => (await page.request.get(path)).text();
const openAccountMenu = (page: Page) => page.locator(".ax-account-button").click();

test("several academies: after sign-in the person CHOOSES one, sees only its data and their role there, switches without signing out, and each sign-in starts with a choice", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, DUAL);

  // No academy is chosen yet: the workspace sends the person to the chooser, and shows no academy data.
  await expect(page).toHaveURL(/\/academies/);
  await expect(page.getByRole("heading", { name: "Which academy are you working in?" })).toBeVisible();
  const options = page.getByRole("list", { name: "Your academies" }).getByRole("button");
  await expect(options).toHaveCount(2);
  await expect(options.filter({ hasText: GREEN })).toContainText(/owner/i);
  await expect(options.filter({ hasText: BLUE })).toContainText(/head coach/i);
  expect((await page.request.get("/api/academy/identity")).status()).toBe(409);

  // Choose Greenfield: its name is visible in the shell, as the Owner, and only its data is served.
  await options.filter({ hasText: GREEN }).click();
  await expect(sidebarAcademy(page)).toHaveText(GREEN);
  expect(await apiText(page, "/api/academy")).toContain("Gurugram");
  expect(await apiText(page, "/api/academy")).not.toContain("Brooklyn");
  expect(((await (await page.request.get("/api/academy/identity")).json()) as { role: string }).role).toBe("OWNER");

  // Switch from the account menu: no sign-out, the current academy is marked.
  await openAccountMenu(page);
  await expect(page.locator("#ax-account-panel")).toContainText(GREEN);
  await page.getByRole("button", { name: "Switch academy" }).click();
  await expect(page).toHaveURL(/\/academies\?switch=1/);
  const switching = page.getByRole("list", { name: "Your academies" }).getByRole("button");
  await expect(switching.filter({ hasText: GREEN })).toContainText("Current");
  await switching.filter({ hasText: BLUE }).click();

  await expect(sidebarAcademy(page)).toHaveText(BLUE);
  expect(await apiText(page, "/api/academy")).toContain("Brooklyn");
  expect(await apiText(page, "/api/academy")).not.toContain("Gurugram");
  expect(((await (await page.request.get("/api/academy/identity")).json()) as { role: string }).role).toBe("HEAD_COACH");
  await openAccountMenu(page);
  await expect(page.locator("#ax-account-panel")).toContainText(BLUE);
  await expect(page.locator("#ax-account-panel")).toContainText(/head coach/i);

  // Still the same login (no second sign-in was needed), and signing out ends the choice: the next sign-in asks again.
  expect(await (await page.request.get("/api/auth/get-session")).json()).not.toBeNull();
  await page.locator("#ax-account-panel").getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, DUAL);
  await expect(page).toHaveURL(/\/academies/);
  expect(errors).toEqual([]);
});

test("a person with exactly one academy never sees the chooser, and has no 'Switch academy' item", async ({ page }) => {
  await signIn(page, "aman@greenfield.example");
  await expect(sidebarAcademy(page)).toHaveText(GREEN);
  expect(page.url()).not.toContain("/academies");
  await openAccountMenu(page);
  await expect(page.locator("#ax-account-panel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch academy" })).toHaveCount(0);
});

test("a person with no academy is asked to create their academy, sees no data and a way to sign out", async ({ page }) => {
  await signIn(page, "unassigned@example.test");
  await expect(page).toHaveURL(/\/academies/);
  await expect(page.getByRole("heading", { name: "Create your academy" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Accept a private invitation" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Your academies" })).toHaveCount(0);
  expect((await page.request.get("/api/academy/identity")).status()).toBe(403);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("the chooser needs a signed-in person, and an academy that is not theirs cannot be chosen from the browser", async ({ page, request }) => {
  await page.goto("/academies");
  await expect(page).toHaveURL(/\/login/);
  await signIn(page, DUAL);
  await expect(page).toHaveURL(/\/academies/);
  const refused = await page.request.post("/api/auth/account/select-academy", {
    headers: { origin: new URL(page.url()).origin },
    data: { academyId: "an-academy-that-is-not-mine" },
  });
  expect(refused.status()).toBe(404);
  expect((await page.request.get("/api/academy/identity")).status()).toBe(409);
  void request;
});
