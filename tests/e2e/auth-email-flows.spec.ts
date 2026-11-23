import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { hashPassword } from "better-auth/crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configured } from "./support/profile";
import { withDisposableDatabase } from "./support/database";

/**
 * Account email in a real browser: the verification code and the password-reset link. Runs ONLY under profile "email"
 * (scripts/lib/e2e-profiles.ts): a development-mode disposable server whose authentication email provider is the test provider.
 * Nothing is sent to anyone; each message is written to the capture file and read back here.
 */
const SHOTS = process.env.AUTH_UI_SHOTS ?? "";
const shot = async (page: Page, file: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, file), fullPage: true });
};
const a11yTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

// Moved here unchanged from auth-ui.spec.ts, apart from its precondition (it used to skip itself on any server without a mail provider).
test("Verify email 6-digit flow and Reset password UI, validation, responsive and a11y", async ({
  browser,
  request,
}) => {
  // This flow is the EMAIL-enabled configuration ("a new code is on its way"). A server with no mail provider answers 503
  // SIGNUP_UNAVAILABLE by design (that launch configuration is covered by auth-no-email.spec.ts). Profile "email" starts the
  // server with the test email provider (messages are captured to a file, nothing is sent), and this test now REQUIRES it:
  // on any other server it fails with a clear message instead of skipping.
  const methods = await (await request.get("/api/auth/account/sign-in-methods")).json();
  configured(!!methods?.passwordReset?.enabled, "a server whose authentication email provider is the test provider (profile \"email\")");
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // Verify Email 6-digit UI (the address comes from this tab's session storage, never from the URL)
  await page.goto("/verify-email");
  await page.evaluate(() => sessionStorage.setItem("sportozen.pendingEmail", "priya@greenfield.example"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await expect(page.getByText("priya@greenfield.example")).toBeVisible();

  const axeVerify = await new AxeBuilder({ page }).withTags(a11yTags).analyze();
  expect(axeVerify.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

  const verifyBtn = page.getByRole("button", { name: "Verify email" });
  await verifyBtn.click();
  await expect(page.getByText("Enter the 6-digit verification code.")).toBeVisible();

  // Multi-digit input distribution into all 6 boxes
  await page.getByLabel("Verification code digit 1 of 6").fill("482910");
  await expect(page.getByLabel("Verification code digit 6 of 6")).toHaveValue("0");

  // The password is re-entered and confirmed on this screen too: without it nothing is sent
  await verifyBtn.click();
  await expect(page.locator("#verify-password-error")).toBeVisible();
  await expect(page.locator("#verify-confirm-password-error")).toBeVisible();
  await page.locator("#verify-password").fill("cobalt-meadow-orbit-94");
  await page.locator("#verify-confirm-password").fill("cobalt-meadow-orbit-95");
  await verifyBtn.click();
  await expect(page.locator("#verify-confirm-password-error")).toContainText(/do not match/i);
  await page.locator("#verify-confirm-password").fill("cobalt-meadow-orbit-94");
  await shot(page, "auth_verify_email_desktop.png");

  // A wrong code is refused by the server, and the boxes are cleared for another try
  await verifyBtn.click();
  await expect(page.locator(".auth-banner-error").filter({ hasText: /invalid or has expired/i })).toBeVisible();
  await expect(page).toHaveURL(/\/verify-email$/);
  await expect(page.getByLabel("Verification code digit 1 of 6")).toHaveValue("");

  await page.getByRole("button", { name: "Resend verification code" }).click();
  await expect(page.getByRole("status")).toContainText(/new code is on its way/i);
  await expect(page.getByRole("button", { name: /Resend available in/ })).toBeDisabled();

  // Forgot Password: the same words whether or not the address has an account
  await page.goto("/forgot-password");
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeEnabled({ timeout: 90_000 }); // enabled once React has attached its handlers
  await page.getByLabel("Email address").fill("priya@greenfield.example");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText(/If an account with a verified email address exists/i);

  // Reset Password: the token is taken from the URL fragment and removed from the address bar
  await page.goto("/reset-password#token=00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await expect(page.getByRole("heading", { name: "Create a new password" })).toBeVisible();
  await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
  expect(page.url()).not.toContain("token");

  const axeReset = await new AxeBuilder({ page }).withTags(a11yTags).analyze();
  expect(axeReset.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);

  const newPass = page.getByLabel("New password", { exact: true });
  const confirmPass = page.getByLabel("Confirm new password", { exact: true });
  await newPass.fill("cobalt-meadow-orbit-94");
  await expect(page.locator("#reset-password-strength")).toHaveAttribute("data-strength", "strong");
  await page.getByRole("button", { name: "Show new password" }).click();
  await expect(newPass).toHaveAttribute("type", "text");
  await confirmPass.fill("cobalt-meadow-orbit-94");
  await shot(page, "auth_reset_password_desktop.png");

  // A forged link is refused the same way as an expired one
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.locator(".auth-banner-error")).toContainText(/invalid or has expired/i);
  await expect(page.getByRole("link", { name: "Request a new link" })).toBeVisible();

  // Mobile overflow checks for /verify-email and /reset-password
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mPage = await mobile.newPage();
  await mPage.goto("/verify-email");
  expect(await mPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await mPage.goto("/reset-password");
  expect(await mPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  expect(errors).toEqual([]);
  await mobile.close();
  await desktop.close();
});

/**
 * The real flows, with the real server and database. The only stand-in is the mail provider: the app composes, seals, queues and
 * "sends" each message through its own outbox, and the test provider appends it to the capture file (AUTH_EMAIL_CAPTURE_FILE) instead
 * of delivering it. The spec reads the code or link out of that file, exactly as a person would read their mailbox.
 *
 * Accounts are planted in the profile's disposable database, because a public signup no longer creates an account that is waiting
 * for a code (see onboarding.ts); a person in that state can still exist (an older account), and this is the screen they use.
 * Codes and links are made to expire by moving their expiry in the database: waiting ten minutes would be a fixed delay, and a
 * test clock does not exist in the app. Everything is synchronised on the capture file or on the screen, never on a pause.
 *
 * Sign-in attempts are rate limited to 5 a minute per client. This spec signs in 3 times in total and the limit is not touched.
 */
test.describe.configure({ mode: "serial" });

type Captured = { at: string; kind: "EMAIL_VERIFICATION_OTP" | "PASSWORD_RESET_LINK"; to: string; subject: string; text: string; idempotencyKey: string };
const captureFile = () => process.env.AUTH_EMAIL_CAPTURE_FILE!;
const captured = (): Captured[] =>
  existsSync(captureFile()) ? readFileSync(captureFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Captured) : [];
/** The n-th message of this kind to this address, once it has been "sent" (polls the capture file; no fixed delay). */
async function mailTo(email: string, kind: Captured["kind"], nth = 1) {
  await expect
    .poll(() => captured().filter((m) => m.to === email && m.kind === kind).length, { message: `message ${nth} (${kind}) to ${email}`, timeout: 60_000 })
    .toBeGreaterThanOrEqual(nth);
  return captured().filter((m) => m.to === email && m.kind === kind)[nth - 1];
}
const codeIn = (m: Captured) => /verification code is (\d{6})\./.exec(m.text)![1];
const linkIn = (m: Captured) => /(https?:\/\/\S+\/reset-password#token=\S+)/.exec(m.text)![1];
const wrongCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");

const planted: string[] = [];
/** The UI test above asks for a reset link for a seeded, verified family account, which the app really does queue. */
const SEEDED_RECIPIENTS = ["priya@greenfield.example"];
const OLD_PASSWORD = "Planted-Before-Reset-7531";
const NEW_PASSWORD = "cobalt-meadow-orbit-94";
let counter = 0;
async function plantAccount(input: { verified: boolean }) {
  const id = crypto.randomUUID();
  const email = `e2e.${input.verified ? "reset" : "verify"}.${Date.now().toString(36)}.${++counter}@example.test`;
  const hash = await hashPassword(OLD_PASSWORD);
  await withDisposableDatabase(async (db) => {
    await db.query(
      `insert into app_user (id, name, email, email_verified, email_verification_required, terms_accepted_at, terms_version)
       values ($1, 'Test Person', $2, $3, $4, now(), '2026-11-12')`,
      [id, email, input.verified, !input.verified],
    );
    await db.query(
      `insert into auth_account (id, account_id, provider_id, user_id, password) values ($1, $2, 'credential', $2, $3)`,
      [crypto.randomUUID(), id, hash],
    );
  });
  planted.push(email);
  return { id, email };
}
const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]) =>
  withDisposableDatabase(async (db) => (await db.query<T>(sql, params)).rows[0]);
/** Moves an expiry into the past. A timestamp without a zone: the ISO text is read as UTC, as the app stores it. */
const expire = (sql: string, params: unknown[]) =>
  withDisposableDatabase((db) => db.query(sql, [new Date(Date.now() - 60_000).toISOString(), ...params]));

async function openVerify(page: Page, email: string) {
  await page.goto("/verify-email");
  await page.evaluate((e) => sessionStorage.setItem("sportozen.pendingEmail", e), email);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Verify your email" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resend verification code" })).toBeEnabled();
}
async function submitVerification(page: Page, code: string, password: string) {
  await page.getByLabel("Verification code digit 1 of 6").fill(code);
  await page.locator("#verify-password").fill(password);
  await page.locator("#verify-confirm-password").fill(password);
  await page.getByRole("button", { name: "Verify email" }).click();
}
async function signInThroughTheForm(page: Page, email: string, password: string) {
  await page.goto("/login");
  const signIn = page.getByRole("button", { name: "Sign in", exact: true });
  await expect(signIn).toBeEnabled({ timeout: 90_000 }); // the form enables it once React has attached its handlers
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await signIn.click();
}

test("verification: the code is mailed (captured), a wrong code is refused, the right code verifies, and the account then signs in", async ({ browser, request }) => {
  const { email, id } = await plantAccount({ verified: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openVerify(page, email);

  await page.getByRole("button", { name: "Resend verification code" }).click();
  await expect(page.getByRole("status")).toContainText(/new code is on its way/i);
  const mail = await mailTo(email, "EMAIL_VERIFICATION_OTP");
  const code = codeIn(mail);
  expect(mail.subject).toBe("Your Sportozen verification code");
  expect(mail.text).toContain("expires in 10 minutes");
  expect(code).toMatch(/^\d{6}$/);

  // A wrong code: refused, the boxes are cleared, the account stays unverified and the real code is still good.
  await submitVerification(page, wrongCode(code), NEW_PASSWORD);
  await expect(page.locator(".auth-banner-error").filter({ hasText: /invalid or has expired/i })).toBeVisible();
  await expect(page).toHaveURL(/\/verify-email$/);
  await expect(page.getByLabel("Verification code digit 1 of 6")).toHaveValue("");
  expect((await one<{ email_verified: boolean }>("select email_verified from app_user where id = $1", [id])).email_verified).toBe(false);

  // The right code, with the password chosen on this screen: the account is verified and the person is sent to sign in.
  await submitVerification(page, code, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/login\?verified=1$/);
  await expect(page.getByText("Your email is verified. Sign in to continue.")).toBeVisible();
  expect((await one<{ email_verified: boolean }>("select email_verified from app_user where id = $1", [id])).email_verified).toBe(true);
  expect((await one<{ n: string }>("select count(*)::text n from auth_verification where identifier = $1", [`email-otp:${email}`])).n, "the code is spent").toBe("0");
  const sent = await one<{ status: string; sealed_payload: string | null }>("select status, sealed_payload from auth_email_outbox where user_id = $1", [id]);
  expect(sent.status).toBe("SENT");
  expect(sent.sealed_payload, "the secret is wiped from the database once handed over").toBeNull();

  // The password chosen on the verify screen is the one that works; the planted one no longer does.
  await signInThroughTheForm(page, email, NEW_PASSWORD);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 90_000 });
  const old = await request.post("/api/auth/sign-in/email", { headers: { origin: process.env.E2E_BASE_URL! }, data: { email, password: OLD_PASSWORD } });
  expect(old.ok()).toBe(false);
  expect(errors).toEqual([]);
  await context.close();
});

test("verification: an expired code is refused with the same words as a wrong one, the account stays unverified, and a new code recovers it", async ({ browser }) => {
  const { email, id } = await plantAccount({ verified: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await openVerify(page, email);
  await page.getByRole("button", { name: "Resend verification code" }).click();
  const first = codeIn(await mailTo(email, "EMAIL_VERIFICATION_OTP", 1));

  // Ten minutes pass: the code's expiry moves into the past.
  await expire("update auth_verification set expires_at = $1::timestamp where identifier = $2", [`email-otp:${email}`]);
  await submitVerification(page, first, NEW_PASSWORD);
  await expect(page.locator(".auth-banner-error").filter({ hasText: /invalid or has expired/i })).toBeVisible();
  expect((await one<{ email_verified: boolean }>("select email_verified from app_user where id = $1", [id])).email_verified).toBe(false);

  // A new code is allowed once the one-minute cooldown between mails has passed (its clock is the previous mail's creation time).
  await withDisposableDatabase((db) => db.query("update auth_email_outbox set created_at = created_at - interval '1 hour' where user_id = $1", [id]));
  await openVerify(page, email); // a reload also ends this screen's own resend countdown
  await page.getByRole("button", { name: "Resend verification code" }).click();
  const second = codeIn(await mailTo(email, "EMAIL_VERIFICATION_OTP", 2));
  await submitVerification(page, second, NEW_PASSWORD);
  await expect(page).toHaveURL(/\/login\?verified=1$/);
  expect((await one<{ email_verified: boolean }>("select email_verified from app_user where id = $1", [id])).email_verified).toBe(true);
  await context.close();
});

test("password reset: the link is mailed (captured), opens the form, sets a new password, works once, and the old password stops working", async ({ browser, request }) => {
  const { email, id } = await plantAccount({ verified: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/forgot-password");
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeEnabled({ timeout: 90_000 }); // enabled once React has attached its handlers
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText(/If an account with a verified email address exists/i);

  const mail = await mailTo(email, "PASSWORD_RESET_LINK");
  const link = linkIn(mail);
  expect(mail.subject).toBe("Reset your Sportozen password");
  expect(new URL(link).origin).toBe(new URL(process.env.E2E_BASE_URL!).origin);
  expect(new URL(link).search, "the token rides in the fragment, never in a query string").toBe("");

  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Create a new password" })).toBeVisible();
  expect(page.url(), "the token is removed from the address bar").not.toContain("token");
  await expect(page.getByRole("button", { name: "Update password" })).toBeEnabled({ timeout: 90_000 }); // enabled once React has attached its handlers
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page).toHaveURL(/\/login\?reset=1$/);
  await expect(page.getByText("Your password was updated. Sign in with the new password.")).toBeVisible();
  expect((await one<{ n: string }>("select count(*)::text n from auth_verification where identifier = $1", [`password-reset:${id}`])).n, "the link is spent").toBe("0");

  await signInThroughTheForm(page, email, NEW_PASSWORD);
  await expect(page).not.toHaveURL(/\/login/, { timeout: 90_000 });
  const old = await request.post("/api/auth/sign-in/email", { headers: { origin: process.env.E2E_BASE_URL! }, data: { email, password: OLD_PASSWORD } });
  expect(old.ok(), "the planted password no longer works").toBe(false);

  // The same link a second time: single use.
  const again = await context.newPage();
  await again.goto(link);
  await expect(again.getByRole("button", { name: "Update password" })).toBeEnabled({ timeout: 90_000 }); // enabled once React has attached its handlers
  await again.getByLabel("New password", { exact: true }).fill("another-quiet-harbour-58");
  await again.getByLabel("Confirm new password", { exact: true }).fill("another-quiet-harbour-58");
  await again.getByRole("button", { name: "Update password" }).click();
  await expect(again.locator(".auth-banner-error")).toContainText(/invalid or has expired/i);
  expect(errors).toEqual([]);
  await context.close();
});

test("password reset: a tampered link and an expired link are refused, offer a new link, and change nothing", async ({ browser }) => {
  const { email, id } = await plantAccount({ verified: true });
  const before = (await one<{ password: string }>("select password from auth_account where user_id = $1 and provider_id = 'credential'", [id])).password;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto("/forgot-password");
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeEnabled({ timeout: 90_000 }); // enabled once React has attached its handlers
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  const link = linkIn(await mailTo(email, "PASSWORD_RESET_LINK"));

  // One fresh page per attempt: two links that differ only in their #fragment would otherwise be a same-document navigation,
  // and the page would keep the "link invalid" state of the first attempt instead of showing the form again.
  const attempt = async (target: string) => {
    const tab = await context.newPage();
    await tab.goto(target);
    await expect(tab.getByRole("heading", { name: "Create a new password" })).toBeVisible();
    await expect(tab.getByRole("button", { name: "Update password" })).toBeEnabled({ timeout: 90_000 }); // enabled once React has attached its handlers
    await tab.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
    await tab.getByLabel("Confirm new password", { exact: true }).fill(NEW_PASSWORD);
    await tab.getByRole("button", { name: "Update password" }).click();
    await expect(tab.locator(".auth-banner-error")).toContainText(/invalid or has expired/i);
    await expect(tab.getByRole("link", { name: "Request a new link" })).toBeVisible();
    await tab.close();
  };
  // Tampered: the last character of the secret part changed.
  await attempt(link.slice(0, -1) + (link.endsWith("A") ? "B" : "A"));
  // Expired: the genuine link, thirty minutes on.
  await expire("update auth_verification set expires_at = $1::timestamp where identifier = $2", [`password-reset:${id}`]);
  await attempt(link);
  const after = (await one<{ password: string }>("select password from auth_account where user_id = $1 and provider_id = 'credential'", [id])).password;
  expect(after, "no refusal changed the password").toBe(before);
  await context.close();
});

test("every message the app tried to send went to an account this spec planted, and only into the capture file", async () => {
  const mails = captured();
  expect(mails.length).toBeGreaterThanOrEqual(4);
  for (const m of mails) expect([...planted, ...SEEDED_RECIPIENTS], `unexpected recipient ${m.to.replace(/^[^@]*/, "***")}`).toContain(m.to);
  for (const m of mails) expect(["EMAIL_VERIFICATION_OTP", "PASSWORD_RESET_LINK"]).toContain(m.kind);
});
