import { test, expect } from "@playwright/test";
/**
 * Phase 7 browser check: Settings -> Access history for an administrator of the development academy.
 * Needs the development server and the seeded development account (see README); it only reads.
 */
const base = process.env.BETTER_AUTH_URL!;
test("administrators can investigate the sensitive-data access history; filters and paging work; nothing is editable", async ({
  page,
}) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const login = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin: base },
    timeout: 60000,
    data: { email: "admin@greenfield.example", password: process.env.DEV_SEED_PASSWORD },
  });
  expect(login.ok(), await login.text()).toBeTruthy();
  // Produce one allowed and one refused access so there is something specific to find.
  expect((await page.request.get("/api/academy", { timeout: 60000 })).ok()).toBeTruthy();
  expect((await page.request.get("/api/academy/reports/browser-check-missing/pdf")).status()).toBe(404);
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Security & audit", exact: true }).click();
  await page.getByRole("button", { name: "Access history", exact: true }).click();
  const table = page.getByRole("table", { name: /Sensitive-data access history/ });
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr").first()).toBeVisible();
  await expect(page.getByText("cannot be edited or deleted").first()).toBeVisible();
  // Filter to refused attempts only: every visible row says Denied.
  await page.getByLabel("Outcome").selectOption("DENIED");
  await expect(table.locator("tbody tr").first()).toContainText("Denied");
  const rows = table.locator("tbody tr");
  for (let i = 0; i < Math.min(await rows.count(), 10); i++)
    await expect(rows.nth(i)).toContainText("Denied");
  await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/access-history-denied.png` : "access-history-denied.png", fullPage: true });
  // A reference that matches nothing shows the empty state, not an error.
  await page.getByLabel("Record reference").fill("no-such-reference-1");
  await expect(page.getByText("No matching access events.")).toBeVisible();
  await page.getByLabel("Record reference").fill("");
  await page.getByLabel("Outcome").selectOption("");
  await expect(table.locator("tbody tr").first()).toBeVisible();
  // No control edits or deletes history.
  await expect(page.getByRole("button", { name: /delete|edit|remove/i })).toHaveCount(0);
  // The page records that it was opened, and a non-itemised workspace load never shows content.
  await page.getByLabel("Kind of information").selectOption("AUDIT_LOG");
  await expect(table.locator("tbody tr").first()).toContainText("This access history");
  expect(errors).toEqual([]);
});
