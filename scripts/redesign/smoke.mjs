import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
process.loadEnvFile(".env.local");
const base = "http://127.0.0.1:3100";
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width: 1600, height: 1000 },
  });
  const login = await context.request.post("/api/auth/sign-in/email", {
    timeout: 60000,
    headers: { origin: base },
    data: {
      email: "admin@greenfield.example",
      password: process.env.DEV_SEED_PASSWORD,
    },
  });
  assert(login.ok());
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  const deliveryRequests = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/communications/process"))
      deliveryRequests.push(r.url());
  });
  await page.goto("/");
  await page.locator(".drill-card").first().waitFor();
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav
    .getByRole("button", { name: "Communications", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Scheduled outbox", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Process due approved messages" }),
  ).toBeVisible();
  await nav.getByRole("button", { name: "Training", exact: true }).click();
  await page
    .getByRole("button", { name: "Create session", exact: false })
    .click();
  await page
    .getByLabel("Session title", { exact: true })
    .fill("QA multi-drill preview check");
  await page
    .getByRole("combobox", { name: "Batch", exact: true })
    .selectOption({ label: "Junior Foundations" });
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  const card = (title) =>
    page
      .locator(".drill-card")
      .filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  await card("Clear & recover")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await card("Net shot & lift")
    .getByRole("button", { name: "View drill", exact: true })
    .click();
  await page.getByRole("button", { name: "Back to drills", exact: true }).click();
  await page.getByRole("button", { name: "Session", exact: true }).click();
  await expect(page.getByLabel("Session title", { exact: true })).toHaveValue(
    "QA multi-drill preview check",
  );
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await card("Net shot & lift")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await page.getByRole("button", { name: "Open session", exact: true }).click();
  await page.getByLabel("Clear & recover minutes", { exact: true }).fill("12");
  await page.getByLabel("Net shot & lift minutes", { exact: true }).fill("8");
  await page
    .getByRole("button", { name: "Move Net shot & lift up", exact: true })
    .click();
  await expect(page.locator(".activity-editor").first()).toContainText(
    "Net shot & lift",
  );
  await page
    .getByRole("button", { name: "Remove Clear & recover", exact: true })
    .click();
  await expect(
    page.getByLabel("Clear & recover minutes", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Explore", exact: true }).click();
  await card("Clear & recover")
    .getByRole("button", { name: "Add", exact: true })
    .click();
  await page.getByRole("button", { name: "Open session", exact: true }).click();
  await page.getByLabel("Clear & recover minutes", { exact: true }).fill("12");
  await page
    .getByRole("button", { name: "Add custom activity or rest", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: /^Custom activity .* name$/ })
    .fill("QA recovery break");
  await page.getByLabel("Duration (min)", { exact: true }).fill("25");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Draft saved." }),
  ).toBeVisible();
  const id = page.url().split("#")[1];
  const saved = (
    await (await context.request.get("/api/training")).json()
  ).sessions.find((s) => s.id === id);
  assert.equal(saved.data.activities.length, 3);
  assert.equal(saved.data.activities[0].title, "Net shot & lift");
  assert.equal(
    saved.data.activities.reduce((n, a) => n + a.minutes, 0),
    25,
  );
  assert.equal(deliveryRequests.length, 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      multiDrillDraft: "saved",
      previewRetainsDraft: true,
      reorderRemoveCustomDuration: "verified",
      outboxControl: "present; not invoked",
      browserErrors: errors,
    }),
  );
} finally {
  await browser.close();
}
