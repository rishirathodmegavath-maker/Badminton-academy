import { z } from "zod";
// The authentication e-mail module owns what a valid ZeptoMail token and endpoint are. Using ITS functions (not a copy of
// the rules) is what makes the two implementations judge a shared ZEPTOMAIL_API_URL or token identically.
import { ZEPTOMAIL_DEFAULT_API_URL, validZeptoMailApiUrl, zeptoMailToken } from "../../../infrastructure/email/provider";

/**
 * Provider configuration, read from environment variables only (never from the database or the repository).
 * Functions take `env` so tests can pass their own; the application passes process.env.
 *
 * Email: ZeptoMail      ZEPTOMAIL_SEND_TOKEN, ZEPTOMAIL_FROM_ADDRESS, [ZEPTOMAIL_FROM_NAME], [ZEPTOMAIL_API_URL]
 *                       When the first two are unset they fall back to the authentication e-mail setting of the same
 *                       ZeptoMail account: ZEPTOMAIL_TOKEN and EMAIL_FROM ("Name <address>" or "address"; the name is
 *                       used as the sender name unless ZEPTOMAIL_FROM_NAME is set). ZEPTOMAIL_API_URL is shared.
 *                       Token and endpoint are validated by the authentication module's own functions
 *                       (infrastructure/email/provider.ts): https on an api.zeptomail.* host, no port, credentials,
 *                       query or fragment; the console's "Zoho-enczapikey " prefix is removed; no whitespace.
 *                       An explicit variable always overrides the fallback.
 * WhatsApp: there is no provider. It is sent by a person from their own WhatsApp through a free wa.me link (see
 *           ../share-links.ts), so nothing is configured or paid for.
 * The optional e-mail service is "configured" only when everything it needs is present and valid. Anything else is reported,
 * with the variable NAMES that are missing or invalid (never their values). Without it, e-mail is sent by hand from the
 * sender's own mail app (a free mailto: link), exactly like WhatsApp.
 */
export type Env = Record<string, string | undefined>;

export type EmailConfig = { apiUrl: string; token: string; fromAddress: string; fromName: string };
export type ChannelConfig<T> = { ok: true; config: T } | { ok: false; problems: string[] };

const present = (v: string | undefined) => (v ?? "").trim();

/**
 * The authentication e-mail setting EMAIL_FROM is written "Name <address>" (or just "address"). ZeptoMail wants the bare
 * address, so split it. Control characters are dropped from the name; anything that is not an address is left for the
 * address validation to refuse.
 */
function splitSender(raw: string): { address: string; name: string } {
  const m = /^\s*"?([^"<>]*?)"?\s*<([^<>]+)>\s*$/.exec(raw);
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return m ? { address: m[2].trim(), name: clean(m[1]) } : { address: raw.trim(), name: "" };
}

export function emailConfig(env: Env = process.env): ChannelConfig<EmailConfig> {
  const problems: string[] = [];
  // An explicit communications variable always wins, even when it is wrong (the mistake is reported, not papered over by
  // the authentication setting). Only an unset or blank one falls back to the authentication ZeptoMail setting.
  const tokenVariable = present(env.ZEPTOMAIL_SEND_TOKEN) ? "ZEPTOMAIL_SEND_TOKEN" : "ZEPTOMAIL_TOKEN";
  const rawToken = present(env.ZEPTOMAIL_SEND_TOKEN) || present(env.ZEPTOMAIL_TOKEN);
  const token = zeptoMailToken(rawToken);
  const explicitFrom = present(env.ZEPTOMAIL_FROM_ADDRESS);
  const fallbackFrom = explicitFrom ? null : splitSender(present(env.EMAIL_FROM));
  const fromAddress = explicitFrom || fallbackFrom?.address || "";
  const fromVariable = explicitFrom ? "ZEPTOMAIL_FROM_ADDRESS" : fallbackFrom?.address ? "EMAIL_FROM" : "ZEPTOMAIL_FROM_ADDRESS";
  if (!rawToken) problems.push("ZEPTOMAIL_SEND_TOKEN is not set");
  else if (!token) problems.push(`${tokenVariable} holds no token`);
  else if (/[\s\0]/.test(token)) problems.push(`${tokenVariable} must not contain whitespace`);
  if (!fromAddress) problems.push("ZEPTOMAIL_FROM_ADDRESS is not set");
  else if (!z.string().email().safeParse(fromAddress).success) problems.push(`${fromVariable} is not a valid e-mail address`);
  const apiUrl = present(env.ZEPTOMAIL_API_URL) || ZEPTOMAIL_DEFAULT_API_URL;
  if (!validZeptoMailApiUrl(apiUrl)) {
    let parsable = true;
    try {
      new URL(apiUrl);
    } catch {
      parsable = false;
    }
    problems.push(parsable ? "ZEPTOMAIL_API_URL must be an https ZeptoMail address" : "ZEPTOMAIL_API_URL is not a valid URL");
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, config: { apiUrl, token, fromAddress, fromName: present(env.ZEPTOMAIL_FROM_NAME) || fallbackFrom?.name || "Sportozen Academy" } };
}

/** What the application may show (provider status in the message preview). Never includes a secret. */
export function providerStatus(env: Env = process.env) {
  return {
    // "MANUAL" = sent by a person from their own mail app / WhatsApp through a free link.
    EMAIL: emailConfig(env).ok ? "AVAILABLE" : "MANUAL",
    WHATSAPP: "MANUAL",
  } as const;
}
