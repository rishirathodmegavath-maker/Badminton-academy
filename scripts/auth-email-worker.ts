import { closeDatabase } from "../src/infrastructure/database/client";
import { deliverAuthEmailOnce, emailDeliveryConfigured } from "../src/modules/identity/email-delivery";
import { config } from "../src/shared/config";
/**
 * Durable delivery of the authentication emails queued in auth_email_outbox (verification codes, reset links).
 *
 *   npm run auth:email-worker            keep running, draining the outbox every few seconds
 *   npm run auth:email-worker -- --once  drain what is due now and exit (cron / one-off)
 *
 * Needs the same environment as the application (DATABASE_URL, BETTER_AUTH_SECRET, EMAIL_PROVIDER=resend|zeptomail,
 * RESEND_API_KEY or ZEPTOMAIL_TOKEN, EMAIL_FROM). Several workers may run at once: rows are claimed with FOR UPDATE SKIP LOCKED.
 * Failed sends back off and retry until the message expires. No email address or secret is ever printed.
 */
const once = process.argv.includes("--once");
const intervalMs = Math.max(1000, Number(process.env.AUTH_EMAIL_WORKER_INTERVAL_MS) || 5000);
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stopping = true;
  });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

if (!emailDeliveryConfigured()) {
  console.error(
    "EMAIL_PROVIDER is not configured: set EMAIL_PROVIDER=resend (RESEND_API_KEY) or zeptomail (ZEPTOMAIL_TOKEN) with EMAIL_FROM. Nothing was sent.",
  );
  process.exit(1);
}
const secret = config().BETTER_AUTH_SECRET;
try {
  do {
    const summary = await deliverAuthEmailOnce(secret);
    if (summary && (summary.claimed || once))
      console.log(
        `[auth-email] claimed=${summary.claimed} sent=${summary.sent} retried=${summary.retried} failed=${summary.failedPermanent}`,
      );
    if (once || stopping) break;
    await sleep(intervalMs);
  } while (!stopping);
} catch (error) {
  console.error(
    `[auth-email] stopped: ${error instanceof Error ? error.message : "unexpected error"}`,
  );
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
