import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export class OutboxSealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboxSealError";
  }
}

export type VerificationSecretPurpose = "email-otp" | "reset-token";

export type OutboxEmailPayload = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  tags?: Record<string, string>;
};

const PURPOSE_INFO: Record<VerificationSecretPurpose, string> = {
  "email-otp": "sportozen-email-otp-v1",
  "reset-token": "sportozen-reset-token-v1",
};

const OUTBOX_CIPHER_INFO = "sportozen-auth-email-outbox-v1";
const RECIPIENT_HASH_INFO = "sportozen-email-recipient-v1";
const OUTBOX_AAD = Buffer.from(OUTBOX_CIPHER_INFO, "utf8");
const HMAC_PREFIX = "hmac-sha256:v1:";
const SEAL_PREFIX = "v1:";

function requireAuthSecret(authSecret: string | undefined): string {
  if (!authSecret || authSecret.length < 32) {
    throw new OutboxSealError(
      "BETTER_AUTH_SECRET must be set (at least 32 characters) before hashing or sealing email payloads.",
    );
  }
  return authSecret;
}

function deriveSubkey(authSecret: string | undefined, info: string): Buffer {
  const secret = requireAuthSecret(authSecret);
  return Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(secret, "utf8"),
      Buffer.alloc(0),
      Buffer.from(info, "utf8"),
      32,
    ),
  );
}

/**
 * Keyed HMAC-SHA256 construction for six-digit OTPs and password-reset tokens using an
 * HKDF-derived subkey from BETTER_AUTH_SECRET, bound to purpose and caller context.
 * Plain unsalted or unkeyed SHA-256 is intentionally never used.
 */
export function hashVerificationSecret(
  purpose: VerificationSecretPurpose,
  value: string,
  bindingContext: string,
  authSecret: string | undefined = process.env.BETTER_AUTH_SECRET,
): string {
  if (!value) {
    throw new OutboxSealError("Verification secret value must not be empty.");
  }
  if (!bindingContext) {
    throw new OutboxSealError("Verification secret bindingContext must not be empty.");
  }
  const key = deriveSubkey(authSecret, PURPOSE_INFO[purpose]);
  const digest = createHmac("sha256", key)
    .update(`${bindingContext}\0${value}`, "utf8")
    .digest("hex");
  return `${HMAC_PREFIX}${digest}`;
}

/**
 * Constant-time comparison against a stored HMAC-SHA256 verification hash.
 */
export function verifyVerificationSecret(
  expectedHash: string,
  purpose: VerificationSecretPurpose,
  candidateValue: string,
  bindingContext: string,
  authSecret: string | undefined = process.env.BETTER_AUTH_SECRET,
): boolean {
  const key = deriveSubkey(authSecret, PURPOSE_INFO[purpose]);
  if (!candidateValue || !bindingContext || !expectedHash.startsWith(HMAC_PREFIX)) {
    return false;
  }
  const expectedHex = expectedHash.slice(HMAC_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) {
    return false;
  }
  const candidateDigest = createHmac("sha256", key)
    .update(`${bindingContext}\0${candidateValue}`, "utf8")
    .digest();
  const expectedDigest = Buffer.from(expectedHex, "hex");
  return (
    candidateDigest.length === expectedDigest.length &&
    timingSafeEqual(candidateDigest, expectedDigest)
  );
}

/**
 * Keyed HMAC hash of a normalized recipient email address so the outbox contains no plaintext PII.
 */
export function hashEmailRecipient(
  email: string,
  authSecret: string | undefined = process.env.BETTER_AUTH_SECRET,
): string {
  const normalized = email.trim().toLowerCase();
  if (!normalized) {
    throw new OutboxSealError("Recipient email must not be empty.");
  }
  const key = deriveSubkey(authSecret, RECIPIENT_HASH_INFO);
  return createHmac("sha256", key).update(normalized, "utf8").digest("hex");
}

/**
 * Encrypts the transactional email payload (including OTP/reset URL) with AES-256-GCM
 * under an HKDF subkey derived from BETTER_AUTH_SECRET so plaintext secrets are never stored in DB.
 */
export function sealEmailPayload(
  payload: OutboxEmailPayload,
  authSecret: string | undefined = process.env.BETTER_AUTH_SECRET,
): string {
  const key = deriveSubkey(authSecret, OUTBOX_CIPHER_INFO);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(OUTBOX_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${SEAL_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

/**
 * Decrypts and validates a sealed outbox payload created by `sealEmailPayload`.
 */
export function unsealEmailPayload(
  sealed: string,
  authSecret: string | undefined = process.env.BETTER_AUTH_SECRET,
): OutboxEmailPayload {
  const key = deriveSubkey(authSecret, OUTBOX_CIPHER_INFO);
  if (!sealed.startsWith(SEAL_PREFIX)) {
    throw new OutboxSealError("Unsupported sealed email payload version.");
  }
  const parts = sealed.slice(SEAL_PREFIX.length).split(".");
  if (parts.length !== 3) {
    throw new OutboxSealError("Malformed sealed email payload.");
  }
  try {
    const iv = Buffer.from(parts[0], "base64url");
    const tag = Buffer.from(parts[1], "base64url");
    const ciphertext = Buffer.from(parts[2], "base64url");
    if (iv.length !== 12 || tag.length !== 16) {
      throw new OutboxSealError("Invalid sealed payload envelope lengths.");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(OUTBOX_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as Partial<OutboxEmailPayload>;
    if (
      typeof parsed?.to !== "string" ||
      typeof parsed?.subject !== "string" ||
      typeof parsed?.text !== "string"
    ) {
      throw new OutboxSealError("Decrypted email payload is missing required fields.");
    }
    return {
      to: parsed.to,
      subject: parsed.subject,
      text: parsed.text,
      ...(typeof parsed.html === "string" ? { html: parsed.html } : {}),
      ...(parsed.tags && typeof parsed.tags === "object" ? { tags: parsed.tags } : {}),
    };
  } catch (err) {
    if (err instanceof OutboxSealError) throw err;
    throw new OutboxSealError("Unable to decrypt sealed email payload.");
  }
}
