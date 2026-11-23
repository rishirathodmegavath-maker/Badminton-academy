import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EmailMessage, EmailProvider, SendOutcome, WhatsAppMessage, WhatsAppProvider } from "./types";

/**
 * A safe stand-in for a real provider, for development and tests. It sends nothing anywhere: it records what WOULD have been
 * sent (in memory, and as one JSON line per message in a local file when a path is given) and answers by simple rules on the
 * address so every outcome can be exercised:
 *
 *   address contains "bounce"           permanent failure, the address must be suppressed
 *   address contains "fail-permanent"   permanent failure
 *   address contains "flaky"            fails (retryable) twice, then succeeds
 *   a WhatsApp number ending 0000       permanent failure; ending 1111: fails (retryable) twice, then succeeds
 *   address contains "always-retry"     a temporary failure every time (to exercise retry exhaustion)
 *   anything else                       accepted
 *
 * It refuses to exist in production. Do not point it at real families: the outbox file contains the message text.
 */
export type Recorded = { channel: "EMAIL" | "WHATSAPP"; to: string; subject?: string; text: string; idempotencyKey: string; at: string };
/** Test only: hold the answer for this long AFTER the message was recorded, so a process can be killed in the exact window between
 *  "the provider accepted it" and "the worker wrote that down" (DISPATCH_TEST_SEND_DELAY_MS). Zero by default. */
const sendDelay = () => Math.max(0, Math.min(60_000, Number(process.env.DISPATCH_TEST_SEND_DELAY_MS) || 0));
const hold = async () => {
  const ms = sendDelay();
  if (ms) await new Promise((r) => setTimeout(r, ms));
};
const guardProduction = () => {
  if (process.env.NODE_ENV === "production") throw new Error("The test delivery adapter is not available in production.");
};
function decide(address: string, tries: number, kind: "EMAIL" | "WHATSAPP"): SendOutcome | null {
  const a = address.toLowerCase();
  if (a.includes("bounce")) return { ok: false, retryable: false, errorCode: "TEST_BOUNCED", suppress: "BOUNCED" };
  if (a.includes("fail-permanent") || (kind === "WHATSAPP" && a.endsWith("0000"))) return { ok: false, retryable: false, errorCode: "TEST_PERMANENT" };
  if (a.includes("always-retry")) return { ok: false, retryable: true, errorCode: "TEST_TEMPORARY" };
  if ((a.includes("flaky") || (kind === "WHATSAPP" && a.endsWith("1111"))) && tries <= 2) return { ok: false, retryable: true, errorCode: "TEST_TEMPORARY" };
  return null;
}
class Base {
  readonly sent: Recorded[] = [];
  private tries = new Map<string, number>();
  constructor(private file?: string) {
    guardProduction();
    if (file) mkdirSync(dirname(file), { recursive: true });
  }
  protected handle(kind: "EMAIL" | "WHATSAPP", to: string, key: string, record: Omit<Recorded, "at" | "channel" | "to" | "idempotencyKey">): SendOutcome {
    const n = (this.tries.get(key) ?? 0) + 1;
    this.tries.set(key, n);
    const failure = decide(to, n, kind);
    if (failure) return failure;
    const entry: Recorded = { channel: kind, to, idempotencyKey: key, at: new Date().toISOString(), ...record };
    this.sent.push(entry);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    return { ok: true, providerMessageId: `test-${kind.toLowerCase()}-${this.sent.length}-${key.slice(0, 8)}` };
  }
}
export class TestEmailProvider extends Base implements EmailProvider {
  readonly name = "test";
  async send(m: EmailMessage): Promise<SendOutcome> {
    const outcome = this.handle("EMAIL", m.to, m.idempotencyKey, { subject: m.subject, text: m.text });
    await hold();
    return outcome;
  }
}
export class TestWhatsAppProvider extends Base implements WhatsAppProvider {
  readonly name = "test";
  async send(m: WhatsAppMessage): Promise<SendOutcome> {
    const outcome = this.handle("WHATSAPP", m.to, m.idempotencyKey, { text: m.text });
    await hold();
    return outcome;
  }
}
