import type { Actor } from "../../identity/access";
import { requireCapability } from "../../identity/authority";
import { DomainError } from "../../training/domain/rules";
import { channelStates, providersFromEnv } from "../providers/registry";
import { processDispatchOnce, type WorkerSummary } from "./worker";

/**
 * "Process the queue now", for LOCAL TESTING ONLY. The real delivery worker is a separate process
 * (scripts/dispatch-worker.ts). An embedded development database allows one process at a time, so a separate worker cannot
 * run beside the development server; this lets a developer see a batch go through the queue in the browser.
 *
 * It is refused in production, and refused unless every configured channel is the TEST adapter: the web server never sends
 * through a live provider.
 */
export async function runQueueNowForTest(a: Actor): Promise<WorkerSummary & { passes: number }> {
  requireCapability(a, "comms.approve");
  if (process.env.NODE_ENV === "production") throw new DomainError("This is only available in development.", 403, "NOT_AVAILABLE");
  const states = channelStates();
  const modes = [states.EMAIL.mode, states.WHATSAPP.mode];
  if (modes.includes("LIVE") || !modes.includes("TEST"))
    throw new DomainError("The queue can be processed from here only when the delivery channels are in test mode.", 409, "NOT_TEST_MODE");
  const providers = providersFromEnv();
  const total: WorkerSummary & { passes: number } = { reclaimed: 0, claimed: 0, sent: 0, retrying: 0, failed: 0, skipped: 0, passes: 0 };
  for (let pass = 0; pass < 20; pass++) {
    // `now` moves forward in test mode so a retry delayed by minutes is not left waiting during a demonstration.
    const s = await processDispatchOnce({ providers, now: new Date(Date.now() + pass * 3 * 3_600_000), workerId: "dev-test-run" });
    total.passes++;
    for (const k of ["reclaimed", "claimed", "sent", "retrying", "failed", "skipped"] as const) total[k] += s[k];
    if (!s.claimed) break;
  }
  return total;
}
