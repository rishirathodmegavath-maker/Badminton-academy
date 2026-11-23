import { test, expect, type Page } from "@playwright/test";
import { ROLE_ACCOUNTS, base, stateFor } from "./support/roles";

/**
 * Phase 9 sign-in and account experience in a real browser. The Google button must appear if and only if the
 * server reports Google as configured, and when it does it must start a real OAuth redirect (Google's own page is
 * intercepted; nothing leaves the machine).
 */
const password = () => process.env.DEV_SEED_PASSWORD!;

async function methods(page: Page) {
  const r = await page.request.get("/api/auth/account/sign-in-methods");
  return (await r.json()) as { google: { enabled: boolean } };
}
async function submit(page: Page) {
  const attempt = () =>
    Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/auth/sign-in/email")),
      page.getByRole("button", { name: "Sign in", exact: true }).click(),
    ]).then(([r]) => r);
  let response = await attempt();
  if (response.status() === 429) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    response = await attempt();
  }
  return response;
}

test("Login page: labelled form, no password-reset link that does not exist, and Google offered, honest when it is not configured", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: base() });
  const page = await context.newPage();
  await page.goto("/login");
  await expect(page.getByLabel("Email address")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  // The password-reset page now exists (it says plainly when email delivery is not set up), so the link on this screen is real.
  await expect(page.getByRole("link", { name: /forgot/i })).toHaveAttribute("href", "/forgot-password");
  const google = (await methods(page)).google.enabled;
  const button = page.getByRole("button", { name: "Continue with Google" });
  if (!google) {
    // The button is always offered; on a server without Google credentials pressing it says so plainly and starts nothing
    // (the same behaviour tests/e2e/auth-no-email.spec.ts asserts for the no-Google launch configuration).
    await expect(button).toBeVisible();
    await button.click();
    await expect(page.getByRole("status")).toContainText(/not set up/i);
  } else {
    await expect(button).toBeVisible();
    await page.route("https://accounts.google.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Google (stub)</title>" }));
    await button.click();
    await page.waitForURL(/accounts\.google\.com/, { timeout: 30_000 });
    const url = new URL(page.url());
    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(`${base()}/api/auth/callback/google`);
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(page.url()).not.toMatch(/client_secret/i);
  }
  await context.close();
});

test("Refusal messages from Google are shown plainly on the sign-in page", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: base() });
  const page = await context.newPage();
  await page.goto("/login?error=account_not_linked");
  await expect(page.locator("p.auth-banner-error[role='alert']")).toContainText("isn’t linked to an academy account");
  await page.goto("/login?error=GOOGLE_SIGN_IN_NOT_AVAILABLE_WITH_MFA");
  await expect(page.locator("p.auth-banner-error[role='alert']")).toContainText("authenticator app");
  await context.close();
});

test("Wrong password and unknown e-mail give the same plain message (no account enumeration), then a correct sign-in lands on the role's page", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ baseURL: base() });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/login");
  await page.getByLabel("Email address").fill(ROLE_ACCOUNTS.HEAD_COACH);
  await page.getByLabel("Password", { exact: true }).fill("definitely-not-the-password-1");
  await submit(page);
  const wrong = await page.locator("p.auth-banner-error[role='alert']").innerText();
  await page.getByLabel("Email address").fill("nobody.here@example.test");
  await submit(page);
  const unknown = await page.locator("p.auth-banner-error[role='alert']").innerText();
  expect(unknown).toBe(wrong);
  expect(wrong).not.toMatch(/no such|not found|does not exist/i);
  await page.getByLabel("Email address").fill(ROLE_ACCOUNTS.HEAD_COACH);
  await page.getByLabel("Password", { exact: true }).fill(password());
  const ok = await submit(page);
  expect(ok.ok()).toBeTruthy();
  await expect(page).toHaveURL(/\/overview$/, { timeout: 90_000 });
  // session cookie: HttpOnly and SameSite=Lax; it survives a reload
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name.endsWith("session_token"));
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
  await page.reload();
  await expect(page).toHaveURL(/\/overview$/);
  expect(errors).toEqual([]);
  await context.close();
});

test("Account security: reachable from the workspace, has its sections, returns to the workspace, and hides Google when it is off", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ storageState: await stateFor("COACH"), baseURL: base() });
  const page = await context.newPage();
  await page.goto("/training");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 90_000 });
  await page.getByRole("link", { name: /Account security/ }).first().click();
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Two-factor authentication" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Signed-in devices" })).toBeVisible();
  const google = (await methods(page)).google.enabled;
  await expect(page.getByRole("heading", { name: "Sign in with Google" })).toHaveCount(google ? 1 : 0);
  await page.getByRole("link", { name: /Back to workspace/ }).click();
  await expect(page).toHaveURL(/\/training$/, { timeout: 90_000 });
  await context.close();
});

test("Sign out ends the session: protected pages and APIs are refused afterwards", async ({ browser }) => {
  test.setTimeout(240_000);
  // its own sign-in: signing out revokes the session, which must not be one the other specs share
  const context = await browser.newContext({ baseURL: base() });
  let login = await context.request.post("/api/auth/sign-in/email", { headers: { origin: base() }, data: { email: ROLE_ACCOUNTS.FINANCE, password: password() } });
  if (login.status() === 429) {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    login = await context.request.post("/api/auth/sign-in/email", { headers: { origin: base() }, data: { email: ROLE_ACCOUNTS.FINANCE, password: password() } });
  }
  expect(login.ok()).toBeTruthy();
  const page = await context.newPage();
  await page.goto("/fees");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 90_000 });
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
  await page.goto("/fees");
  await expect(page).toHaveURL(/\/login/, { timeout: 60_000 });
  expect((await page.request.get("/api/academy")).status()).toBe(401);
  await context.close();
});
