export type EmailProviderEnv = Readonly<Record<string, string | undefined>>;

export const TRANSACTIONAL_EMAIL_KINDS = [
  "EMAIL_VERIFICATION_OTP",
  "PASSWORD_RESET_LINK",
] as const;

export type TransactionalEmailKind = (typeof TRANSACTIONAL_EMAIL_KINDS)[number];

export type TransactionalEmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey: string;
  kind: TransactionalEmailKind;
  tags?: Record<string, string>;
};

export type EmailSendResult =
  | {
      ok: true;
      providerMessageId: string;
    }
  | {
      ok: false;
      retryable: boolean;
      errorCode: string;
      retryAfterSeconds?: number;
    };

export interface TransactionalEmailProvider {
  readonly name: string;
  send(message: TransactionalEmailMessage, signal?: AbortSignal): Promise<EmailSendResult>;
}

export type EmailProviderConfig =
  | { provider: "disabled"; problem: null }
  | {
      provider: "invalid";
      variable:
        | "EMAIL_PROVIDER"
        | "RESEND_API_KEY"
        | "ZEPTOMAIL_TOKEN"
        | "ZEPTOMAIL_API_URL"
        | "EMAIL_FROM"
        | "AUTH_EMAIL_CAPTURE_FILE";
      problem: string;
    }
  /**
   * A stand-in for automated browser tests: it writes each message to a file and sends nothing. Valid ONLY outside production,
   * on an instance that declared itself disposable, with an explicit capture file and no real provider credentials.
   */
  | { provider: "test"; captureFile: string; problem: null }
  | { provider: "resend"; apiKey: string; from: string; problem: null }
  | { provider: "zeptomail"; token: string; from: string; apiUrl: string; problem: null };

/** Where ZeptoMail's send API lives. Other data centres use another api.zeptomail.* host (ZEPTOMAIL_API_URL). */
export const ZEPTOMAIL_DEFAULT_API_URL = "https://api.zeptomail.com/v1.1/email";
const ZEPTOMAIL_PREFIX = /^Zoho-enczapikey(?:\s+|$)/i;
/** The token as the ZeptoMail console shows it may or may not carry the "Zoho-enczapikey " prefix; keep only the secret. */
export function zeptoMailToken(raw: string | undefined): string {
  return (raw ?? "").trim().replace(ZEPTOMAIL_PREFIX, "").trim();
}
/**
 * The send endpoint must be https on an api.zeptomail.* host: a mistyped or malicious value could otherwise send the
 * token (and every verification code) to a third party.
 */
export function validZeptoMailApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /^api\.zeptomail\.[a-z]{2,3}(\.[a-z]{2})?$/i.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

const trim = (value: string | undefined) => (value ?? "").trim();
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|\/)/;

