import { test, expect, type APIRequestContext, type Browser } from "@playwright/test";
import { ROLE_ACCOUNTS, stateFor, type RoleKey } from "./support/roles";

/**
 * Stage 5C in the browser: finance rejects a payment reference as correctable through the verify
 * dialog, the invoice shows the rejected attempt, and the family resubmits the same reference (other
 * case and spacing) as a new attempt; a further copy is refused as a duplicate.
 * Creates records, so it runs ONLY under playwright.isolated.config.ts (E2E_DISPOSABLE=true, loopback,
 * never port 3100). Under any other configuration it is skipped, and reported as skipped.
 */
const base = process.env.E2E_BASE_URL ?? "";
const disposable =
  process.env.E2E_DISPOSABLE === "true" &&
  /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(base) &&
  new URL(base || "http://x").port !== "3100";
test.skip(!disposable, "needs a disposable instance (E2E_DISPOSABLE=true, E2E_BASE_URL, not port 3100)");

/**
 * A context signed in as the role account with this address. Sessions come from the cache in support/roles.ts: the sign-in
 * endpoint allows 5 attempts a minute per client address (one shared bucket on a server with no trusted proxy) and that limit
 * is not weakened for tests, so the suite signs each role in once and reuses it (waiting out a 429 where it happens).
 */
async function signedIn(browser: Browser, email: string) {
  const role = (Object.keys(ROLE_ACCOUNTS) as RoleKey[]).find((r) => ROLE_ACCOUNTS[r] === email);
  if (!role) throw new Error(`No role account for ${email}`);
  return browser.newContext({ baseURL: base, storageState: await stateFor(role) });
}
const post = (api: APIRequestContext, path: string, data: unknown) =>
  api.post("/api/academy" + path, { headers: { origin: base }, data, timeout: 60_000 });

test("a correctable rejection is shown on the invoice and the family can resubmit the reference as a new attempt", async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await signedIn(browser, "admin@greenfield.example");
  const family = await signedIn(browser, "priya@greenfield.example");
  const finance = await signedIn(browser, "finance@greenfield.example");
  const workspace = await (await owner.request.get("/api/academy", { timeout: 60_000 })).json();
  const priya = workspace.members.find((m: { email: string }) => m.email === "priya@greenfield.example");
  const link = workspace.guardianLinks.find((l: { userId: string; active: boolean }) => l.userId === priya.id && l.active);
  const issued = await post(owner.request, "/fees/invoice", {
    id: crypto.randomUUID(),
    playerIds: [link.playerId],
    familyUserId: null,
    planId: null,
    description: "Stage 5C browser check",
    subtotal: 150000,
    discount: 0,
    currency: workspace.settings.data.currency,
    dueDate: "2030-01-31",
  });
  expect(issued.ok(), await issued.text()).toBeTruthy();
  const invoice = await issued.json();
  const reference = `E2E-UTR-${Date.now()}`;
  const submitted = await post(family.request, "/fees/payment", {
    invoiceId: invoice.id,
    idempotencyKey: crypto.randomUUID(),
    amount: 150000,
    reference,
    method: "BANK",
  });
  expect(submitted.ok(), await submitted.text()).toBeTruthy();
  const first = await submitted.json();

  // Finance rejects it as correctable through the verify dialog.
  const page = await finance.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/fees", { timeout: 120_000 });
  await page.getByLabel("Search invoices").fill(invoice.data.number);
  await page.getByRole("button", { name: `Select invoice ${invoice.data.number}` }).click();
  await page.getByRole("button", { name: "Review reference" }).click();
  await page.getByLabel("Verification decision").selectOption("REJECTED");
  await page.getByLabel("If rejected").selectOption("CORRECTABLE");
  await page.getByLabel("Verification evidence / reason").fill("The amount on the bank statement differs.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(`Rejected: ${reference}`)).toBeVisible();
  await expect(page.getByText("may be resubmitted").first()).toBeVisible();

  // The family resubmits the same reference (other case and spacing): a new attempt.
  const again = await post(family.request, "/fees/payment", {
    invoiceId: invoice.id,
    idempotencyKey: crypto.randomUUID(),
    amount: 150000,
    reference: `  ${reference.toLowerCase()} `,
    method: "BANK",
  });
  expect(again.ok(), await again.text()).toBeTruthy();
  const second = await again.json();
  expect(second.id).not.toBe(first.id);
  expect(second.status).toBe("SUBMITTED");
  expect(second.data.previousAttemptId).toBe(first.id);
  const duplicate = await post(family.request, "/fees/payment", {
    invoiceId: invoice.id,
    idempotencyKey: crypto.randomUUID(),
    amount: 150000,
    reference,
    method: "BANK",
  });
  expect(duplicate.status()).toBe(409);
  expect((await duplicate.json()).code).toBe("PAYMENT_REFERENCE_DUPLICATE");

  // Finance sees the new attempt waiting for review and the rejected one still listed.
  await page.reload();
  await page.getByLabel("Search invoices").fill(invoice.data.number);
  await page.getByRole("button", { name: `Select invoice ${invoice.data.number}` }).click();
  await expect(page.getByText(`Rejected: ${reference}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review reference" })).toBeVisible();
  expect(errors).toEqual([]);
  for (const c of [owner, family, finance]) await c.close();
});
