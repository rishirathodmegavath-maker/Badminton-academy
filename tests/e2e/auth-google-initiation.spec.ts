import { test, expect, type Page } from "@playwright/test";
import { configured } from "./support/profile";

/**
 * "Continue with Google" in a real browser, up to the moment the browser leaves for Google. Runs only against a server
 * that has GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET set (a disposable one with FAKE credentials is enough: nothing
 * here talks to Google, the navigation to accounts.google.com is intercepted and inspected). It does NOT prove a real
 * Google round trip; that needs real credentials and a real Google account.
 */
test.beforeEach(async ({ request }) => {
  const methods = await (await request.get("/api/auth/account/sign-in-methods")).json();
  configured(!!methods?.google?.enabled, "this server has no Google credentials");
});

/** Click the Google button and capture the authorization URL the browser is sent to (Google itself is never reached). */
async function startGoogle(page: Page, expectedPostBody: (b: Record<string, unknown>) => void) {
  let authUrl: URL | null = null;
  await page.route("https://accounts.google.com/**", async (route) => {
    authUrl = new URL(route.request().url());
    await route.fulfill({ status: 200, contentType: "text/html", body: "<title>stub google</title>stub" });
  });
  const posted = page.waitForRequest((r) => r.url().endsWith("/api/auth/sign-in/social"));
  await page.getByRole("button", { name: "Continue with Google" }).click();
  expectedPostBody((await posted).postDataJSON());
  await expect.poll(() => authUrl !== null).toBe(true);
  return authUrl as unknown as URL;
}

test("login: the button starts Google OAuth with our client id, the registered redirect URI, state and PKCE, and no secret", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/login");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeEnabled();

  const url = await startGoogle(page, (body) => {
    // Sign-in may only sign in: it never asks Google to create an account.
    expect(body).toMatchObject({ provider: "google", requestSignUp: false, errorCallbackURL: "/login" });
    expect(body.additionalData).toBeUndefined();
  });
  expect(url.host).toBe("accounts.google.com");
  expect(url.searchParams.get("client_id")).toBe("fake-browser-test.apps.googleusercontent.com");
  expect(url.searchParams.get("redirect_uri")).toBe(`${baseURL}/api/auth/callback/google`);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("scope")).toMatch(/openid/);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("state")).toBeTruthy();
  expect(url.search).not.toContain("secret");
  expect(errors).toEqual([]);
});

test("signup: the terms must be accepted first, then Google is asked to sign up with the terms recorded server-side", async ({ page, baseURL }) => {
  await page.goto("/signup");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(page.getByText(/terms/i).first()).toBeVisible();
  expect(page.url()).toContain("/signup");

  await page.getByRole("checkbox").check();
  const url = await startGoogle(page, (body) => {
    expect(body).toMatchObject({ provider: "google", requestSignUp: true, errorCallbackURL: "/signup" });
    expect(body.additionalData).toMatchObject({ termsAccepted: true });
  });
  expect(url.searchParams.get("redirect_uri")).toBe(`${baseURL}/api/auth/callback/google`);
});

test("coming back on a different address (the localhost / 127.0.0.1 trap) is explained instead of failing silently", async ({ page, context }) => {
  await page.goto("/login");
  const url = await startGoogle(page, () => undefined);
  // The state cookie belongs to the address the flow began on; a different address does not send it.
  await context.clearCookies();
  await page.goto(`/api/auth/callback/google?code=stub&state=${url.searchParams.get("state")}`);
  await expect(page).toHaveURL(/\/login\?error=state_mismatch/);
  await expect(page.locator(".auth-banner-error")).toContainText(/same web address/i);
  expect(await (await page.request.get("/api/auth/get-session")).json()).toBeNull();
});
