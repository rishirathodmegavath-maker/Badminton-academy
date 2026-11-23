# Public onboarding: signup, sign-in, password recovery

## What needs email, and what does not

| Needs a mail provider | Works with NO mail provider |
| --- | --- |
| Forgot password / reset link | Email + password sign-in (every existing account) |
| Optional notifications, and the optional emailed verification code step | Email + password **signup** (no code, no email) |
| | Continue with Google: sign-in **and** sign-up |
| | MFA / authenticator sign-in, owner provisioning, all academy authorization |

A password signup creates the account at once: **unverified** (`email_verified = false`), **unassigned** (no academy
membership), terms recorded, no session (the person signs in next). Because the address was never proven, an unverified
account is kept out of everything that depends on owning the mailbox: password recovery by email and holding a Google link
both require a verified address. Google sign-up needs no mail either; Google reports the address as verified.

How a person gets an account without an owner, and what that account can and cannot do. Everything below runs on Better
Auth (`/api/auth/onboarding/*` is a Better Auth plugin, `src/modules/identity/onboarding.ts`); there is no second
authentication system. Email goes through the existing provider abstraction and Resend adapter
(`src/infrastructure/email`) and the transactional outbox from migration 0015.

## The rules

1. **A public signup is never a member of an academy.** It creates a person with no membership. Every academy route answers
   `403 NO_MEMBERSHIP`, exactly as for any account without a membership. An owner gives access separately.
2. **Signup needs no email and no code.** It starts no session; the person signs in with the password they chose. The
   *optional* emailed-code step (`verify-email` / `resend-verification`, email delivery required) remains only for an account
   that is waiting for a code (`email_verification_required`); such an account cannot sign in until it is verified, and the
   code is only accepted together with a password typed twice. No new signup creates one.
3. **Where email is used, it is transactional.** The code or reset link and the sealed outbox row commit together or not at
   all, and the provider being down never loses the account; the row stays queued (sealed) and is retried.
4. **An address that already has an account is never touched by a signup.** It is refused with `409 EMAIL_IN_USE` and the
   existing password, name, terms and verification state are left exactly as they were. (With no mailbox proof there is no
   honest way to answer "success" for an address that cannot be signed in with the new password.) The password-reset,
   resend and verify endpoints still answer identically for known and unknown addresses. Rate limits are per client address
   (Better Auth) and per target address (the sign-in throttle table), which also bounds how fast addresses can be probed.
5. **Recovery never bypasses a second factor, an owner, or the operator.** See below.
6. **Credentials never travel in a URL.** Forms are `method="post"` and their submit button stays disabled until the page
   has hydrated (so nothing can be sent natively); the reset token lives in the URL *fragment* and is removed from the
   address bar on arrival; the address being verified is carried in `sessionStorage`, not the query string.

## Endpoints

| Endpoint | Purpose | Limits |
| --- | --- | --- |
| `POST /onboarding/signup` | name, email, password, `acceptTerms`, `termsVersion` → unassigned, **unverified** account, **no email**; `409 EMAIL_IN_USE` for an address that exists | 5/min/client; 5 per 15 min per address |
| `POST /onboarding/verify-email` | email + 6-digit code + `password` + `confirmPassword` → address verified and that password installed (no session) | 10/min/client; **5 wrong guesses per 15 min per address withdraw the code**; code valid 10 min, single use |
| `POST /onboarding/resend-verification` | new code; the previous one stops working | 5/min/client; 60 s between sends; 5 per 15 min per address |
| `POST /onboarding/forgot-password` | single-use reset link by email | 5/min/client; 60 s between sends; 5 per 15 min per address |
| `POST /onboarding/reset-password` | token + new password (+ code if the account has an authenticator) | 10/min/client; 5 wrong tokens per link withdraw it; link valid 30 min, single use |

`GET /account/sign-in-methods` reports `passwordReset.enabled` (needs email delivery configured) and the current
`signup.termsVersion`. Signup is never reported as disabled. With delivery not configured, the forgot-password screen says
reset by email is unavailable, and `forgot-password` / `resend-verification` answer `503`; signup and sign-in are unaffected.

## Password recovery, precisely

* Offered only to accounts with a **verified email**, a **password**, and **no active OWNER membership**. Owner accounts are
  recovered by the server operator (`npm run auth:recover`, two-person approval), never by email; the attempt is written to
  the security log. Owner-provisioned members whose address was never verified are reset by their owner (temporary password).
* The link carries a random 256-bit secret; the database stores only a keyed hash bound to the account. Wrong guesses are
  counted per link.
* **An account with an authenticator app must present a current code (or one recovery code)** to finish the reset. Link
  access alone is not enough. The code is claimed once (replay-safe) and a recovery code is spent by use. A reset **never
  removes the authenticator**: the next sign-in still stops at the second step.
* Completing a reset replaces the password, replaces an owner-issued temporary password, **ends every session**, clears the
  account's sign-in throttles and writes `PASSWORD_RESET_COMPLETED` (no secret in it). It creates no session.
* A link issued before the person became an owner stops working (re-checked at completion).

## Google

See `GOOGLE_SIGN_IN.md`: from the sign-up screen Google can create an **unassigned** account (terms accepted, Google-verified
email); it never links by email; linking is an explicit act of a signed-in person.

## Running it

