import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SHOTS = process.env.AUTH_UI_SHOTS ?? "";
const shot = async (page: import("@playwright/test").Page, file: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, file), fullPage: true });
};

const a11yTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test("Login page UI, password visibility toggle, validation, links, Google button, responsive and a11y", async ({
  browser,
}) => {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByText("Sportozen", { exact: true }).first()).toBeVisible();

  const email = page.getByLabel("Email address");
  const password = page.getByLabel("Password", { exact: true });
  const eye = page.getByRole("button", { name: "Show password" });
  const signIn = page.getByRole("button", { name: "Sign in" });
  const google = page.getByRole("button", { name: "Continue with Google" });

  await expect(email).toBeVisible();
  await expect(password).toHaveAttribute("type", "password");
  await expect(eye).toHaveAttribute("aria-pressed", "false");
  await expect(google).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Create an account" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Terms of Service" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Privacy Policy" }).first()).toBeVisible();
  await expect(signIn).toBeEnabled();

  await shot(page, "auth_login_desktop.png");

  // Accessibility check on desktop login
  const axeLogin = await new AxeBuilder({ page }).withTags(a11yTags).analyze();
  expect(axeLogin.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

  // Inline validation on empty submit
  await signIn.click();
  await expect(page.getByText("Enter your email address.")).toBeVisible();
  await expect(page.getByText("Enter your password.")).toBeVisible();

  // Bad email validation
  await email.fill("bad-email");
  await email.blur();
  await expect(page.getByText("Enter a valid email address, such as name@academy.com.")).toBeVisible();

  // Password eye toggle by click + keyboard
  await password.fill("SamplePassphrase123!");
  await eye.click();
  await expect(password).toHaveAttribute("type", "text");
  const hideEye = page.getByRole("button", { name: "Hide password" });
  await expect(hideEye).toHaveAttribute("aria-pressed", "true");
  await hideEye.focus();
  await page.keyboard.press("Enter");
  await expect(password).toHaveAttribute("type", "password");

  // Without Google credentials the button explains itself and starts nothing
  await google.click();
  await expect(page.getByRole("status")).toContainText(/not set up/i);

  // Navigation to Forgot password, Terms, Privacy, Signup
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();

  await page.getByRole("link", { name: "Terms of Service" }).first().click();
  await expect(page).toHaveURL(/\/terms$/);
  await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();

  await page.getByRole("link", { name: "Privacy Policy" }).first().click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();

  await page.getByRole("link", { name: "Back to sign in" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup$/);

  // Mobile layout check for /login
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mPage = await mobile.newPage();
  await mPage.goto("/login");
  await expect(mPage.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  expect(await mPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(mPage, "auth_login_mobile.png");

  expect(errors).toEqual([]);
  await mobile.close();
  await desktop.close();
});

test("Signup page UI, dual password visibility toggles, requirement guidance, confirmation check, responsive and a11y", async ({
  browser,
}) => {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Join Sportozen Academy" })).toBeVisible();
  await expect(page.locator(".auth-showcase-photo")).toHaveCount(1);
  expect(
    await page.locator(".auth-showcase-photo").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
  ).toBe(true);

  const fullName = page.getByLabel("Full name");
  const email = page.getByLabel("Email address");
  const password = page.getByLabel("Password", { exact: true });
  const confirm = page.getByLabel("Confirm password", { exact: true });
  const terms = page.getByRole("checkbox");
  const createBtn = page.getByRole("button", { name: "Create account" });
  const google = page.getByRole("button", { name: "Continue with Google" });

  await expect(password).toHaveAttribute("type", "password");
  await expect(confirm).toHaveAttribute("type", "password");
  await expect(google).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(createBtn).toBeEnabled();

  await shot(page, "auth_signup_desktop.png");

  // Accessibility check on desktop signup
  const axeSignup = await new AxeBuilder({ page }).withTags(a11yTags).analyze();
  expect(axeSignup.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

  // Empty submit validation
  await createBtn.click();
  await expect(page.getByText("Enter your full name.")).toBeVisible();
  await expect(page.getByText("Enter your email address.")).toBeVisible();
  await expect(page.getByText("Create a password.")).toBeVisible();
  await expect(page.getByText("Confirm your password.")).toBeVisible();
  await expect(page.getByText("Accept the Terms of Service and Privacy Policy to continue.")).toBeVisible();

  // Password strength progression: weak -> strong
  await fullName.fill("Priya Mehta");
  await email.fill(`priya.${Date.now()}@greenfield.example`);
  await password.fill("Sportozen12345");
  await expect(page.locator("#signup-password-strength")).toHaveAttribute("data-strength", "weak");
  await expect(page.locator("#signup-password-strength")).toContainText("Weak");

  const strong = "cobalt-meadow-orbit-94";
  await password.fill(strong);
  await expect(page.locator("#signup-password-strength")).toHaveAttribute("data-strength", "strong");
  await expect(page.locator("#signup-password-strength")).toContainText("Strong");

  await confirm.fill("different-passphrase-12");
  await confirm.blur();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();

  await page.getByRole("button", { name: "Show password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(confirm).toHaveAttribute("type", "password");

  await page.getByRole("button", { name: "Show confirm password" }).click();
  await expect(confirm).toHaveAttribute("type", "text");

  await page.getByRole("button", { name: "Hide password" }).click();
  await page.getByRole("button", { name: "Hide confirm password" }).click();
  await expect(password).toHaveAttribute("type", "password");
  await expect(confirm).toHaveAttribute("type", "password");

  // Google sign-up needs the terms first; without credentials it explains itself and starts nothing
  await confirm.fill(strong);
  await terms.uncheck();
  await google.click();
  await expect(page.getByText("Accept the Terms of Service and Privacy Policy to continue.")).toBeVisible();
  await terms.check();
  await google.click();
  await expect(page.getByRole("status")).toContainText(/not set up/i);

  // A real signup needs no email: the account is created at once (unassigned, unverified), no session starts, and the
  // person is sent to sign in. Neither the password nor the address is placed in the URL.
  await createBtn.click();
  await expect(page).toHaveURL(/\/login\?created=1$/);
  expect(page.url()).not.toContain("priya");
  expect(page.url()).not.toContain(strong);
  await expect(page.getByRole("status")).toContainText(/account was created/i);
  const afterSignup = await page.request.get("/api/auth/get-session");
  expect(await afterSignup.json()).toBeNull();

  // Mobile layout check for /signup
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mPage = await mobile.newPage();
  await mPage.goto("/signup");
  await expect(mPage.getByRole("heading", { name: "Join Sportozen Academy" })).toBeVisible();
  expect(await mPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(mPage, "auth_signup_mobile.png");

  expect(errors).toEqual([]);
  await mobile.close();
  await desktop.close();
});

test("before the page has hydrated, pressing Enter in a credential form puts nothing in the URL", async ({ browser }) => {
  // JavaScript off = the page as it is before React attaches its handlers. A native submit of a method-less form is a GET.
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const secret = "Plain-Text-Secret-9876";
  for (const [path, fields] of [
    ["/login", [["#login-email", "leak.check@example.test"], ["#login-password", secret]]],
    ["/signup", [["#signup-name", "Leak Check"], ["#signup-email", "leak.check@example.test"], ["#signup-password", secret], ["#signup-confirm", secret]]],
    ["/forgot-password", [["#reset-email", "leak.check@example.test"]]],
    ["/verify-email", [["#verify-digit-1", "4"], ["#verify-digit-2", "8"], ["#verify-digit-3", "2"]]],
  ] as const) {
    await page.goto(path);
    for (const [selector, value] of fields) await page.fill(selector, value);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const url = page.url();
    expect(url, path).not.toContain("?");
    expect(url, path).not.toContain(secret);
    expect(url, path).not.toContain("leak.check");
    // the submit button is disabled until the page hydrates, so Enter did not submit anything
    await expect(page.locator("form button[type=submit]").first(), path).toBeDisabled();
  }
  await context.close();
});
