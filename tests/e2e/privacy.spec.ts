import { test, expect } from "@playwright/test";
import { loginContext } from "./support/roles";
/**
 * Phase 8 browser check: Settings -> Privacy and erasure for the development academy's owner.
 * Deliberately non-destructive: it only creates a request (which previews but erases nothing), shows
 * that the owner cannot approve their own request, and cancels it.
 */
const base = process.env.BETTER_AUTH_URL!;
test("owners see retention rules that require approval, can preview an erasure without changing data, and cannot approve their own request", async ({ page }) => {
  test.setTimeout(240000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The owner's session comes from the shared cache (support/roles.ts): sign-in allows 5 attempts a minute per client address and
  // that limit is not weakened for tests.
  await loginContext(page.context(), "OWNER");
  await page.goto("/");
  await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Privacy & policies", exact: true }).click();
  await page.getByRole("button", { name: "Privacy and erasure", exact: true }).click();
  await expect(page.getByText("Nothing is erased automatically")).toBeVisible();
  const rules = page.getByRole("table", { name: /What may be erased/ });
  await expect(rules.getByRole("row", { name: /Private media and video/ })).toContainText("Requires policy approval");
  await expect(rules.getByRole("row", { name: /Invoices, payments/ })).toContainText("Fixed");
  await expect(rules.getByRole("row", { name: /Consent history/ })).toContainText("Fixed");
  // Raise a request: it is only a preview.
  const form = page.getByRole("form", { name: "New erasure request" });
  await form.getByLabel("Player").selectOption({ index: 1 });
  await form.getByLabel(/Why/).fill("Browser check of the preview only, to be cancelled.");
  await form.getByRole("button", { name: "Create request and preview" }).click();
  await expect(page.getByText(/Request created with a preview/)).toBeVisible();
  await page.getByRole("table", { name: /Erasure requests, newest first/ }).getByRole("button", { name: "Open" }).first().click();
  const detail = page.getByRole("article", { name: "Erasure request" });
  await expect(detail.getByText(/Impact preview \(counts only; nothing has been changed\)/)).toBeVisible();
  await expect(detail.getByRole("row", { name: /Private media and video/ })).toContainText("requires policy approval");
  await expect(detail.getByRole("row", { name: /Invoices, payments/ })).toContainText("Kept (evidence)");
  await expect(detail.getByText("You raised this request, so someone else must review it.")).toBeVisible();
  await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/privacy-preview.png` : "privacy-preview.png", fullPage: true });
  // The server, not only the screen, refuses a self-approval (the password is correct, so the refusal is the rule itself).
  const overview = await (await page.request.get("/api/academy/privacy/overview")).json();
  const mine = overview.requests.find((r: { status: string }) => r.status === "PREVIEW_READY");
  expect(mine).toBeTruthy();
  const attempt = await page.request.post("/api/academy/privacy/review", {
    headers: { origin: base },
    data: { id: mine.id, version: mine.version, decision: "APPROVE", reason: "Browser check: this self-approval must be refused.", ownerPassword: process.env.DEV_SEED_PASSWORD },
  });
  expect(attempt.status()).toBe(403);
  expect(await attempt.text()).toContain("SELF_APPROVAL_FORBIDDEN");
  // Cancel it again.
  await detail.getByLabel("Why it is cancelled").fill("Browser check finished; nothing to erase.");
  await detail.getByRole("button", { name: "Cancel request" }).click();
  await expect(page.getByText("Request cancelled.")).toBeVisible();
  await expect(page.getByRole("table", { name: /Erasure requests, newest first/ }).getByRole("row").nth(1)).toContainText("cancelled");
  expect(errors).toEqual([]);
});
