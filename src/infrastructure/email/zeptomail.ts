import {
  ZEPTOMAIL_DEFAULT_API_URL,
  validZeptoMailApiUrl,
  zeptoMailToken,
  type EmailSendResult,
  type TransactionalEmailMessage,
  type TransactionalEmailProvider,
} from "./provider";

export type ZeptoMailEmailProviderOptions = {
  /** The Send Mail token of the ZeptoMail Mail Agent, with or without the "Zoho-enczapikey " prefix. */
  token: string;
  /** "address@example.org" or "Display Name <address@example.org>". The domain must be verified in the Mail Agent. */
  from: string;
  /** Defaults to https://api.zeptomail.com/v1.1/email; other data centres use another api.zeptomail.* host. */
  apiUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const NAMED = /^\s*"?([^<>"\r\n]*?)"?\s*<([^<>\s]+)>\s*$/;

/** "Sportozen <no-reply@example.org>" -> { address, name }. The caller has already validated the sender. */
function parseSender(from: string): { address: string; name?: string } {
  const named = NAMED.exec(from);
  if (named) {
    const name = named[1].trim().slice(0, 250);
    return name ? { address: named[2], name } : { address: named[2] };
  }
  return { address: from.trim() };
}

/** ZeptoMail's own error identifiers, e.g. TM_4001 and SM_111. Only strictly shaped codes are kept, never free text. */
function errorCodeOf(bodyText: string): string | null {
  const tm = /\bTM_\d{3,4}\b/.exec(bodyText)?.[0];
  if (!tm) return null;
  const sub = /\b(?!TM_|EM_)[A-Z]{2,5}_\d{2,3}\b/.exec(bodyText)?.[0];
  return sub ? `${tm}_${sub}` : tm;
}

/**
 * Zoho ZeptoMail adapter implementing `TransactionalEmailProvider` (POST {apiUrl}, `Authorization: Zoho-enczapikey ...`).
 *
 * Same contract as the Resend adapter: it never echoes the token, recipient addresses or response bodies in error
 * codes (only ZeptoMail's own TM_/SM_ identifiers, which explain things like an unverified sender domain). Click and
 * open tracking are switched off explicitly so verification codes and reset links are never rewritten or logged.
 * ZeptoMail offers no idempotency header, so the outbox key travels as `client_reference` (visible in ZeptoMail's
 * activity log); a send that timed out may therefore have been delivered, and the retry could deliver a second copy.
 */
export class ZeptoMailEmailProvider implements TransactionalEmailProvider {
  readonly name = "zeptomail";
  private readonly token: string;
  private readonly sender: { address: string; name?: string };
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ZeptoMailEmailProviderOptions) {
    const token = zeptoMailToken(options.token);
    if (!token) throw new Error("ZeptoMailEmailProvider requires a non-empty token.");
    if (/[\s\0]/.test(token)) throw new Error("ZeptoMailEmailProvider token must not contain whitespace.");
    if (!options.from.trim()) throw new Error("ZeptoMailEmailProvider requires a non-empty sender address.");
    const endpoint = (options.apiUrl ?? ZEPTOMAIL_DEFAULT_API_URL).trim();
    if (!validZeptoMailApiUrl(endpoint))
      throw new Error("ZeptoMailEmailProvider requires an https api.zeptomail.* endpoint.");
    this.token = token;
    this.sender = parseSender(options.from);
    this.endpoint = endpoint;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(message: TransactionalEmailMessage, signal?: AbortSignal): Promise<EmailSendResult> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const payload: Record<string, unknown> = {
        from: this.sender,
        to: [{ email_address: { address: message.to } }],
        subject: message.subject,
        textbody: message.text,
        client_reference: message.idempotencyKey.slice(0, 128),
        track_clicks: false,
        track_opens: false,
      };
      if (message.html) payload.htmlbody = message.html;

      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Zoho-enczapikey ${this.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          return { ok: false, retryable: true, errorCode: "ZEPTOMAIL_INVALID_JSON" };
        }
        const id =
          body && typeof body === "object" && "request_id" in body
            ? (body as { request_id?: unknown }).request_id
            : undefined;
        if (typeof id === "string" && id.trim().length > 0) return { ok: true, providerMessageId: id.trim() };
        return { ok: false, retryable: true, errorCode: "ZEPTOMAIL_MISSING_REQUEST_ID" };
      }

      let detail: string | null = null;
      try {
        detail = errorCodeOf((await response.text()).slice(0, 4096));
      } catch {
        detail = null;
      }
      const errorCode = detail ? `ZEPTOMAIL_${detail}` : `ZEPTOMAIL_HTTP_${response.status}`;
      if (response.status === 429) {
        const header = response.headers.get("retry-after")?.trim() ?? "";
        const seconds = /^\d+$/.test(header) ? Number.parseInt(header, 10) : 0;
        return {
          ok: false,
          retryable: true,
          errorCode,
          retryAfterSeconds: seconds > 0 ? Math.min(seconds, 3600) : undefined,
        };
      }
      return { ok: false, retryable: response.status === 408 || response.status >= 500, errorCode };
    } catch {
      return {
        ok: false,
        retryable: true,
        errorCode: timedOut ? "ZEPTOMAIL_TIMEOUT" : "ZEPTOMAIL_NETWORK_ERROR",
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
