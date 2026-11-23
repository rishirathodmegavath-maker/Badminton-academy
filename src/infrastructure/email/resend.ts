import type {
  EmailSendResult,
  TransactionalEmailMessage,
  TransactionalEmailProvider,
} from "./provider";

export type ResendEmailProviderOptions = {
  apiKey: string;
  from: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const DEFAULT_RESEND_BASE_URL = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 10_000;

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (seconds > 0) return Math.min(seconds, 3600);
  }
  return undefined;
}

/**
 * Resend REST API adapter implementing `TransactionalEmailProvider`.
 * Never echoes API keys, recipient addresses, or response bodies in error codes.
 */
export class ResendEmailProvider implements TransactionalEmailProvider {
  readonly name = "resend";
  private readonly apiKey: string;
  private readonly from: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendEmailProviderOptions) {
    if (!options.apiKey.trim()) {
      throw new Error("ResendEmailProvider requires a non-empty API key.");
    }
    if (!options.from.trim()) {
      throw new Error("ResendEmailProvider requires a non-empty sender address.");
    }
    this.apiKey = options.apiKey.trim();
    this.from = options.from.trim();
    this.endpoint = `${(options.baseUrl ?? DEFAULT_RESEND_BASE_URL).replace(/\/+$/, "")}/emails`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(
    message: TransactionalEmailMessage,
    signal?: AbortSignal,
  ): Promise<EmailSendResult> {
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
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      };
      if (message.html) payload.html = message.html;
      if (message.tags && Object.keys(message.tags).length > 0) {
        payload.tags = Object.entries(message.tags).map(([name, value]) => ({
          name,
          value,
        }));
      }

      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) {
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          return {
            ok: false,
            retryable: true,
            errorCode: "RESEND_INVALID_JSON",
          };
        }
        const id =
          body && typeof body === "object" && "id" in body
            ? (body as { id?: unknown }).id
            : undefined;
        if (typeof id === "string" && id.trim().length > 0) {
          return { ok: true, providerMessageId: id };
        }
        return {
          ok: false,
          retryable: true,
          errorCode: "RESEND_MISSING_MESSAGE_ID",
        };
      }

      if (response.status === 429) {
        return {
          ok: false,
          retryable: true,
          errorCode: "RESEND_RATE_LIMITED",
          retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
        };
      }

      if (response.status === 408 || response.status >= 500) {
        return {
          ok: false,
          retryable: true,
          errorCode: `RESEND_HTTP_${response.status}`,
        };
      }

      return {
        ok: false,
        retryable: false,
        errorCode: `RESEND_HTTP_${response.status}`,
      };
    } catch {
      return {
        ok: false,
        retryable: true,
        errorCode: timedOut ? "RESEND_TIMEOUT" : "RESEND_NETWORK_ERROR",
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
