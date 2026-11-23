/**
 * What the delivery worker needs from a channel provider. Providers are small and replaceable: the queue, retries, duplicate
 * prevention and status tracking live in the worker, never in a provider.
 *
 * A provider answers one of two ways. It never throws for an expected failure.
 *   - ok:      the provider accepted the message and gave it an id.
 *   - not ok:  `retryable` says whether trying again can help (a timeout, a rate limit, a provider outage) or not (an invalid
 *              address, a rejected template). `suppress` tells the worker the address must not be used again.
 */
export type SendOutcome =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; errorCode: string; suppress?: "BOUNCED" | "COMPLAINED" | "STOP"; retryAfterSeconds?: number };

export type EmailMessage = { to: string; subject: string; text: string; idempotencyKey: string };
export type WhatsAppMessage = {
  /** E.164, with the leading plus. */
  to: string;
  templateName: string;
  language: string;
  /** The single-line variables of the template body, in order. */
  params: string[];
  /** The words those variables produce, for the delivery record and for the test adapter. Never sent as free text. */
  text: string;
  idempotencyKey: string;
};

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<SendOutcome>;
}
export interface WhatsAppProvider {
  readonly name: string;
  send(message: WhatsAppMessage): Promise<SendOutcome>;
}
export type Providers = { EMAIL?: EmailProvider; WHATSAPP?: WhatsAppProvider };

/** What a provider tells us later, by webhook, about a message it accepted earlier. */
export type ProviderEvent =
  | { kind: "status"; provider: string; eventId: string; providerMessageId: string; type: "SENT" | "DELIVERED" | "READ" | "FAILED" | "BOUNCED" | "COMPLAINED"; occurredAt: Date; detail: string }
  | { kind: "stop"; provider: string; eventId: string; address: string; occurredAt: Date };
