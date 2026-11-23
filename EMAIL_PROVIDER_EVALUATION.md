# E-mail provider evaluation: Amazon SES and Postmark

Status: **evaluation only. Nothing was purchased, configured or called.** No account exists, no credential was created or used,
and the build contains no SES or Postmark adapter. The delivery engine talks to e-mail through a small provider interface
(`src/modules/dispatch/providers/types.ts`) and ships with a test adapter only. Naming `ses` or `postmark` in
`DISPATCH_EMAIL_PROVIDER` is reported as "not available in this build" rather than guessed at.

Prices below are public figures found on 2026-11-21 from the vendors' pages and third-party summaries. **Vendor pricing changes;
confirm every number on the vendor's own page before deciding.** Anything not confirmed is marked.

## What the academy needs (this is small)

A school or academy sending one report e-mail per family per month. For 100 families that is about 1,200 messages a year; for
1,000 families about 12,000. Delivery quality (landing in the inbox, not in spam) matters far more than the price per thousand.

## Comparison

| | Amazon SES | Postmark |
| --- | --- | --- |
| Price (published) | Pay-as-you-go: about **$0.10 per 1,000** e-mails on most 2026 summaries; AWS's July 2026 plans announcement lists an Essentials plan at about **$0.16 per 1,000** and says new accounts start on Essentials. *Which applies to a new account is unconfirmed.* Attachments extra. | **$15 a month for 10,000 e-mails** on the entry plan; overage about **$1.80 per 1,000** on that plan *(figure repeated by two sources, not confirmed on the vendor page)*. Higher-tier figures conflict between sources: unresolved. |
| Cost at 100 families (1,200 a year) | about **$0.12–$0.19 a year** | **$180 a year** (the monthly plan), because the minimum is a monthly fee |
| Cost at 1,000 families (12,000 a year) | about **$1.20–$1.92 a year** | **$180 a year** |
| Extras | Dedicated IPs about $24.95 a month each; deliverability dashboard about $0.07 per 1,000 *(not needed at this scale)* | Dedicated IP $50 a month on plans of 300,000 and above *(not relevant)* |
| Delivery receipts and bounces | By notification through AWS's own messaging service (SNS), which is an extra thing to set up and secure | Webhooks straight to a URL, signed by the vendor *(per its documentation; confirm at setup)* |
| Setup effort | More: verify a domain, request production access (new accounts normally start in a restricted "sandbox" that can send only to verified addresses *(from general knowledge of SES; confirm)*), wire bounces through SNS | Less: verify a domain, create a server token, add one webhook |
| Football app today | Not used | Already has a Postmark adapter (not part of this milestone) |

## What every real provider needs from you

1. **A sender domain the academy owns**, with DNS records you can edit: **SPF**, **DKIM** and **DMARC**. Google's published sender rules require SPF or DKIM for every sender and DMARC for bulk senders, and recommend 2048-bit DKIM keys. A message "From" a domain that does not pass these is likely to be filtered. (Source: Google's e-mail sender guidelines.)
2. A **monitored reply and abuse address**, and a way for a parent to stop messages (the delivery engine already suppresses an address after a bounce or a complaint and honours a WhatsApp STOP; an e-mail unsubscribe link and a visible unsubscribe path are still to be added before live sending).
3. A **webhook endpoint** the provider can reach on the public internet (HTTPS), so delivered, bounced and complaint events come back. Without it, messages stay at "Sent (accepted by the provider)" and never say "Delivered": the screen will not claim more than the provider reports.
4. **Warm-up discipline**: a brand-new domain should start with a small batch rather than the whole academy at once.

## Why not Gmail

Not recommended for bulk, and you asked not to assume it. Google documents extra requirements above 5,000 messages a day to personal Gmail accounts. The commonly quoted daily caps for a personal mailbox (500) and Workspace (2,000) come from third-party pages and are **unconfirmed**. Tying delivery to one person's mailbox also ties it to their password, their recovery and their terms of use. No Gmail credential or app password was requested or stored.

## Recommendation

At this scale the price difference is a few dollars a year in either direction, so choose on **how little can go wrong**:

- **Postmark** if the academy wants the simplest, most predictable setup with direct delivery webhooks and is content to pay about $180 a year.
- **Amazon SES** if the academy already uses AWS or wants the lowest cost and accepts a longer first setup (production access request, bounce notifications through SNS).

Either way the first live step should be: choose the provider, verify the domain, send to the owner's own address, then to a handful of families, then the batch. **Decision needed from you (D2); nothing is blocked on it.** Everything in the delivery engine except the live adapter is built and tested with the test adapter.

## What a new adapter has to do (so the choice stays cheap to make)

Implement `EmailProvider.send({to, subject, text, idempotencyKey})` and return `{ok:true, providerMessageId}` or `{ok:false, retryable, errorCode, suppress?}`; map the provider's own delivery, bounce and complaint events to `ProviderEvent` (`src/modules/dispatch/providers/types.ts`) and add one signed webhook route like `src/app/api/webhooks/whatsapp/route.ts`; register the provider name in `providers/registry.ts`. The queue, retry and backoff, lease recovery, duplicate-send prevention, suppression, audit and the screens need no change.

## Sources

- Amazon SES pricing: https://aws.amazon.com/ses/pricing/ (and AWS's July 2026 announcement of pricing plans: https://aws.amazon.com/about-aws/whats-new/2026/07/amazon-ses-pricing-plans/)
- Postmark pricing: https://postmarkapp.com/pricing and third-party summaries (e.g. https://www.activepieces.com/blog/postmark-pricing-plans-costs-by-volume-2026-guide)
- Google e-mail sender guidelines: https://support.google.com/mail/answer/81126
