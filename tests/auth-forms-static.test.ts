import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repoPath } from "./helpers/paths";

/**
 * Credential forms must never put a password or a code in the address bar. Before React attaches its handlers
 * a native submit of a form without `method="post"` is a GET: the fields become a query string (browser history,
 * proxy and server logs, Referer). Every form that carries a credential must therefore (1) say method="post",
 * (2) keep its submit button disabled until the page has hydrated, which also blocks Enter-to-submit, and
 * (3) never be handed an address or code through the URL.
 */
const PAGES = [
  "src/app/login/page.tsx",
  "src/app/signup/page.tsx",
  "src/app/verify-email/page.tsx",
  "src/app/forgot-password/page.tsx",
  "src/app/reset-password/page.tsx",
];
const source = (path: string) => readFileSync(repoPath(path), "utf8");

for (const page of PAGES)
  test(`${page}: every <form> is method="post", submit waits for hydration, no credential in a URL`, () => {
    const text = source(page);
    const forms = [...text.matchAll(/<form\b[^>]*>/g)].map((m) => m[0]);
    assert.ok(forms.length >= 1);
    // JSX puts attributes on separate lines, so read from the tag opening to its closing ">".
    const openings = [...text.matchAll(/<form\b[\s\S]*?>/g)].map((m) => m[0]);
    for (const opening of openings) assert.match(opening, /method="post"/, `${page}: ${opening.slice(0, 60)}`);
    assert.match(text, /useHydrated/, `${page} waits for hydration`);
    assert.match(text, /!hydrated/, `${page} disables submit until hydrated`);
    assert.ok(!/href=\{`[^`]*\?(email|code|password|token)=/.test(text), `${page} builds no credential/address URL`);
    assert.ok(!/UI preview|preview mode|previewed/i.test(text), `${page} has no leftover preview wording`);
  });

test("the reset token is read from the URL fragment and removed from the address bar, never from a query string", () => {
  const text = source("src/app/reset-password/page.tsx");
  assert.match(text, /window\.location\.hash/);
  assert.match(text, /history\.replaceState/);
  assert.ok(!/searchParams|location\.search/.test(text));
});

test("the verification screen takes the address from session storage, not from the URL", () => {
  const text = source("src/app/verify-email/page.tsx");
  assert.match(text, /readPendingEmail/);
  assert.ok(!/location\.search|searchParams/.test(text));
});

test("signup needs no email: the screen has no email-delivery warning, never disables itself for it, and goes straight to sign-in", () => {
  const text = source("src/app/signup/page.tsx");
  assert.ok(!/SIGNUP_UNAVAILABLE|signupEnabled|email delivery is not set up/i.test(text), "no 'email not set up' warning or switch");
  assert.ok(!/verify-email|rememberPendingEmail/.test(text), "no verification step after signup");
  assert.match(text, /\/login\?created=1/);
});

test("forgot-password still says plainly when email delivery is unavailable", () => {
  const text = source("src/app/forgot-password/page.tsx");
  assert.match(text, /RESET_UNAVAILABLE/);
  assert.match(text, /resetEnabled/);
  assert.match(text, /passwordReset\?\.enabled === true/, "fails closed: only an explicit true enables the form");
});
