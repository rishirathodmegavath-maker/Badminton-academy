# Release notes: architecture decisions, known limitations and deployment prerequisites

## 1. Sign-up without e-mail (approved architecture)

Full detail: `AUTH_ONBOARDING.md` (e-mail/password), `GOOGLE_SIGN_IN.md` (Google). In short:

* **E-mail/password sign-up needs no mail provider.** The account exists as soon as the transaction commits. No code, no
  e-mail, no session: the person signs in next.
* **Google sign-up and sign-in need no mail provider** (Google reports the address as verified).
* **A new password account is unverified and unassigned.** `email_verified = false`, no academy membership: every academy
  route answers `403 NO_MEMBERSHIP` until an owner gives access separately.
* **A duplicate address returns `409 EMAIL_IN_USE` and changes nothing** (password, name, terms and verification state of
  the existing account are untouched).
* **E-mail recovery is not available to unverified accounts.** Only a verified account with a password and no active OWNER
  membership is offered a reset link; owners are recovered by the operator (`npm run auth:recover`).
* MFA/TOTP, Owner protection and the RC1-RC5 authorization rules are unchanged by sign-up.
* Only password **reset** needs a mail provider (and the optional code step, which no screen currently leads to).

## 2. Unverified-account limitations and e-mail squatting

Because sign-up proves nothing about the mailbox:

* **Anyone can register someone else's address** with a password they know. That account is unverified and unassigned: it
  cannot use e-mail recovery, cannot hold a Google link, and holds no academy data.
* **The real owner of the address cannot sign up with it** (`409`), and the same `409` is how an attacker can learn
  whether an address already has an account. Per-address and per-client rate limits bound the probing speed only.
* **There is no purge of abandoned unverified accounts** and no tool to release a squatted address. Releasing one today
  means an operator removing the row in the database.
* The emailed-code endpoints (verify, resend) remain for accounts already waiting for a code; a code is only accepted
  together with a password typed twice. No screen leads to them for new sign-ups.

## 3. Account-claim and Owner-attachment limitations

* **No claim workflow.** There is no way for a person to take over an existing unverified account, and no mailbox-proof
  step offered to unverified accounts.
* **An owner attaches an existing account by INVITATION (0018, see `AUTH_ONBOARDING.md`, "Invitations").** Settings → add member
  still refuses an address that already has an account (409); the owner invites that address instead and the person accepts
  while signed in. An invitation never trusts an unverified address by itself: it needs the secret link AND an account whose
  email equals the invited address. **Remaining weakness:** a squatter who registered someone else's address (unverified) is the
  account that can accept an invitation to it, so for an address you suspect is squatted, verify the person by another route
  before inviting, and keep invitations short-lived. Closing this fully needs mailbox proof, which is not built.

## 4. Communications

See `COMMUNICATIONS.md`. WhatsApp delivery is **dormant** until guardians have registered phone numbers (no entry screen
yet); until then WhatsApp deliveries are recorded `FAILED` with a clear reason. Family e-mail needs ZeptoMail settings.
Delivery runs only when an authorised user triggers `communications/process` (no background worker for this queue).

## 5. Migrations and deployment prerequisites

* **Order:** `0015_auth_onboarding_and_outbox`, then `0016_guardian_phone`. Both are additive. Journal indices are
  contiguous and `when` strictly increasing; the runner refuses gaps. A database that has not yet applied 0015 gets both.
* **Before touching any real database:** take a verified backup; run `npm run db:migrate:plan` (lists pending
  migrations, changes nothing); a remote target also needs `MIGRATION_CONFIRM_TARGET`. Production uses `DATABASE_URL`
  (embedded PGlite is development-only). Stop or quiesce anything holding the development database open first.
* **Rollback** is manual and guarded (`migrations-rollback/`). Each script refuses unless its migration is applied with
  the reviewed hash and is the **latest** one, so roll back **0016 first, then 0015**. Rolling back 0016 **destroys every
  registered phone number**; rolling back 0015 removes the onboarding columns, three authentication indexes and the auth e-mail outbox.
* **Tested on:** PGlite, PostgreSQL 17 and PostgreSQL 18 (see the verification evidence for the run that applies to a given
  commit). Re-run `npm run test:pg` against the target major version before release.
* **Environment:** `BETTER_AUTH_SECRET` (32+ characters), `BETTER_AUTH_URL`, `DATABASE_URL`; optionally the mail provider
  (`EMAIL_PROVIDER`, `ZEPTOMAIL_TOKEN`, `EMAIL_FROM`, `ZEPTOMAIL_API_URL`) and keep `npm run auth:email-worker` running if
  password reset by e-mail is offered; optionally the communications settings in `COMMUNICATIONS.md`. Leave a mail
  variable group empty and that feature reports itself as unavailable; sign-up and sign-in still work.
* **Source control:** this work is not committed. Create the commit(s) before deploying; there is no other recovery path.


## Overnight audit pointers (2026-11-13)

* **Required in production beyond the list above:** `PRIVATE_MEDIA_PATH` (without it every private-media upload and playback answers 503) and
  `ERASURE_LEDGER_PATH` (the privacy worker's evidence file). The start-up review now warns about both by name.
* **A refused production start now exits with code 1** (it used to leave a running process that was not listening). Supervisors can rely on the exit code.
* **Browser specs:** start the server with `npx tsx scripts/e2e-server.ts --profile plain` (or `fake-google`) against a loopback `sportozen_e2e` database; `next start`
  alone reads `.env.local` and makes Google-dependent specs depend on the developer's credentials.
* The full findings, production-readiness checklist, Phase 4 blueprint, migration 0018 runbook and open risks are in `OVERNIGHT_SECURITY_AUDIT.md`,
  `PRODUCTION_READINESS_REPORT.md`, `PHASE4_IMPLEMENTATION_BLUEPRINT.md`, `MIGRATION_0018_EXECUTION_RUNBOOK.md` and `KNOWN_RISKS_AND_REMAINING_ISSUES.md`.