const SIMPLE_EMAIL_RE = /^[^\s<>@,;:\\"()[\]\r\n]+@[^\s<>@,;:\\"()[\]\r\n]+\.[^\s<>@,;:\\"()[\]\r\n]+$/;
const NAMED_EMAIL_RE = /^[^<>\r\n]+\s+<([^\s<>@,;:\\"()[\]\r\n]+@[^\s<>@,;:\\"()[\]\r\n]+\.[^\s<>@,;:\\"()[\]\r\n]+)>$/;

export function isValidSenderAddress(value: string): boolean {
  if (!value || /[\r\n\0]/.test(value)) return false;
  if (SIMPLE_EMAIL_RE.test(value)) return true;
  const match = NAMED_EMAIL_RE.exec(value);
  return !!match && SIMPLE_EMAIL_RE.test(match[1]);
}

/**
 * Pure parser for transactional email settings. Never echoes secret values in problems.
 */
export function emailProviderConfig(env: EmailProviderEnv = process.env): EmailProviderConfig {
  const providerRaw = trim(env.EMAIL_PROVIDER).toLowerCase();
  const apiKey = trim(env.RESEND_API_KEY);
  const zeptoToken = zeptoMailToken(env.ZEPTOMAIL_TOKEN);
  const from = trim(env.EMAIL_FROM);

  if (!providerRaw || providerRaw === "none" || providerRaw === "disabled") {
    if (apiKey || zeptoToken || from) {
      return {
        provider: "invalid",
        variable: "EMAIL_PROVIDER",
        problem:
          "Set EMAIL_PROVIDER=resend (with RESEND_API_KEY) or EMAIL_PROVIDER=zeptomail (with ZEPTOMAIL_TOKEN), together with EMAIL_FROM, or leave all email variables empty.",
      };
    }
    return { provider: "disabled", problem: null };
  }

  if (providerRaw === "test") {
    // Every refusal below names the setting, never a value: nothing here can echo a secret.
    if (trim(env.NODE_ENV).toLowerCase() === "production")
      return {
        provider: "invalid",
        variable: "EMAIL_PROVIDER",
        problem: "The test email provider is not available in production. Use resend, zeptomail or leave email disabled.",
      };
    if (trim(env.E2E_DISPOSABLE) !== "true")
      return {
        provider: "invalid",
        variable: "EMAIL_PROVIDER",
        problem: "The test email provider is only for a disposable test instance (it needs E2E_DISPOSABLE=true).",
      };
    if (apiKey || zeptoToken)
      return {
        provider: "invalid",
        variable: "EMAIL_PROVIDER",
        problem: "The test email provider must not be combined with real provider credentials.",
      };
    const captureFile = trim(env.AUTH_EMAIL_CAPTURE_FILE);
    if (!captureFile || !ABSOLUTE_PATH_RE.test(captureFile) || /[\0\r\n]/.test(captureFile))
      return {
        provider: "invalid",
        variable: "AUTH_EMAIL_CAPTURE_FILE",
        problem: "Is required with the test email provider and must be an absolute file path.",
      };
    return { provider: "test", captureFile, problem: null };
  }

  if (providerRaw === "zeptomail") {
    if (!zeptoToken) {
      return {
        provider: "invalid",
        variable: "ZEPTOMAIL_TOKEN",
        problem: "Is required when EMAIL_PROVIDER=zeptomail (the Send Mail token of the ZeptoMail Mail Agent).",
      };
    }
    if (/[\s\0]/.test(zeptoToken)) {
      return {
        provider: "invalid",
        variable: "ZEPTOMAIL_TOKEN",
        problem: "Must be the Send Mail token only, with no spaces or line breaks.",
      };
    }
    if (!from) {
      return {
        provider: "invalid",
        variable: "EMAIL_FROM",
        problem: "Is required when EMAIL_PROVIDER=zeptomail.",
      };
    }
    if (!isValidSenderAddress(from)) {
      return {
        provider: "invalid",
        variable: "EMAIL_FROM",
        problem: "Must be a valid sender email address (for example 'Sportozen <no-reply@example.org>').",
      };
    }
    const apiUrl = trim(env.ZEPTOMAIL_API_URL) || ZEPTOMAIL_DEFAULT_API_URL;
    if (!validZeptoMailApiUrl(apiUrl)) {
      return {
        provider: "invalid",
        variable: "ZEPTOMAIL_API_URL",
        problem:
          "Must be an https URL on an api.zeptomail.* host, for example https://api.zeptomail.com/v1.1/email.",
      };
    }
    return { provider: "zeptomail", token: zeptoToken, from, apiUrl, problem: null };
  }

  if (providerRaw !== "resend") {
    return {
      provider: "invalid",
      variable: "EMAIL_PROVIDER",
      problem: "Must be 'resend', 'zeptomail' or empty.",
    };
  }

  if (!apiKey) {
    return {
      provider: "invalid",
      variable: "RESEND_API_KEY",
      problem: "Is required when EMAIL_PROVIDER=resend.",
    };
  }

  if (!from) {
    return {
      provider: "invalid",
      variable: "EMAIL_FROM",
      problem: "Is required when EMAIL_PROVIDER=resend.",
    };
  }

  if (!isValidSenderAddress(from)) {
    return {
      provider: "invalid",
      variable: "EMAIL_FROM",
      problem: "Must be a valid sender email address (for example 'Sportozen <no-reply@example.org>').",
    };
  }

  return { provider: "resend", apiKey, from, problem: null };
}
