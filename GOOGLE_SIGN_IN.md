# Continue with Google (Phase 9)

An engineering description of the one optional way to sign in besides a password. **It is off until you configure it, and
live verification against Google has not been done** (it needs credentials only you can create). Everything below the
Google redirect is covered by automated tests that stub Google's token endpoint (`tests/google-signin.test.ts`,
`tests/google-disabled.test.ts`).

## What it is and is not

* It is **sign-in for accounts that already exist, plus sign-up of an UNASSIGNED account from the Create-account screen**.
  Owners provision academy accounts exactly as before (temporary password). Google creates an account only when the
  sign-up screen asks for it (`disableImplicitSignUp` + `requestSignUp`), with the terms accepted, and only for an email
  Google reports as verified. That account has **no academy membership** and gains none; an owner still decides who
  belongs to an academy. A Google email address never links itself to an existing account (`disableImplicitLinking`).
* A person **links their own Google account while signed in** (password), in *Account security → Sign in with Google*.
  Google must report the email as verified and it must equal the account's email. Owner-provisioned members and people
  with a verified email can link; an address that is still unverified cannot. They can unlink at any time (their password
  keeps working).
* After linking, **Continue with Google** appears on the sign-in page and signs them in.
* The button is shown only when the server reports Google as configured (`GET /api/auth/account/sign-in-methods`). With no
  credentials there is no button, no route that starts a Google flow, and nothing else changes.

## Account-matching policy (what is enforced and where)

| Rule | Enforced by |
| --- | --- |
| Create an account only from the sign-up screen, with terms, with a Google-verified email; always unassigned | `socialProviders.google.disableImplicitSignUp`; `databaseHooks.user.create.before/after` (terms from the OAuth state; `ACCOUNT_SIGNED_UP` event) |
| Never link from an email claim | `account.accountLinking.disableImplicitLinking`; linking only through `/link-social` by a signed-in person |
| Linking needs Google-verified email equal to the account email | Better Auth `linkOAuthAccount` (`allowDifferentEmails: false`) |
| Only provisioned or email-verified people may hold a link | `databaseHooks.account.create.before` (`mayHoldGoogle`: active membership or verified email) |
| A self-registered address must be verified before any session (password or Google) | `databaseHooks.session.create.before` (`EMAIL_NOT_VERIFIED`) |
| An account with an authenticator app cannot start a Google session | `databaseHooks.session.create.before` (see "Known limitation") |
| Expired temporary passwords cannot become sessions | the same `session.create.before` hook as for passwords |
| Forced password change and MFA enrolment gate still apply | `accountGate` on every application and auth request |
| No provider tokens are kept or served | `account.create/update.before` strip tokens; `/get-access-token`, `/refresh-token`, `/account-info`, `/list-accounts` are blocked |
| Rate limits | `/sign-in/social` 10/min, `/callback/*` 10/min, `/link-social` 5/min, `/account/unlink-google` 5/min per client |
| Audit | security events `GOOGLE_LINKED`, `GOOGLE_UNLINKED`, `GOOGLE_SIGN_IN`, `GOOGLE_SIGN_IN_REFUSED` (reason words only: never a token, a Google id or an email) |

### Known limitation (a decision for you)
Better Auth 1.7.10 applies its second-factor step to password sign-in only. A session started from Google would skip the
authenticator, so **accounts with an authenticator app enrolled cannot use Google sign-in**; they sign in with password and
code. In `enforce` mode people whose role requires MFA therefore end up on password + code. If you want Google to count as
the strong factor instead, that is a policy change to make deliberately, not a default.

## Configuration

Set both (or neither) in the environment, never in code or reports:

```
GOOGLE_CLIENT_ID=<OAuth client id>
GOOGLE_CLIENT_SECRET=<OAuth client secret>
```

1. Google Cloud console → APIs & Services → Credentials → OAuth client ID (type *Web application*).
2. Authorised redirect URI: `<BETTER_AUTH_URL>/api/auth/callback/google` (production must be `https`).
3. Scopes requested: `openid email profile` only.
4. `npm run auth:check-config -- --production` reports a half-configured pair as an error (names only, never values) and
   in production the server refuses to start until it is fixed.

### Local development (the default `BETTER_AUTH_URL=http://127.0.0.1:3100`)

* "Continue with Google" shows "not set up" until BOTH variables are in `.env.local` (restart `npm run dev` afterwards).
  Without them the API answers `404 PROVIDER_NOT_FOUND`; that is expected, not a fault.
* Register exactly `http://127.0.0.1:3100/api/auth/callback/google` as an authorised redirect URI (Google allows
  `http` for loopback addresses). Register `http://localhost:3100/api/auth/callback/google` as well only if you also
  want to use that host.
* The redirect URI is always built from `BETTER_AUTH_URL`, not from the address in the browser. Open the site on the same
  host as `BETTER_AUTH_URL`: `127.0.0.1` and `localhost` are different origins, so starting on one and being sent back to
  the other loses the state cookie and ends on the login page with "has to start and finish on the same web address"
  (`state_mismatch`). Change `BETTER_AUTH_URL` (and the registered URI) if you prefer `localhost`.
* While the OAuth consent screen is in *Testing*, only the Google accounts listed as test users can sign in.

## What was and was not verified

* Verified by tests: every row of the policy table above, the authorization request (client id, redirect URI, state, PKCE,
  no secret), the callback, linking, sign-in, refusals, unlinking and the disabled state.
* Account creation from Google is covered by `tests/google-signup.test.ts` (terms required, unverified email refused,
  sign-in screen cannot create, no takeover of owner-provisioned, self-registered or unverified accounts, explicit linking).
* **Not verified:** a real round trip to Google (no credentials were available), Google's consent screen, and behaviour
  with a Google Workspace domain restriction (`hd`) if you want one (it is a one-line option; not enabled).
