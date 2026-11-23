import { test, expect, type Page } from "@playwright/test";
import { apiFor, base, stateFor, ROLE_ACCOUNTS } from "./support/roles";

/**
 * Phase 9 family portal. Isolation is checked where it is enforced (the server's read model) and then through
 * the screen: a guardian sees only the children linked to them, nothing about other families, staff or other
 * guardians; every section opens; and what a family writes survives a refresh and a fresh sign-in.
 * Seed facts (scripts/seed-operations.ts): Priya Mehta is linked to Aarav Mehta and Diya Sharma, Raj Mehta only to
 * Aarav Mehta. Players are under 18 and have no login, so no seeded account is a player. Other seeded players must never appear.
 */
const OTHERS = ["Arjun Rao", "Kabir Singh", "Meera Kapoor", "Vihaan Nair", "Riya Patel", "Isha Shah", "Dev Kumar", "Siya Verma"];
// "Video" is not offered in the family menu (UX-D8): the unbuilt feature does not occupy a navigation slot.
// Four primary items (UX-D2). Reports is the second tab of Schedule; Fees, Nutrition and Access & preferences open from More.
const PRIMARY = ["Home", "Schedule", "Messages", "More"];
const UNDER_MORE = ["Fees", "Nutrition", "Access & preferences"];

async function family(browser: import("@playwright/test").Browser, role: "GUARDIAN" | "GUARDIAN_TWO", viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ storageState: await stateFor(role), viewport, baseURL: base() });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") && r.status() >= 400) problems.push(`${r.status()} ${u.pathname}`);
  });
  return { context, page, problems };
}
const nav = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });

test("Guardian: the server's read model holds only their own children, no staff and no other families", async () => {
  const api = await apiFor("GUARDIAN");
  const response = await api.get("/api/academy");
  expect(response.status()).toBe(200);
  const text = await response.text();
  const data = JSON.parse(text);
  expect((data.players as { name: string }[]).map((p) => p.name).sort()).toEqual(["Aarav Mehta", "Diya Sharma"]);
  for (const name of OTHERS) expect(text, `${name} must not be in a guardian payload`).not.toContain(name);
  // other guardians, staff e-mail addresses and the other guardian's account never appear
  expect(text).not.toContain(ROLE_ACCOUNTS.GUARDIAN_TWO);
  expect(text).not.toContain(ROLE_ACCOUNTS.OWNER);
  expect(text).not.toContain(ROLE_ACCOUNTS.COACH);
  expect(data.permissions.family).toBe(true);
  expect(data.enquiries).toEqual([]);
  expect(data.audits).toEqual([]);
  await api.dispose();
  // the second guardian sees only the child they share, never the first guardian's other child
  const raj = await apiFor("GUARDIAN_TWO");
  const rajText = await (await raj.get("/api/academy")).text();
  expect(rajText).toContain("Aarav Mehta");
  expect(rajText).not.toContain("Diya Sharma");
  await raj.dispose();
});

