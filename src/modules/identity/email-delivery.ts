import { database } from "../../infrastructure/database/client";
import {
  createConfiguredEmailProvider,
  dispatchAuthEmailOutbox,
  emailProviderConfig,
  type DispatchOutboxSummary,
} from "../../infrastructure/email";

/**
 * Delivery of the transactional authentication emails that onboarding.ts queues in the outbox.
 *
 *  - The account change and its outbox row are committed together by the caller (the outbox is the only
 *    hand-off), so a crash can lose neither the account nor the instruction to email it.
 *  - `kickAuthEmailDelivery` is the best-effort "send now" after a commit: it never throws and never delays
 *    the response. Anything it does not finish (provider down, process stopped) stays queued.
 *  - `npm run auth:email-worker` (scripts/auth-email-worker.ts) is the durable path: it retries queued rows with
 *    backoff until they are sent or expire.
 */
export const emailDeliveryConfigured = (env: NodeJS.ProcessEnv = process.env) => {
  const provider = emailProviderConfig(env).provider;
  return provider === "resend" || provider === "zeptomail" || provider === "test";
};

const inFlight = new Set<Promise<unknown>>();

/** Drain due outbox rows once. Returns null when no provider is configured. */
export async function deliverAuthEmailOnce(
  authSecret: string,
): Promise<DispatchOutboxSummary | null> {
  // A fresh provider per run, so configuration is read when it is used.
  const provider = createConfiguredEmailProvider(process.env);
  if (!provider) return null;
  return dispatchAuthEmailOutbox(database(), provider, { authSecret });
}

export function kickAuthEmailDelivery(authSecret: string): void {
  if (!emailDeliveryConfigured()) return;
  const run = deliverAuthEmailOnce(authSecret)
    .catch(() => undefined)
    .finally(() => inFlight.delete(run));
  inFlight.add(run);
}

/** Resolves when every kicked delivery has finished (graceful shutdown; tests). */
export async function settleAuthEmailDelivery(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}