```
# Option A: Resend
EMAIL_PROVIDER=resend
RESEND_API_KEY=...
# Option B: Zoho ZeptoMail
EMAIL_PROVIDER=zeptomail
ZEPTOMAIL_TOKEN=...                # the Mail Agent's Send Mail token (the "Zoho-enczapikey " prefix is optional)
# ZEPTOMAIL_API_URL=https://api.zeptomail.eu/v1.1/email   # only if the account is not in the default data centre
EMAIL_FROM="Sportozen <no-reply@your-domain>"   # the domain must be verified in the ZeptoMail Mail Agent
npm run auth:email-worker          # durable delivery + retries (keep running)  --once for a cron job
```

ZeptoMail notes: click and open tracking are sent as off, so codes and reset links are never rewritten. ZeptoMail has no
idempotency header; the outbox key is sent as `client_reference`. A request that timed out may still have been delivered,
so a retry can, rarely, produce a second copy of the same code. `last_error_code` in `auth_email_outbox` carries ZeptoMail's
own identifier when it gives one (for example `ZEPTOMAIL_TM_4001_SM_111` = sender domain not verified in the Mail Agent).

Each request also makes one best-effort delivery attempt after its transaction commits. The worker is what retries failures
and sends anything the web process did not finish; run at least one in production.

## Known limits (decisions, not defects)

* **Unverified accounts can be squatted.** Since signup proves nothing about the mailbox, anyone can register someone
  else's address with a password they know. That account is unassigned and unverified, so it cannot use email recovery,
  cannot hold a Google link, and holds no academy data; the real owner of the address cannot sign up with it (409) and Google
  will not link by email, but can ask the academy owner for an account. Closing this fully needs mailbox proof (the optional
  code step could be offered to unverified accounts later). There is no purge of abandoned unverified rows yet.
* **Latent code-step only.** The emailed-code endpoints (and their password-at-verification rule)  are exercised by tests through accounts created directly in that state; no screen leads to them
  unless an account is already waiting for a code.
* **Joining an academy is by invitation (0018), never by signup or an email match.** Settings → add member still refuses an
  address that already has an account (409); the way in for an existing or a new account is an owner's invitation
  (Settings → Invitations), which the person accepts themselves. See "Invitations" below. Creating an academy is a separate
  feature (operator provisioning, not yet built).
* Verified by tests that stub Resend's, ZeptoMail's and Google's HTTP endpoints; **no live Resend, ZeptoMail or Google round trip was made.**

## Invitations (migration 0018)

An invitation is how a person joins an academy. It never needs a mail provider and never follows from an email address.

| | |
| --- | --- |
| Who creates, lists, withdraws | an academy **owner** (capability `members.manage`, inside the academy's unit of work, always for the caller's own academy) |
| Kinds | `STAFF` (OWNER, ADMIN, HEAD_COACH, COACH, FINANCE, NUTRITION_PRO), `GUARDIAN` (names a player and the relationship), `ADULT_PLAYER` (a membership only). There is no invitation for a child player. |
| Inviting an OWNER | needs the same password + authenticator step-up as any owner grant, checked when the invitation is made |
| The link | `<BETTER_AUTH_URL>/invite#<token>`, shown **once**. The token is 256 random bits in the URL fragment; the database stores only an HMAC of it. Nothing is emailed, so the owner hands the link over. |
| Accepting | the invitee signs in (existing account) or creates one (no email needed), reviews the academy and role, and clicks **Accept**. `POST /api/auth/invitations/accept` takes only the token; the person and the address come from the session. |
| Conditions at acceptance (all re-checked under the academy lock) | pending and not expired; addressed to **this account's email**; the inviter **still** holds the authority the invitation needed (an active owner); the person has no membership in the academy yet (a guardian may gain a link to another child) |
| Guardian invitations | create a GUARDIAN membership and a guardian link with **no consent granted**; consent stays a separate decision, and a guardian of an adult reads nothing until the adult grants it |
| Lifecycle | PENDING → ACCEPTED, REVOKED or EXPIRED. The last three are final (a database trigger refuses any change, so a used or withdrawn token can never come back); rows are never deleted |
| Replay and races | a second acceptance by the same person is idempotent (one membership, one audit row); by anyone else it is refused; many simultaneous acceptances still make one membership |
| Audit | `INVITATION_CREATED`, `INVITATION_REVOKED`, `INVITATION_ACCEPTED` (and `OWNER_GRANTED` for an owner), `INVITATION_REFUSED` (wrong account, inviter no longer authorised): in the academy's own security log, never with an address or a token |

Limits to know:

* **The owner delivers the link.** No email is sent, so a lost link means withdraw and re-invite.
* **A leaked link works for the account that owns the invited address.** The token is necessary and the address must match, but an
  unverified signup can register an address (see "Unverified accounts can be squatted"); the invitation is then only as safe as the
  link is private. Links are short-lived (default 7 days, at most 30).
* **Only owners invite.** Administrators do not hold `members.manage` (the authority model is unchanged).
* **An adult player's record is linked by staff afterwards** (the existing profile step); the invitation grants the membership only.
* **A previously switched-off member is restored by the owner** in Settings, not by a new invitation.

## Signed out when switching between servers on one machine

Browsers share cookies between ports of one host. Two Sportozen servers on `127.0.0.1` use the same cookie name, `better-auth.session_token`, so each overwrites the other's cookie and the person is signed out when they switch. Set `SPORTOZEN_COOKIE_PREFIX` (1 to 32 letters, digits or hyphens, for example `sz-bd-3330`) on each server to give it its own cookie name. Unset keeps the default name. A session lasts 12 hours and renews every 30 minutes while it is used.