test("Guardian: every family section opens on screen without an error, and children match the server", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page, problems } = await family(browser, "GUARDIAN");
  await page.goto("/family");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("heading", { name: "Aarav Mehta" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Diya Sharma" })).toBeVisible();
  for (const name of OTHERS) await expect(page.getByText(name)).toHaveCount(0);
  await expect(nav(page).getByRole("button")).toHaveCount(PRIMARY.length);
  const clean = async () => {
    await expect(page.locator(".error[role='alert']")).toHaveCount(0);
    for (const name of OTHERS) await expect(page.getByText(name)).toHaveCount(0);
  };
  for (const section of PRIMARY) {
    await nav(page).getByRole("button", { name: section, exact: true }).click();
    await expect(nav(page).locator('[aria-current="page"]')).toContainText(section);
    await clean();
  }
  // Reports: the second tab of Schedule, and Schedule stays the current item.
  await nav(page).getByRole("button", { name: "Schedule", exact: true }).click();
  await page.locator(".ops-tabs").getByRole("button", { name: "Reports", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reports");
  await expect(nav(page).locator('[aria-current="page"]')).toContainText("Schedule");
  await clean();
  // Everything else opens from More, with a way back.
  for (const section of UNDER_MORE) {
    await nav(page).getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("button", { name: `Open ${section.toLowerCase()} →` }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(section);
    await expect(nav(page).locator('[aria-current="page"]')).toContainText("More");
    await clean();
    await page.getByRole("button", { name: "← Back to More" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("More");
  }
  expect(problems).toEqual([]);
  await context.close();
});

test("The second guardian sees only what is theirs on screen", async ({ browser }) => {
  test.setTimeout(240_000);
  const raj = await family(browser, "GUARDIAN_TWO");
  await raj.page.goto("/family");
  await expect(raj.page.getByRole("heading", { name: "Aarav Mehta" })).toBeVisible({ timeout: 90_000 });
  await expect(raj.page.getByText("Diya Sharma")).toHaveCount(0);
  await raj.context.close();
});

test("Portals are separate: family roles are sent to /family, staff roles away from it, both without losing the session", async ({ browser }) => {
  test.setTimeout(240_000);
  const guardian = await family(browser, "GUARDIAN");
  await guardian.page.goto("/players");
  await expect(guardian.page).toHaveURL(/\/family$/, { timeout: 90_000 });
  await guardian.page.goto("/");
  await expect(guardian.page).toHaveURL(/\/family$/, { timeout: 90_000 });
  await guardian.context.close();
  const coach = await browser.newContext({ storageState: await stateFor("COACH"), baseURL: base() });
  const page = await coach.newPage();
  await page.goto("/family");
  await expect(page).toHaveURL(/\/training$/, { timeout: 90_000 });
  await coach.close();
});

test("Family workspace is mobile-first: drawer navigation works at 390px and nothing scrolls sideways", async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await family(browser, "GUARDIAN", { width: 390, height: 844 });
  await page.goto("/family");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.getByRole("dialog", { name: "Navigation drawer" }).getByRole("button", { name: "Schedule" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Schedule");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});

test("A message written by a guardian persists after a refresh and after signing out and back in, and the academy can see it", async ({ browser }) => {
  test.setTimeout(300_000);
  const stamp = `Phase 9 persistence ${Date.now()}`;
  const { context, page } = await family(browser, "GUARDIAN");
  await page.goto("/family");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 90_000 });
  await nav(page).getByRole("button", { name: "Messages", exact: true }).click();
  await page.getByRole("button", { name: "Message your academy" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Subject").fill(stamp);
  await dialog.getByLabel("Private message").fill("Browser check: this message must still be here after a refresh and a new sign-in.");
  await dialog.getByRole("button", { name: /^Save$|Send/ }).click();
  await expect(page.getByRole("heading", { name: stamp })).toBeVisible({ timeout: 60_000 });
  await page.reload();
  await nav(page).getByRole("button", { name: "Messages", exact: true }).click();
  await expect(page.getByRole("heading", { name: stamp })).toBeVisible({ timeout: 60_000 });
  // sign out through the account menu, then sign in again through the form
  await page.getByRole("button", { name: /Account menu/ }).click();
  await page.getByRole("group", { name: "Account" }).getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  // The sign-in form keeps "Sign in" disabled until React has attached its handlers. Text typed before that is not in the form's
  // state, so the click would submit empty fields and send no request. The button becoming enabled is the page's own readiness signal.
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(signIn).toBeEnabled({ timeout: 90_000 });
  await page.getByLabel("Email address").fill(ROLE_ACCOUNTS.GUARDIAN);
  await page.getByLabel("Password", { exact: true }).fill(process.env.DEV_SEED_PASSWORD!);
  const attempt = () => Promise.all([page.waitForResponse((r) => r.url().endsWith("/api/auth/sign-in/email")), signIn.click()]).then(([r]) => r);
  if ((await attempt()).status() === 429) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    expect((await attempt()).ok()).toBeTruthy();
  }
  await expect(page).toHaveURL(/\/family$/, { timeout: 90_000 });
  await nav(page).getByRole("button", { name: "Messages", exact: true }).click();
  await expect(page.getByRole("heading", { name: stamp })).toBeVisible({ timeout: 60_000 });
  // the academy side sees the same conversation (server-side persistence, and staff access to the family's message)
  const owner = await apiFor("OWNER");
  const academy = await (await owner.get("/api/academy")).json();
  expect((academy.conversations as { subject: string }[]).some((c) => c.subject === stamp)).toBe(true);
  await owner.dispose();
  await context.close();
});
