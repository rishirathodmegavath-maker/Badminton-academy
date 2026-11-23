# Family communications: e-mail (ZeptoMail) and WhatsApp (Meta Cloud API)

How a scheduled family message reaches a guardian, how to configure each channel, and what is deliberately not live yet.
This is separate from the authentication e-mail (verification codes, password-reset links), which has its own queue,
adapter and worker (see `AUTH_ONBOARDING.md`). Only the ZeptoMail **settings** are shared.

## How a message is delivered

1. A message is written, approved, and its recipients are fixed (the approval covers the recipient list).
2. Each recipient/channel pair becomes a delivery row in `outbox_delivery` (`QUEUED`).
3. An authorised user triggers delivery (`POST /api/academy/communications/process`). **There is no background worker for
   this queue:** nothing is sent until that action runs. Authentication e-mail is different: it has
   `npm run auth:email-worker`.
4. At that moment consent, the guardian relationship and access are checked **again**; a recipient who lost any of them is
   `SKIPPED`. A row is claimed with one conditional update (`SENDING`), the provider is called **outside** any database
   transaction, and the result is recorded: `SENT`, `RETRY` (transient, at most 3 attempts), `FAILED`, or `NOT_CONFIGURED`
   (the channel's settings are absent or invalid: nothing is sent). A row stuck in `SENDING` is never sent again
   automatically.

Provider responses are classified into those states without ever copying a credential, a recipient address or a response
body into the delivery detail.

## E-mail: ZeptoMail

| Variable | Meaning | Falls back to |
| --- | --- | --- |
| `ZEPTOMAIL_SEND_TOKEN` | Mail Agent "Send Mail token" (the `Zoho-enczapikey ` prefix is optional) | `ZEPTOMAIL_TOKEN` |
| `ZEPTOMAIL_FROM_ADDRESS` | Verified sender address | `EMAIL_FROM` |
| `ZEPTOMAIL_FROM_NAME` | Sender display name | the name inside `EMAIL_FROM`, else "Sportozen Academy" |
| `ZEPTOMAIL_API_URL` | Only for a non-default data centre | shared with the authentication e-mail; default `https://api.zeptomail.com/v1.1/email` |

* **Fallback rule.** An unset or blank communications variable uses the authentication one. An explicit communications
  variable always wins, **even when it is wrong** (the mistake is reported, not hidden by the fallback). Each variable is
  resolved on its own, so a mixed setup works.
* **`EMAIL_FROM` format.** It is written `Name <address>` or `address`. ZeptoMail needs the bare address, so it is split;
  control characters are removed from the name and the name is capped at 100 characters.
* **Same validation as authentication.** Token and endpoint are judged by the authentication module's own functions
  (`src/infrastructure/email/provider.ts`): the endpoint must be https on an `api.zeptomail.*` host with no port,
  credentials, query or fragment; the prefix is removed; the token may not contain whitespace. A test feeds both
  implementations the same inputs and requires the same verdict. The authentication adapter is not modified.
* The sender domain must be verified (SPF/DKIM) in the ZeptoMail Mail Agent. Click and open tracking are off.
* If the authentication `EMAIL_PROVIDER` is `resend` but `ZEPTOMAIL_TOKEN`/`EMAIL_FROM` are also set, family e-mail would
  try ZeptoMail with that sender. Set `ZEPTOMAIL_SEND_TOKEN`/`ZEPTOMAIL_FROM_ADDRESS` explicitly in that case.

## WhatsApp: Meta Cloud API

| Variable | Meaning |
| --- | --- |
| `WHATSAPP_ACCESS_TOKEN` | Permanent access token |
| `WHATSAPP_PHONE_NUMBER_ID` | Digits only |
| `WHATSAPP_TEMPLATES` | JSON of the **approved** templates. Only these are ever sent |
| `WHATSAPP_API_VERSION` | Optional, default `v21.0` (form `vNN.N`) |
| `WHATSAPP_DEFAULT_COUNTRY_CODE` | Optional digits (1-3), used for stored numbers written without `+` |

```
WHATSAPP_TEMPLATES={"*":{"template":"academy_update","language":"en","params":["recipientName","subject","body"]}}
```

The key is the lower-cased name of the academy's message template, or `*` for messages that use none. `params` fill the
template's variables in order, from `recipientName`, `subject`, `body` only. Meta template names are lower-case letters,
digits and underscores. The channel is "configured" only when the token, number id and at least one valid template are
present. Problems are reported by variable **name**, never by value.

## Delivery is dormant until guardians have registered phone numbers

WhatsApp goes to the **guardian's own registered number**, never to a number from another guardian's link. The number is
stored on the account (`app_user.phone`, E.164, one per account, enforced by a CHECK constraint).

* **There is no screen to enter a number yet.** The endpoint exists (`POST /api/academy/communications/phone`): a member
  sets or clears their own number; an OWNER may set the number of a member of the same academy. Until a screen (or an
  owner using that endpoint) registers numbers, every WhatsApp delivery is recorded `FAILED` with the reason "The
  recipient has no registered phone number. Nothing was sent." E-mail is unaffected.
* The number is **not verified** (no OTP), is not an authentication factor, and changes nothing about sign-in. The audit
  record keeps only the last four digits.
* A signed-up person with no academy membership cannot register one (every academy route answers `403 NO_MEMBERSHIP`).

## Data and migration

Migration `0016_guardian_phone` adds `app_user.phone` and `app_user_phone_e164_check` (`^[+][1-9][0-9]{7,14}$` or NULL).
It is additive: no existing row changes and nobody is given a number. See `RELEASE_PREREQUISITES.md` for order and rollback.

## What has not been done

No real e-mail or WhatsApp message has been sent by any test or verification, and no live ZeptoMail or Meta round trip
has been made. Provider behaviour is verified against stubbed HTTP endpoints only.
