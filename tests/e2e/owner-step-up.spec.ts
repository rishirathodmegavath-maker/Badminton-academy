import { test, expect, type APIRequestContext, type Browser } from "@playwright/test";
import { parseProvisioningUri, totpAt } from "../helpers/totp";

/**
 * RC-2 in the browser (TD-1, TD-2 / PD-1): granting or removing Owner access from Settings -> Roles & permissions.
 *  1. An owner without an authenticator is refused in the dialog with the enrolment instruction; nothing changes.
 *  2. After enrolling, the same change succeeds only with the owner's password and a second factor (a recovery
 *     code here, so the test does not depend on the 30-second TOTP step); a wrong code is refused and changes nothing.
 * The owner's authenticator is removed again at the end, so other specs can keep signing in with a password.
 * Creates records, so it runs ONLY under playwright.isolated.config.ts (E2E_DISPOSABLE=true, loopback, never 3100).
 */
const base = process.env.E2E_BASE_URL ?? "";
const disposable =
  process.env.E2E_DISPOSABLE === "true" &&
  /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(base) &&
  new URL(base || "http://x").port !== "3100";
test.skip(!disposable, "needs a disposable instance (E2E_DISPOSABLE=true, E2E_BASE_URL, not port 3100)");
const PASSWORD = process.env.DEV_SEED_PASSWORD ?? "";
const OWNER_EMAIL = "admin@greenfield.example";

async function signedIn(browser: Browser, email: string) {
  const context = await browser.newContext({ baseURL: base });
  const login = await context.request.post("/api/auth/sign-in/email", {
    headers: { origin: base },
    data: { email, password: PASSWORD },
    timeout: 60_000,
  });
  expect(login.ok(), `sign-in ${login.status()}`).toBeTruthy();
  return context;
}
const post = (api: APIRequestContext, path: string, data: unknown) =>
  api.post(path, { headers: { origin: base }, data, timeout: 60_000 });
type Workspace = { members: { id: string; email: string; role: string; active: boolean }[] };

test("owner changes in Settings need an authenticator, the owner's password and a second factor", async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await signedIn(browser, OWNER_EMAIL);
  const workspace = async () => (await (await owner.request.get("/api/academy", { timeout: 60_000 })).json()) as Workspace;
  const roleOf = async (id: string) => (await workspace()).members.find((m) => m.id === id)?.role;
  const stamp = Date.now();
  const name = `E2E Owner Candidate ${stamp}`;
  const created = await post(owner.request, "/api/academy/settings/member", {
    name,
    email: `e2e-owner-candidate-${stamp}@greenfield.example`,
    role: "COACH",
    active: true,
    professionalAttestation: "",
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const memberId = (await created.json()).id as string;

  const page = await owner.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const dialog = page.getByRole("dialog", { name: "Update academy access" });
  async function openMember() {
    await page.goto("/settings", { timeout: 120_000 });
    await page.getByRole("button", { name: "Team", exact: true }).click();
    await page.getByLabel("Search records").fill(name);
    await page.getByRole("button", { name: "Manage access" }).click();
    await expect(dialog).toBeVisible();
  }

  // 1. No authenticator: refused with the enrolment instruction (PD-1, no password-only fallback).
  await openMember();
  await dialog.getByLabel("Academy role").selectOption("OWNER");
  await dialog.getByLabel(/Your password/).fill(PASSWORD);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Enroll MFA in your Account Settings");
  expect(await roleOf(memberId)).toBe("COACH");

  // Enrol an authenticator for the owner (Better Auth's own enrolment endpoints).
  const enable = await post(owner.request, "/api/auth/two-factor/enable", { password: PASSWORD });
  expect(enable.ok(), await enable.text()).toBeTruthy();
  const { totpURI, backupCodes } = (await enable.json()) as { totpURI: string; backupCodes: string[] };
  const { secret } = parseProvisioningUri(totpURI);
  const activate = await post(owner.request, "/api/auth/two-factor/verify-totp", { code: totpAt(secret, 0) });
  expect(activate.ok(), await activate.text()).toBeTruthy();
  try {
    // 2a. A wrong code: refused, nothing changes.
    await openMember();
    await dialog.getByLabel("Academy role").selectOption("OWNER");
    await dialog.getByLabel(/Your password/).fill(PASSWORD);
    await dialog.getByLabel(/Authenticator code or recovery code/).fill("000000");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("not accepted");
    expect(await roleOf(memberId)).toBe("COACH");
    // 2b. Password + recovery code: the member becomes an owner.
    await dialog.getByLabel(/Authenticator code or recovery code/).fill(backupCodes[0]);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await roleOf(memberId)).toBe("OWNER");
    // 2c. Removing it again needs a fresh factor too; a used recovery code is refused, an unused one works.
    await openMember();
    await dialog.getByLabel("Academy role").selectOption("COACH");
    await dialog.getByLabel(/Your password/).fill(PASSWORD);
    await dialog.getByLabel(/Authenticator code or recovery code/).fill(backupCodes[0]);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("not accepted");
    expect(await roleOf(memberId)).toBe("OWNER");
    await dialog.getByLabel(/Authenticator code or recovery code/).fill(backupCodes[1]);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await roleOf(memberId)).toBe("COACH");
  } finally {
    const disable = await post(owner.request, "/api/auth/two-factor/disable", { password: PASSWORD });
    expect(disable.ok(), `authenticator removed again: ${disable.status()} ${await disable.text()}`).toBeTruthy();
  }
  expect(errors).toEqual([]);
});
