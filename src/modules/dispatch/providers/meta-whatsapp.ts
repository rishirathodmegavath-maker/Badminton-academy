import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderEvent, SendOutcome, WhatsAppMessage, WhatsAppProvider } from "./types";

/**
 * The official WhatsApp Business Platform (Meta Cloud API) adapter. Written against Meta's public documentation and tested
 * here ONLY against recorded request/response shapes: it has never been connected to a real account, and nothing in this
 * repository holds credentials. It is inert unless every variable below is set.
 *
 *   WHATSAPP_META_PHONE_NUMBER_ID   the sending number's id
 *   WHATSAPP_META_ACCESS_TOKEN      a system-user access token (server environment only)
 *   WHATSAPP_META_APP_SECRET        verifies the signature of webhook calls
 *   WHATSAPP_META_VERIFY_TOKEN      answers Meta's webhook verification handshake
 *   WHATSAPP_META_TEMPLATE          the APPROVED template's name (three body variables: name, children, links)
 *   WHATSAPP_META_LANGUAGE          the template's language code (default en)
 *   WHATSAPP_META_GRAPH_VERSION     for example v21.0 (default shown below)
 *
 * Every business-initiated message is a template message: free text outside a customer-service window is not allowed by the
 * platform, so this adapter never sends free text.
 */
export type MetaConfig = {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  templateName: string;
  language: string;
  graphVersion: string;
  apiBase: string;
};
type Env = Readonly<Record<string, string | undefined>>;
const present = (v: string | undefined) => (v ?? "").trim();

export function metaConfig(env: Env = process.env): { ok: true; config: MetaConfig } | { ok: false; problems: string[] } {
  const required = [
    "WHATSAPP_META_PHONE_NUMBER_ID",
    "WHATSAPP_META_ACCESS_TOKEN",
    "WHATSAPP_META_APP_SECRET",
    "WHATSAPP_META_VERIFY_TOKEN",
    "WHATSAPP_META_TEMPLATE",
  ];
  const missing = required.filter((k) => !present(env[k]));
  const problems = missing.map((k) => `${k} is not set.`);
  if (present(env.WHATSAPP_META_PHONE_NUMBER_ID) && !/^\d{5,30}$/.test(present(env.WHATSAPP_META_PHONE_NUMBER_ID))) problems.push("WHATSAPP_META_PHONE_NUMBER_ID must be digits.");
  const version = present(env.WHATSAPP_META_GRAPH_VERSION) || "v21.0";
  if (!/^v\d+\.\d+$/.test(version)) problems.push("WHATSAPP_META_GRAPH_VERSION must look like v21.0.");
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    config: {
      phoneNumberId: present(env.WHATSAPP_META_PHONE_NUMBER_ID),
      accessToken: present(env.WHATSAPP_META_ACCESS_TOKEN),
      appSecret: present(env.WHATSAPP_META_APP_SECRET),
      verifyToken: present(env.WHATSAPP_META_VERIFY_TOKEN),
      templateName: present(env.WHATSAPP_META_TEMPLATE),
      language: present(env.WHATSAPP_META_LANGUAGE) || "en",
      graphVersion: version,
      apiBase: "https://graph.facebook.com",
    },
  };
}

export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = "meta";
  constructor(
    private config: MetaConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(m: WhatsAppMessage): Promise<SendOutcome> {
    const c = this.config;
    let response: Response;
    try {
      response = await this.fetchImpl(`${c.apiBase}/${c.graphVersion}/${c.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: m.to.replace(/^\+/, ""),
          type: "template",
          template: {
            name: m.templateName || c.templateName,
            language: { code: m.language || c.language },
            components: [{ type: "body", parameters: m.params.map((text) => ({ type: "text", text })) }],
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // A timeout or a network failure: the message may or may not have been accepted. Retrying can duplicate it only if the
      // provider did accept it; this is the at-least-once edge documented in DISPATCH_OPERATIONS.md.
      return { ok: false, retryable: true, errorCode: "META_NETWORK" };
    }
    const body = (await response.json().catch(() => null)) as { messages?: { id?: string }[]; error?: { code?: number } } | null;
    if (response.ok) {
      const id = body?.messages?.[0]?.id;
      return id ? { ok: true, providerMessageId: id } : { ok: false, retryable: true, errorCode: "META_NO_MESSAGE_ID" };
    }
    const code = `META_${response.status}_${body?.error?.code ?? "UNKNOWN"}`;
    if (response.status === 429 || response.status >= 500) {
      const wait = Number(response.headers.get("retry-after"));
      return { ok: false, retryable: true, errorCode: code, ...(Number.isFinite(wait) && wait > 0 ? { retryAfterSeconds: wait } : {}) };
    }
    return { ok: false, retryable: false, errorCode: code };
  }
}

/** Meta signs every webhook call: `X-Hub-Signature-256: sha256=<hex hmac of the raw body with the app secret>`. */
export function verifyMetaSignature(rawBody: string | Buffer, header: string | null | undefined, appSecret: string): boolean {
  const m = /^sha256=([0-9a-f]{64})$/i.exec((header ?? "").trim());
  if (!m || !appSecret) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(m[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type MetaPayload = {
  entry?: {
    changes?: {
      value?: {
        statuses?: { id?: string; status?: string; timestamp?: string; recipient_id?: string; errors?: { code?: number; title?: string }[] }[];
        messages?: { id?: string; from?: string; timestamp?: string; type?: string; text?: { body?: string } }[];
      };
    }[];
  }[];
};
const STATUS_TYPE: Record<string, "SENT" | "DELIVERED" | "READ" | "FAILED"> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
const at = (ts: string | undefined) => (ts && /^\d+$/.test(ts) ? new Date(Number(ts) * 1000) : new Date());
/**
 * Turns a webhook body into events: a status change of a message we sent, or a person replying STOP (or UNSUBSCRIBE) to opt out.
 * Anything else (other replies, unknown statuses) is ignored; this adapter never answers a reply.
 */
export function parseMetaWebhook(payload: unknown): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const entry of (payload as MetaPayload)?.entry ?? [])
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        const type = STATUS_TYPE[s.status ?? ""];
        if (!type || !s.id) continue;
        out.push({
          kind: "status",
          provider: "meta",
          eventId: `${s.id}:${s.status}`,
          providerMessageId: s.id,
          type,
          occurredAt: at(s.timestamp),
          detail: s.errors?.[0] ? `code ${s.errors[0].code ?? "?"}` : "",
        });
      }
      for (const msg of change.value?.messages ?? []) {
        const body = (msg.text?.body ?? "").trim().toUpperCase();
        if (msg.from && msg.id && ["STOP", "UNSUBSCRIBE"].includes(body))
          out.push({ kind: "stop", provider: "meta", eventId: msg.id, address: `+${msg.from.replace(/^\+/, "")}`, occurredAt: at(msg.timestamp) });
      }
    }
  return out;
}
