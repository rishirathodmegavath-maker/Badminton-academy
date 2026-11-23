import type { EmailConfig } from "./config";
import { call, clip, redact, type FetchLike, type SendResult } from "./transport";

/** ZeptoMail "Send Mail" API (v1.1). One request per recipient, so one recipient never sees another's address. */
export type EmailMessage = {
  to: { address: string; name: string };
  subject: string;
  text: string;
  /** Our delivery id: ZeptoMail echoes it as client_reference, so a sent mail can be traced back to its outbox row. */
  reference: string;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();

export async function sendEmail(config: EmailConfig, message: EmailMessage, fetchFn?: FetchLike): Promise<SendResult> {
  const html = message.text
    .split(/\r?\n/)
    .map((line) => `<p>${escapeHtml(line) || "&nbsp;"}</p>`)
    .join("");
  const result = await call(
    config.apiUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Zoho-enczapikey ${config.token}`,
      },
      body: JSON.stringify({
        from: { address: config.fromAddress, name: config.fromName },
        to: [{ email_address: { address: message.to.address, name: oneLine(message.to.name) } }],
        subject: oneLine(message.subject),
        textbody: message.text,
        htmlbody: html,
        client_reference: message.reference,
      }),
    },
    fetchFn,
  );
  if ("network" in result) return { kind: "retry", detail: `ZeptoMail: ${result.network}.` };
  const { status, body } = result;
  if (status >= 200 && status < 300) {
    const id = (body as { request_id?: unknown } | null)?.request_id;
    return { kind: "sent", providerId: clip(id ?? "accepted", 80) };
  }
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const why = redact(`ZeptoMail ${status}${error?.code ? ` ${clip(error.code, 30)}` : ""}${error?.message ? `: ${clip(error.message)}` : ""}`, config.token);
  if (status === 401 || status === 403) return { kind: "failed", detail: `${why} (credentials or sender domain rejected; check the ZeptoMail configuration).` };
  if (status === 408 || status === 429 || status >= 500) return { kind: "retry", detail: `${why}.` };
  return { kind: "failed", detail: `${why}.` };
}
