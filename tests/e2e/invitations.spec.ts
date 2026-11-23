import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { configured } from "./support/profile";

/**
 * Academy invitations in a real browser. Runs against a DISPOSABLE seeded server (npm run db:seed) with no mail provider.
 * E2E_SEED_PASSWORD is the DEV_SEED_PASSWORD that server was seeded with. The seeded Greenfield owner has no authenticator.
 */
const PASSWORD = process.env.E2E_SEED_PASSWORD ?? "";
const GREEN = "Greenfield Badminton Academy";
const BLUE = "Bluebird Badminton Academy";
const GREEN_OWNER = "admin@greenfield.example";
const BLUE_OWNER = "admin@bluebird.example";

test.describe.configure({ mode: "serial" });
test.beforeEach(async ({ request }) => {
  configured(!!PASSWORD, "E2E_SEED_PASSWORD is not set");
  configured((await request.get("/api/auth/account/sign-in-methods")).ok(), "no server");
});

/** Signs in through the API into the context (the sign-in endpoint is rate limited; a 429 waits out the window). */
async function apiLogin(context: BrowserContext, email: string, password = PASSWORD) {
  const base = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:3480").origin;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await context.request.post("/api/auth/sign-in/email", { headers: { origin: base }, data: { email, password }, timeout: 60_000 });
    if (r.ok()) return;
    if (r.status() !== 429) throw new Error(`sign-in for ${email}: HTTP ${r.status()}`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error("sign-in stayed rate limited");
}
async function actor(browser: import("@playwright/test").Browser, email: string) {
  const context = await browser.newContext();
  await apiLogin(context, email);
  return { context, page: await context.newPage() };
}
/** Settings -> Invitations as the signed-in owner; creates an invitation and returns the one-time link. */
async function invite(page: Page, email: string, form: { kind?: string; role?: string } = {}) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await page.getByRole("button", { name: "Invitations", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Invitations/ }).first()).toBeVisible();
  if (form.kind) await page.getByRole("combobox", { name: "Kind of invitation" }).selectOption(form.kind);
  if (form.role) await page.getByRole("combobox", { name: "Role", exact: true }).selectOption(form.role);
  await page.getByLabel("Their email address").fill(email);
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = page.getByLabel("Invitation link");
  await expect(link).toBeVisible();
  const value = await link.inputValue();
  expect(value).toMatch(/\/invite#[A-Za-z0-9_-]{43}$/);
  return value;
}
const stamp = () => `${Date.now()}`;
const MEMBER_PASSWORD = "cobalt-meadow-orbit-94-mem";
/** A fresh COACH login in Greenfield (the Greenfield owner creates it), so every run starts from its own account. */
async function freshMember(browser: import("@playwright/test").Browser) {
  const email = `member.${stamp()}.${Math.floor(Math.random() * 1e6)}@example.test`;
  const owner = await actor(browser, GREEN_OWNER);
  const base = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:3480").origin;
  const r = await owner.context.request.post("/api/academy/settings/member", {
    headers: { origin: base },
    data: { name: "Existing Member", email, role: "COACH", active: true, professionalAttestation: "", initialPassword: MEMBER_PASSWORD },
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  await owner.context.close();
  return email;
}
/** The member signs in and replaces nothing: an owner-issued temporary password must be changed first, so clear that gate. */
async function memberSession(browser: import("@playwright/test").Browser, email: string) {
  const context = await browser.newContext();
  await apiLogin(context, email, MEMBER_PASSWORD);
  const base = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:3480").origin;
  const next = `cobalt-meadow-orbit-94-new-${stamp()}`;
  const changed = await context.request.post("/api/auth/account/change-password", {
    headers: { origin: base },
    data: { currentPassword: MEMBER_PASSWORD, newPassword: next },
  });
  expect(changed.ok(), await changed.text()).toBeTruthy();
  return { context, page: await context.newPage() };
}

test("a new person: the owner invites an address, the invitee follows the link, creates an account (no email needed), is returned to the invitation, accepts, and lands in the academy", async ({ browser }) => {
  const errors: string[] = [];
  const owner = await actor(browser, GREEN_OWNER);
  owner.page.on("pageerror", (e) => errors.push(e.message));
  const address = `new.${stamp()}@example.test`;
  const link = await invite(owner.page, address, { role: "FINANCE" });
  await expect(owner.page.getByRole("row", { name: new RegExp(address) })).toContainText("Pending");
  await owner.context.close();

  // The invitee has no account yet: nothing is signed in, and the page says what is being offered.
  const guest = await browser.newContext();
  const page = await guest.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(link);
  await expect(page.getByRole("heading", { name: GREEN })).toBeVisible();
  await expect(page.getByText(/as finance/i).first()).toBeVisible();
  expect(page.url()).not.toContain("#"); // the token left the address bar
  expect(page.url()).toMatch(/\/invite$/);
  await expect(page.locator("dd", { hasText: /^n\*+@example\.test$/ })).toBeVisible(); // masked address
  await expect(page.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);

  // Create the account, then sign in: the sign-in resumes the invitation instead of dropping the person at the workspace.
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup/);
  const password = "cobalt-meadow-orbit-94-inv";
  await page.getByLabel("Full name").fill("Invited Person");
  await page.getByLabel("Email address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/login\?created=1/);
  await page.getByLabel("Email address").fill(address);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/invite$/);
  await expect(page.getByRole("heading", { name: GREEN })).toBeVisible();
  // Not a member until the explicit click.
  expect((await page.request.get("/api/academy/identity")).status()).toBe(403);
  await page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(page.getByRole("heading", { name: "You have joined" })).toBeVisible();
  await page.getByRole("button", { name: "Open the academy" }).click();
  await expect(page.locator(".ax-academy strong")).toHaveText(GREEN);
  expect(((await (await page.request.get("/api/academy/identity")).json()) as { role: string }).role).toBe("FINANCE");

  // The link is dead for everybody now.
  const again = await guest.newPage();
  await again.goto(link);
  await expect(again.getByText(/already been accepted/i)).toBeVisible();
  expect(errors).toEqual([]);
  await guest.close();
});

test("an existing account joins a second academy by accepting, keeps the first, and switches between them without signing out", async ({ browser }) => {
  const email = await freshMember(browser);
  const blueOwner = await actor(browser, BLUE_OWNER);
  const link = await invite(blueOwner.page, email, { role: "FINANCE" });
  await blueOwner.context.close();

  const member = await memberSession(browser, email);
  await member.page.goto(link);
  await expect(member.page.getByRole("heading", { name: BLUE })).toBeVisible();
  await expect(member.page.getByText(new RegExp(`Signed in as .*${email.replace(/[.]/g, "\.")}`))).toBeVisible();
  await member.page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(member.page.getByRole("heading", { name: "You have joined" })).toBeVisible();
  await member.page.getByRole("button", { name: "Open the academy" }).click();
  await expect(member.page.locator(".ax-academy strong")).toHaveText(BLUE);

  // two academies now: the account menu offers the switch, and the first academy is intact
  await member.page.locator(".ax-account-button").click();
  await member.page.getByRole("button", { name: "Switch academy" }).click();
  const options = member.page.getByRole("list", { name: "Your academies" }).getByRole("button");
  await expect(options).toHaveCount(2);
  await options.filter({ hasText: GREEN }).click();
  await expect(member.page.locator(".ax-academy strong")).toHaveText(GREEN);
  expect(((await (await member.page.request.get("/api/academy/identity")).json()) as { role: string }).role).toBe("COACH");
  await member.context.close();
});

test("a withdrawn invitation, and the wrong account, are explained and grant nothing", async ({ browser }) => {
  const owner = await actor(browser, GREEN_OWNER);
  const address = `withdrawn.${stamp()}@example.test`;
  const link = await invite(owner.page, address, { role: "COACH" });
  owner.page.once("dialog", (d) => void d.accept());
  await owner.page.getByRole("row", { name: new RegExp(address) }).getByRole("button", { name: "Withdraw" }).click();
  await expect(owner.page.getByRole("row", { name: new RegExp(address) })).toContainText("Withdrawn");
  const second = await invite(owner.page, `wrong.${stamp()}@example.test`, { role: "COACH" });
  await owner.context.close();

  const strangerEmail = await freshMember(browser);
  const stranger = await memberSession(browser, strangerEmail);
  await stranger.page.goto(link);
  await expect(stranger.page.getByText(/withdrawn by the academy/i)).toBeVisible();
  await expect(stranger.page.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);
  await stranger.page.goto(second);
  await stranger.page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(stranger.page.locator(".auth-banner-error")).toContainText(/different email address/i);
  expect(((await (await stranger.page.request.get("/api/auth/account/academies")).json()) as { academies: unknown[] }).academies.length).toBe(1);
  await stranger.context.close();
});

test("a link that is not an invitation shows a clear error and no academy", async ({ page }) => {
  await page.goto("/invite");
  await expect(page.locator(".auth-banner-error")).toContainText(/needs an invitation link/i);
  await page.goto(`/invite#${"A".repeat(43)}`);
  await expect(page.locator(".auth-banner-error")).toContainText(/not valid/i);
});
