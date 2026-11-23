import { test, expect } from "@playwright/test";

/**
 * Runs against a DISPOSABLE instance started with NO mail provider (no EMAIL_PROVIDER, RESEND_API_KEY,
 * ZEPTOMAIL_TOKEN or EMAIL_FROM). Signing up and signing in must work in a browser exactly as with email; only
 * password recovery by email reports itself as unavailable.
 */
/**
 * PRECONDITION (fails loudly instead of passing or failing by accident): this spec describes the launch configuration with no
 * mail provider and no Google credentials. `next start` reads `.env.local`, so run it against a server started by
 * `npx tsx scripts/e2e-server.ts --profile plain` (scripts/lib/e2e-server-env.ts), which pins those settings and never reads the
 * developer's. A server that has Google credentials is the wrong server for this spec, not a reason to weaken it.
 */
test.beforeAll(async ({ request }) => {
  const methods = await (await request.get("/api/auth/account/sign-in-methods")).json();
  expect(
    methods?.google?.enabled,
    "this spec needs a server WITHOUT Google credentials: start it with `npx tsx scripts/e2e-server.ts --profile plain`",
  ).toBe(false);
});

test("without an email provider: signup works, shows no 'email not set up' warning, and the new account signs in; forgot-password says email is unavailable", async ({
  page,
}) => {
  const email = `no.mail.${Date.now()}@example.test`;
  const password = "cobalt-meadow-orbit-94";
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Signup is not disabled and carries no warning about email delivery.
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Join Sportozen Academy" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account" })).toBeEnabled();
  await expect(page.getByText(/email delivery is not set up/i)).toHaveCount(0);
  await expect(page.getByText(/not available right now/i)).toHaveCount(0);

  await page.getByLabel("Full name").fill("No Mail Person");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();

  // No verification step: straight to sign-in, nothing sensitive in the URL, and no session was started.
  await expect(page).toHaveURL(/\/login\?created=1$/);
  expect(page.url()).not.toContain("no.mail");
  expect(page.url()).not.toContain(password);
  expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();
  await expect(page.getByRole("status")).toContainText(/account was created/i);

  // The new account signs in with email + password. It is unassigned, so the application says so.
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Phase 2 (multi-academy): an account with no academy is taken to the "not part of an academy yet" screen, which says so.
  await expect(page).toHaveURL(/\/academies$/);
  await expect(page.getByRole("heading", { name: "Create your academy" })).toBeVisible();
  await expect(page.getByRole("form", { name: "Create your academy" })).toBeVisible();
  const session = await (await page.request.get("/api/auth/get-session")).json();
  expect(session?.user?.email).toBe(email);
  expect(session?.user?.emailVerified).toBe(false);
  const identity = await page.request.get("/api/academy/identity");
  expect(identity.status()).toBe(403);
  expect((await identity.json()).code).toBe("NO_MEMBERSHIP");

  // Password recovery is the one thing that needs email, and the screen says so.
  const context = page.context();
  await context.clearCookies();
  await page.goto("/forgot-password");
  await expect(page.getByText(/Password reset by email is not available right now/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeDisabled();

  // And Google is honest about not being configured here, without blocking anything else.
  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByRole("status")).toContainText(/not set up/i);
  expect(errors).toEqual([]);
});
