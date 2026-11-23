import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  EmailSendResult,
  TransactionalEmailKind,
  TransactionalEmailMessage,
  TransactionalEmailProvider,
} from "./provider";

/**
 * The authentication-email provider for AUTOMATED BROWSER TESTS. It sends nothing to anyone: each message is appended, as one
 * JSON line, to the capture file the test instance was started with, so a test can read the verification code or the
 * password-reset link a real person would have received, and nothing else can.
 *
 *   - Only outside production, only on an instance that declared itself disposable (E2E_DISPOSABLE=true) and only with an
 *     explicit capture file (AUTH_EMAIL_CAPTURE_FILE). `emailProviderConfig` refuses every other combination, and this class
 *     refuses again by itself, so constructing it in production is an error however it is reached.
 *   - It never writes a message, an address or a code to the console or to any log: the capture file is the only place they go.
 *   - It is deterministic: it accepts every message, and the provider message id is a hash of the idempotency key.
 *
 * The capture file holds live codes and links. Keep it in the test instance's own temporary folder and delete it afterwards.
 */
export type CapturedEmail = {
  at: string;
  kind: TransactionalEmailKind;
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  providerMessageId: string;
};

export class TestAuthEmailProvider implements TransactionalEmailProvider {
  readonly name = "test";
  private readonly file: string;

  constructor(options: { captureFile: string; env?: Readonly<Record<string, string | undefined>> }) {
    const env = options.env ?? process.env;
    if (env.NODE_ENV === "production" || process.env.NODE_ENV === "production")
      throw new Error("The test email provider is not available in production.");
    if (env.E2E_DISPOSABLE !== "true")
      throw new Error("The test email provider is only for a disposable test instance (E2E_DISPOSABLE=true).");
    if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(options.captureFile))
      throw new Error("The test email provider needs an absolute capture file path.");
    this.file = options.captureFile;
    mkdirSync(dirname(this.file), { recursive: true });
  }

  async send(message: TransactionalEmailMessage): Promise<EmailSendResult> {
    const entry: CapturedEmail = {
      at: new Date().toISOString(),
      kind: message.kind,
      to: message.to,
      subject: message.subject,
      text: message.text,
      idempotencyKey: message.idempotencyKey,
      providerMessageId: `test-${createHash("sha256").update(message.idempotencyKey).digest("hex").slice(0, 16)}`,
    };
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    return { ok: true, providerMessageId: entry.providerMessageId };
  }
}
